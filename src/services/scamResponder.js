/**
 * 스캠/바이러스/허니팟 대응 — 메시지 삭제 + 서버 로그 채널 출력.
 * 모든 알림 문구는 그 서버의 언어(/language)로 출력한다.
 *  - en/ko : 손으로 쓴 언어팩 (즉시)
 *  - 그 외 : 영어 베이스를 Google 번역(MT, 캐시). 번역 불가 시 영어 폴백.
 */
const { EmbedBuilder, AttachmentBuilder, RESTJSONErrorCodes } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const alertStore = require('./alertStore');
const guildLogger = require('./guildLogger');
const guildConfigStore = require('./guildConfigStore');
const spamSweeper = require('./spamSweeper');
const sanctionService = require('./sanctionService');
const { humanizeDuration } = require('../utils/duration');
const { tl } = require('./i18n');

const ZWSP = '​'; // 빈 필드명용 제로폭 공백

/**
 * 메시지 삭제 시도 — 실패 원인을 코드로 구분한다.
 * message.delete() 실패를 무조건 "메시지 관리 권한 부족"으로 단정하지 않기 위함.
 * 서버 역할에는 권한이 있어도 아래 이유로 실패할 수 있다:
 *   - already-gone(10008): 이미 삭제됨 → 목적 달성(경고 불필요, deleted=true 로 취급)
 *   - missing-perms(50013): 이 채널에서 "메시지 관리" 없음 — 대개 채널/카테고리 권한 재정의(overwrite)
 *                            또는 봇 자신이 타임아웃된 상태
 *   - missing-access(50001): 채널 접근 불가(채널 보기 없음 등)
 *   - error: 그 외(일시 오류/레이트리밋 등)
 * @returns {Promise<{deleted:boolean, cause:'ok'|'already-gone'|'missing-perms'|'missing-access'|'error', error?:string}>}
 */
async function tryDeleteMessage(message) {
  try {
    await message.delete();
    return { deleted: true, cause: 'ok' };
  } catch (e) {
    switch (e?.code) {
      case RESTJSONErrorCodes.UnknownMessage:
        return { deleted: true, cause: 'already-gone' };
      case RESTJSONErrorCodes.MissingPermissions:
        return { deleted: false, cause: 'missing-perms', error: e.message };
      case RESTJSONErrorCodes.MissingAccess:
        return { deleted: false, cause: 'missing-access', error: e.message };
      default:
        return { deleted: false, cause: 'error', error: e.message };
    }
  }
}

// 삭제 실패 원인 → 로그 채널에 붙일 안내 문구 키 (성공/이미삭제는 안내 없음)
const DELETE_FAILURE_NOTICE_KEY = {
  'missing-perms': 'notice.noPermChannel',
  'missing-access': 'notice.noAccess',
  error: 'notice.deleteFailed',
};

/** 삭제 실패 시 원인에 맞는 경고(굵게)를 하단에 추가. 성공/이미삭제면 아무것도 안 함. */
async function addDeleteFailureNotice(embed, del, lang) {
  const key = DELETE_FAILURE_NOTICE_KEY[del.cause];
  if (key) embed.addFields({ name: ZWSP, value: `**${await tl(lang, key)}**` });
  return embed;
}

/** 삭제 실패 원인을 정확히 로그 — 무조건 "권한 확인"으로 찍지 않는다(진짜 원인은 cause/error 에). */
function logDeleteFailure(label, del, message) {
  logger.error(`${label} 삭제 실패 [${del.cause}]`, {
    error: del.error,
    guild: message.guild?.name,
    channel: message.channel?.id,
  });
}

/**
 * `/spamsanction` 설정에 따라 작성자를 제재하고 결과를 임베드 필드로 남긴다.
 * type=none/미설정이면 아무 필드도 추가하지 않는다.
 */
async function addSanctionField(embed, message, lang) {
  const result = await sanctionService.applySanction(message);
  if (!result) return embed;

  let value;
  if (result.ok) {
    if (result.type === 'timeout') {
      const key = result.renewed ? 'sanction.timeoutRenew' : 'sanction.timeout';
      value = await tl(lang, key, { dur: humanizeDuration(result.durationMs) });
    } else if (result.type === 'ban' && result.durationMs > 0) {
      value = await tl(lang, 'sanction.banTemp', { dur: humanizeDuration(result.durationMs) });
    } else {
      value = await tl(lang, `sanction.${result.type}`);
    }
  } else {
    const key =
      result.skipped === 'gone'
        ? 'sanction.failGone'
        : result.skipped === 'perm'
          ? 'sanction.failPerm'
          : 'sanction.failErr';
    value = await tl(lang, key, { action: result.type });
  }
  embed.addFields({ name: await tl(lang, 'field.sanction'), value });
  return embed;
}

