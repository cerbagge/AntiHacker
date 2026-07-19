const config = require('../config');
const linkScanner = require('../services/linkScanner');
const fileScanner = require('../services/fileScanner');
const optoutStore = require('../services/optoutStore');
const { handleResponse } = require('../services/responseHandler');
const scamImageScanner = require('../services/scamImageScanner');
const scamResponder = require('../services/scamResponder');
const inviteScanner = require('../services/inviteScanner');
const virusScanner = require('../services/virusScanner');
const guildConfigStore = require('../services/guildConfigStore');
const imageQueue = require('../services/imageQueue');
const logger = require('../utils/logger');

// antihacker+는 완전 로컬: 모든 위협은 S(스팸/사기) 카테고리로 본다 (Gemini 미사용)
const SCAM_BREAKDOWN = { A: 0, V: 0, H: 0, P: 0, S: 100 };

module.exports = (client) => {
  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // ── 허니팟(스팸 함정) 채널 ──
    // `/spamchannel` 로 지정한 채널에 올라온 메시지는 도배 매크로/스팸봇으로 보고 즉시 처리.
    // 일반 유저는 이 채널에 글을 쓰지 않으므로(안내), 글이 올라오면 스팸일 확률이 매우 높다.
    if (message.guild) {
      const trapId = guildConfigStore.getSpamChannel(message.guild.id);
      if (trapId && message.channel.id === trapId) {
        await scamResponder.handleHoneypot(message);
        return;
      }
    }

    // 학습거부 유저는 수집하지 않음
    if (optoutStore.isOptedOut(message.author.id)) return;

    try {
      // 일반 첨부파일 + 전달(forward) 메시지의 첨부파일을 합침
      const allAttachments = [...message.attachments.values()];
      let allContent = message.content || '';

      if (message.messageSnapshots?.size > 0) {
        for (const snapshot of message.messageSnapshots.values()) {
          if (snapshot.attachments?.size > 0) allAttachments.push(...snapshot.attachments.values());
          if (snapshot.content) allContent += '\n' + snapshot.content;
        }
      }

      const hasAttachments = allAttachments.length > 0;
      const hasUrls = linkScanner.extractUrls(allContent).length > 0;
      const hasText = allContent.trim().length > 0;
      if (!hasAttachments && !hasUrls && !hasText) return;

      // 이 서버의 로그 언어 (기본 en) — 감지 사유를 해당 언어로 생성
      const lang = guildConfigStore.getLanguage(message.guild?.id);

      // ── [안정장치] 이미지 처리 동시성 상한 + 대기열 ──
      // 다운로드 전에 슬롯을 잡아, 대기 메시지는 버퍼를 안 들게 한다(메모리=동시처리 수로 고정).
      // 대기열까지 가득 차면 과부하로 보고 검사를 건너뛴다(fail-open).
      let scamSuspicious = null;
      let slot = false;
      if (allAttachments.length > 0) {
        slot = await imageQueue.acquire();
        if (!slot) {
          logger.warn('이미지 처리 과부하 — 검사 스킵(대기열 가득)', imageQueue.stats());
          return;
        }
      }
      try {
        // ── 첨부 바이러스 검사 (ClamAV 로컬 데몬, 최우선·저비용 ~10ms) ──
        // 모든 첨부를 먼저 검사 → 감염 시 즉시 삭제(악성코드가 스캠보다 우선).
        // 받은 버퍼는 아래 스캠 가드와 공유해 중복 다운로드를 막는다. ClamAV 없으면 통째로 스킵.
        const attachmentBuffers = new Map(); // url -> buffer
        if (config.VIRUS_SCAN_ENABLED && message.guild && allAttachments.length > 0
            && (await virusScanner.isAvailable())) {
          for (const att of allAttachments) {
            const buffer = await scamImageScanner.downloadAttachment(att.url);
            if (!buffer) continue;
            attachmentBuffers.set(att.url, buffer);
            const scan = await virusScanner.scanBuffer(buffer, att.name);
            if (!scan.clean) {
              await scamResponder.handleVirusDelete(message, att, scan);
              return; // 악성코드 감지 → 삭제 + 알림 완료, 종료
            }
          }
        }

        // ── 로컬 코인 스캠 이미지 감지 (완전 로컬) ──
        // 마스터 스위치 ON + 길드 메시지일 때만. 고신뢰 → 즉시 삭제. 임계값 미만 의심 → 알림만.
        if (config.SCAM_IMAGE_GUARD_ENABLED && message.guild) {
          const scamImages = allAttachments.filter(
            (a) => a.contentType && a.contentType.startsWith('image/')
          );
          if (scamImages.length > 0) {
            const scamResult = await scamImageScanner.scanMessageImages(scamImages, allContent, attachmentBuffers, lang);
            if (scamResult.autoDelete) {
              await scamResponder.handleScamDelete(message, scamResult);
              return; // 삭제 + 로그 완료 → 종료
            }
            if (scamResult.suspicious && scamResult.trigger) {
              scamSuspicious = scamResult.trigger;
              logger.info('코인 스캠 의심(자동삭제 임계값 미만) → 관리자 알림 대상', {
                author: message.author.tag,
                danger: scamSuspicious.dangerPercent,
              });
            }
          }
        }
      } finally {
        if (slot) imageQueue.release();
      }

      // ── 디스코드 초대 가드 ──
      // 메시지의 디스코드 링크(초대/채널)를 검사 — 링크 자체로는 차단하지 않고 언제나 대상 서버로 판단.
      // ① 초대 링크는 멘션/문구와 무관하게 대상 서버를 해석해 19+(성인)/스팸일 때만,
      // ② 채널 딥링크는 서버ID로 대상 길드를 해석(봇 공동 가입 서버만)해 성인/스팸일 때만 삭제.
      //    DM 딥링크(@me)·미가입 외부 서버는 해석 불가라 통과. (링크가 없으면 비용 0으로 통과)
      if (config.INVITE_GUARD_ENABLED && message.guild) {
        const inviteVerdict = await inviteScanner.scanMessageInvites(message.client, allContent, message.guild.id, lang);
        if (inviteVerdict) {
          await scamResponder.handleNsfwInviteDelete(message, inviteVerdict);
          return; // 삭제 + 로그 완료 → 종료
        }
      }

      // ── 로컬 위협 검사 (Gemini 미사용): 링크 피싱 패턴 + 파일 확장자 스캐너 ──
      const collectedLinks = [];
      const collectedFiles = [];

      // 링크: 로컬 피싱 패턴만 (안전 도메인 스킵). 패턴에 안 걸리면 그냥 통과.
      for (const url of linkScanner.extractUrls(allContent)) {
        if (linkScanner.isSafeDomain(url)) continue;
        const localResult = linkScanner.checkLocalPatterns(url, lang);
        if (localResult) {
          collectedLinks.push({
            url,
            dangerPercent: localResult.dangerPercent,
            breakdown: { ...SCAM_BREAKDOWN },
            categories: ['S2'],
            reason: localResult.reason,
            confidence: 0.9,
          });
        }
      }

      // 파일: 로컬 확장자/이름 스캐너 (위협 판정된 것만). 파일 내용 검사는 위 ClamAV 단계가 담당.
      const fileAttachments = allAttachments.filter(
        (a) => !a.contentType || !a.contentType.startsWith('image/')
      );
      for (const file of fileAttachments) {
        const [scanResult] = fileScanner.scanFiles([file], lang);
        if (!scanResult) continue;
        collectedFiles.push({
          originalName: file.name,
          mimeType: file.contentType || 'application/octet-stream',
          dangerPercent: scanResult.confidence >= 0.95 ? 75 : 50,
          breakdown: { ...SCAM_BREAKDOWN },
          categories: ['S3'],
          reason: scanResult.reason,
        });
      }

      // 위협(스캠 의심/악성 링크/악성 파일)이 하나도 없으면 종료
      if (!scamSuspicious && collectedLinks.length === 0 && collectedFiles.length === 0) return;

      // 알림용 이미지 항목 (스캠 의심 1건) — responseHandler 포맷에 맞춰 top-level dangerPercent/reason
      const scamImagesForAlert = scamSuspicious
        ? [{
            originalName: scamSuspicious.attachmentName || 'image',
            mimeType: 'image/*',
            buffer: scamSuspicious.buffer,
            dangerPercent: scamSuspicious.dangerPercent,
            breakdown: { ...SCAM_BREAKDOWN },
            categories: ['S2'],
            reason: scamSuspicious.reason,
          }]
        : [];

      const allItems = [
        ...scamImagesForAlert.map((i) => ({ d: i.dangerPercent, b: i.breakdown })),
        ...collectedLinks.map((l) => ({ d: l.dangerPercent, b: l.breakdown })),
        ...collectedFiles.map((f) => ({ d: f.dangerPercent, b: f.breakdown })),
      ];
      const overallDangerPercent = allItems.reduce((m, it) => Math.max(m, it.d), 0);
      const topItem = allItems.reduce((max, it) => (it.d > max.d ? it : max), { d: -1, b: { ...SCAM_BREAKDOWN } });
      const overallBreakdown = topItem.b || { A: 0, V: 0, H: 0, P: 0, S: 0 };

      const analysisDetails = {
        images: scamImagesForAlert,
        links: collectedLinks,
        files: collectedFiles,
        text: null,
      };
      await handleResponse(message, overallDangerPercent, overallBreakdown, analysisDetails);

      logger.info(`로컬 검사 완료: ${message.author.tag} | 위험도: ${overallDangerPercent}%`, {
        scamSuspicious: !!scamSuspicious,
        links: collectedLinks.length,
        files: collectedFiles.length,
      });
    } catch (error) {
      logger.error('메시지 처리 중 오류', {
        error: error.message,
        guild: message.guild?.name,
        author: message.author?.tag,
      });
    }
  });
};
