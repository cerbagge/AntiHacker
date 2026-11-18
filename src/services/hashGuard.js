/**
 * 해시 즉시삭제 — 한 번 지운 스팸과 "똑같은" 메시지는 대기열·바이러스 검사·OCR/AI 를 거치지 않고 바로 지운다.
 *  - 글: 삭제된 메시지 글 내용의 SHA-256 과 일치
 *  - 이미지: 삭제된 이미지의 256bit dHash 와 근접 (scamHashStore)
 * 학습(learnDeleted)은 봇이 스팸/스캠으로 삭제 처리한 메시지에서만 한다.
 */
const config = require('../config');
const logger = require('../utils/logger');
const scamHashStore = require('./scamHashStore');
const scamImageScanner = require('./scamImageScanner');
const pdfRenderer = require('./pdfRenderer');
const { t } = require('./i18n');

// 이미지 즉시검사를 동시에 돌리는 메시지 수 상한. 넘치면 건너뛰고 기존 대기열 검사(해시 검사 포함)에 맡긴다.
const MAX_IMAGE_CHECKS = 4;
let imageChecks = 0;

// 해시 대상 이미지 (PDF 는 페이지 렌더링이 무거워 대기열 검사에 맡긴다)
function hashableImages(attachments) {
  return attachments.filter((a) => scamImageScanner.isImageAttachment(a) && !pdfRenderer.isPdfAttachment(a));
}

function trigger(lang, kind, extra = {}) {
  return {
    dangerPercent: 100,
    confidence: 1,
    reason: t(lang, kind === 'text' ? 'reason.knownText' : 'reason.knownHash'),
    signals: [kind === 'text' ? 'known-text' : 'known-hash'],
    source: kind === 'text' ? 'text-hash' : 'phash',
    ...extra,
  };
}

/**
 * 삭제된 적 있는 글/이미지와 같은지 즉시 확인.
 * @returns {Promise<null | {autoDelete:true, suspicious:true, trigger:object}>} handleScamDelete 에 그대로 넘길 결과
 */
async function checkKnown(text, attachments, lang) {
  if (scamHashStore.matchKnownText(text)) {
    return { autoDelete: true, suspicious: true, trigger: trigger(lang, 'text') };
  }

  if (!config.SCAM_IMAGE_GUARD_ENABLED || scamHashStore.count() === 0) return null;
  const images = hashableImages(attachments);
  if (images.length === 0 || imageChecks >= MAX_IMAGE_CHECKS) return null;

  imageChecks++;
  try {
    for (const att of images) {
      const buffer = await scamImageScanner.downloadAttachment(att.url);
      if (!buffer) continue;
      const hash = await scamImageScanner.hashImage(buffer);
      if (hash && scamHashStore.matchKnownScam(hash)) {
        return {
          autoDelete: true,
          suspicious: true,
          trigger: trigger(lang, 'image', { attachmentName: att.name, attachmentUrl: att.url, buffer, phash: hash }),
        };
      }
    }
  } finally {
    imageChecks--;
  }
  return null;
}

/**
 * 삭제 처리한 메시지의 글·이미지를 해시로 학습. 삭제 흐름을 늦추지 않도록 호출부는 await 하지 않는다.
 * @param {string} text 메시지 글(전달 메시지 원문 포함)
 * @param {Array} attachments 이미지 해시까지 학습할 첨부 (이미 학습된 경우 빈 배열)
 * @param {Map<string, Buffer>} [prefetched] url -> 이미 받은 버퍼
 */
async function learnDeleted(text, attachments = [], prefetched) {
  try {
    scamHashStore.addScamText(text);
    for (const att of hashableImages(attachments)) {
      const buffer = (prefetched && prefetched.get(att.url)) || (await scamImageScanner.downloadAttachment(att.url));
      if (!buffer) continue;
      const hash = await scamImageScanner.hashImage(buffer);
      if (hash) scamHashStore.addScamHash(hash);
    }
  } catch (e) {
    logger.warn('삭제 메시지 해시 학습 실패', { error: e.message });
  }
}

/**
 * 해시 대상 이미지를 미리 받아 둔다(메시지를 지우면 첨부가 곧 내려가므로 삭제 전에 시작).
 * @returns {Promise<Map<string, Buffer>>} url -> buffer (실패한 건 빠짐)
 */
async function prefetch(attachments = []) {
  const images = hashableImages(attachments);
  const buffers = await Promise.all(images.map((att) => scamImageScanner.downloadAttachment(att.url)));
  // 다운로드가 끝난 순서가 아니라 첨부 순서대로 담는다 (AI에는 앞쪽 이미지부터 보낸다)
  const map = new Map();
  images.forEach((att, i) => { if (buffers[i]) map.set(att.url, buffers[i]); });
  return map;
}

module.exports = { checkKnown, learnDeleted, prefetch, hashableImages };