async function buildScamEmbed(message, trigger, del, lang) {
  const embed = new EmbedBuilder()
    .setTitle(await tl(lang, 'title.scam'))
    .setColor(del.deleted ? 0xed4245 : 0xfee75c)
    .setThumbnail(message.author.displayAvatarURL())
    .addFields(
      { name: await tl(lang, 'field.author'), value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
      { name: await tl(lang, 'field.channel'), value: `<#${message.channel.id}>`, inline: true },
    )
    .setTimestamp();
  // 근거(trigger.reason)는 노출하지 않고 기록용으로만 — logger.warn + alertStore 에 남는다.
  return addDeleteFailureNotice(embed, del, lang);
}

/**
 * 고신뢰 코인 스캠 이미지 → 삭제 + 서버 로그 채널.
 * @returns {Promise<number>} alert id
 */
async function handleScamDelete(message, scanResult) {
  const trigger = scanResult.trigger;
  const lang = guildConfigStore.getLanguage(message.guild?.id);

  const del = await tryDeleteMessage(message);
  if (!del.deleted) logDeleteFailure('스캠 메시지', del, message);

  const alert = alertStore.createAlert({
    guildId: message.guild?.id,
    channelId: message.channel.id,
    messageId: message.id,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content || '',
    dangerPercent: trigger.dangerPercent,
    breakdown: { A: 0, V: 0, H: 0, P: 0, S: 100 },
    analysisDetails: { scam: trigger },
  });

  logger.warn(`코인 스캠 이미지 ${del.deleted ? '삭제' : '감지(삭제실패)'} #${alert.id}`, {
    author: message.author.tag,
    danger: trigger.dangerPercent,
    signals: trigger.signals,
    reason: trigger.reason,
    source: trigger.source,
  });

  const embed = await buildScamEmbed(message, trigger, del, lang);
  await addSanctionField(embed, message, lang);
  // 첨부는 전송할 때마다 새로 생성(스트림 재사용 문제 방지)
  const makeFiles = () =>
    trigger.buffer ? [new AttachmentBuilder(trigger.buffer, { name: `scam_${trigger.attachmentName || 'image'}` })] : [];

  await guildLogger.logToGuild(message.client, message.guild?.id, { embeds: [embed], files: makeFiles() });

  return alert.id;
}

/**
 * 바이러스 첨부 → 삭제 + 서버 로그 채널. 감염 파일은 재업로드하지 않는다.
 * @returns {Promise<number>} alert id
 */
async function handleVirusDelete(message, attachment, scan) {
  const lang = guildConfigStore.getLanguage(message.guild?.id);

  const del = await tryDeleteMessage(message);
  if (!del.deleted) logDeleteFailure('바이러스 메시지', del, message);

  const alert = alertStore.createAlert({
    guildId: message.guild?.id,
    channelId: message.channel.id,
    messageId: message.id,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content || '',
    dangerPercent: 100,
    breakdown: { A: 0, V: 0, H: 0, P: 0, S: 100 },
    analysisDetails: { virus: { file: attachment.name, signatures: scan.signatures || [] } },
  });

  logger.warn(`바이러스 첨부 ${del.deleted ? '삭제' : '감지(삭제실패)'} #${alert.id}`, {
    author: message.author.tag,
    file: attachment.name,
    signatures: scan.signatures,
  });

  const embed = new EmbedBuilder()
    .setTitle(await tl(lang, 'title.virus'))
    .setColor(0xed4245)
    .setThumbnail(message.author.displayAvatarURL())
    .addFields(
      { name: await tl(lang, 'field.author'), value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
      { name: await tl(lang, 'field.channel'), value: `<#${message.channel.id}>`, inline: true },
      { name: await tl(lang, 'field.file'), value: (attachment.name || '-').slice(0, 256), inline: true },
    )
    .setTimestamp();
  await addDeleteFailureNotice(embed, del, lang);
  await addSanctionField(embed, message, lang);

  await guildLogger.logToGuild(message.client, message.guild?.id, { embeds: [embed] });

  return alert.id;
}

/**
 * 허니팟(스팸 함정) 채널 적발 → 삭제 + 서버 로그 채널.
 * @returns {Promise<number>} alert id
 */
async function handleHoneypot(message) {
  const lang = guildConfigStore.getLanguage(message.guild?.id);

  const del = await tryDeleteMessage(message);
  if (!del.deleted) logDeleteFailure('허니팟 메시지', del, message);

  const alert = alertStore.createAlert({
    guildId: message.guild?.id,
    channelId: message.channel.id,
    messageId: message.id,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content || '',
    dangerPercent: 100,
    breakdown: { A: 0, V: 0, H: 0, P: 0, S: 100 },
    analysisDetails: { honeypot: true },
  });

  logger.warn(`허니팟 적발 ${del.deleted ? '삭제' : '감지(삭제실패)'} #${alert.id}`, {
    author: message.author.tag,
    channel: message.channel.id,
  });

  // ── 연관 스팸 스윕 ──
  // 허니팟에 걸린 유저는 도배봇으로 본다 → 같은 유저가 비슷한 시간대/내용으로
  // 다른 채널에 뿌린 메시지까지 서버 전역에서 함께 삭제. (실패해도 본 처리에는 영향 없음)
  let sweep = null;
  if (config.SPAM_SWEEP_ENABLED && message.guild) {
    try {
      sweep = await spamSweeper.sweepRelatedMessages(message, {
        windowMs: config.SPAM_SWEEP_WINDOW_MS,
        similarity: config.SPAM_SWEEP_SIMILARITY,
      });
      if (sweep.deleted > 0) {
        logger.warn(`연관 스팸 스윕 ${sweep.deleted}건 삭제 #${alert.id}`, {
          author: message.author.tag,
          byTime: sweep.byTime,
          byContent: sweep.byContent,
          channels: sweep.channels,
        });
      }
    } catch (e) {
      logger.warn('연관 스팸 스윕 실패', { error: e.message, guild: message.guild?.name });
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(await tl(lang, 'title.honeypot'))
    .setColor(0xed4245)
    .setThumbnail(message.author.displayAvatarURL())
    .addFields(
      { name: await tl(lang, 'field.author'), value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
      { name: await tl(lang, 'field.channel'), value: `<#${message.channel.id}>`, inline: true },
      { name: await tl(lang, 'field.content'), value: (message.content || (await tl(lang, 'content.none'))).slice(0, 1024) },
    )
    .setTimestamp();
  if (sweep && sweep.deleted > 0) {
    embed.addFields({
      name: await tl(lang, 'field.swept'),
      value: await tl(lang, 'sweep.summary', { total: sweep.deleted, time: sweep.byTime, content: sweep.byContent, channels: sweep.channels }),
    });
  }
  await addDeleteFailureNotice(embed, del, lang);
  await addSanctionField(embed, message, lang);

  await guildLogger.logToGuild(message.client, message.guild?.id, { embeds: [embed] });

  return alert.id;
}

/**
 * NSFW/스팸 디스코드 서버 초대 → 삭제 + 서버 로그 채널.
 * @param {import('discord.js').Message} message
 * @param {{guildName:string, kind:string, source:string, reason:string, confidence:number}} verdict
 * @returns {Promise<number>} alert id
 */
async function handleNsfwInviteDelete(message, verdict) {
  const lang = guildConfigStore.getLanguage(message.guild?.id);

  // advisory: AI 단독 판정 — 오탐 위험이 커서 삭제·제재 없이 로그 알림만 남긴다.
  const advisory = !!verdict.advisory;

  let del = { deleted: false, cause: 'skipped' }; // advisory 는 삭제를 시도하지 않음(실패 안내도 없음)
  if (!advisory) {
    del = await tryDeleteMessage(message);
    if (!del.deleted) logDeleteFailure('NSFW 초대 메시지', del, message);
  }

  const alert = alertStore.createAlert({
    guildId: message.guild?.id,
    channelId: message.channel.id,
    messageId: message.id,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content || '',
    dangerPercent: 100,
    breakdown: { A: 0, V: 0, H: 0, P: 0, S: 100 },
    analysisDetails: { invite: { server: verdict.guildName, kind: verdict.kind, source: verdict.source } },
  });

  logger.warn(`NSFW/스팸 서버 초대 ${advisory ? 'AI 의심(알림만)' : del.deleted ? '삭제' : '감지(삭제실패)'} #${alert.id}`, {
    author: message.author.tag,
    server: verdict.guildName,
    kind: verdict.kind,
    source: verdict.source,
    confidence: verdict.confidence,
    reason: verdict.reason,
  });

  const isChannelLink = verdict.linkKind === 'channel' || verdict.linkKind === 'dm';
  const embed = new EmbedBuilder()
    .setTitle(await tl(lang, isChannelLink ? 'title.channelLink' : 'title.invite'))
    .setColor(advisory ? 0xfee75c : 0xed4245)
    .setThumbnail(message.author.displayAvatarURL())
    .addFields(
      { name: await tl(lang, 'field.author'), value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
      { name: await tl(lang, 'field.channel'), value: `<#${message.channel.id}>`, inline: true },
      { name: await tl(lang, 'field.server'), value: (verdict.guildName || '-').slice(0, 256), inline: true },
    )
    .setTimestamp();
  if (advisory) {
    embed.setDescription(`AI 단독 판정이라 **삭제하지 않았습니다** — 확인 후 수동 조치하세요.\n${(verdict.reason || '').slice(0, 300)}`);
  } else {
    await addDeleteFailureNotice(embed, del, lang);
    await addSanctionField(embed, message, lang);
  }

  await guildLogger.logToGuild(message.client, message.guild?.id, { embeds: [embed] });

  return alert.id;
}

module.exports = {
  handleScamDelete, handleVirusDelete, handleHoneypot, handleNsfwInviteDelete,
  // 단위 테스트/재사용용
  tryDeleteMessage, addDeleteFailureNotice,
};
