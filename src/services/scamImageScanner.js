/**
 * 로컬 우선 코인 스캠 이미지 스캐너 (AI 없이도 동작, VLM은 선택적 보강)
 *
 * 단계 (싼 것 → 비싼 것):
 *   1) pHash       — 알려진 스캠 이미지(해시 일치)면 즉시 차단
 *   2) OCR         — tesseract.js (한국어+영어) 로 이미지 속 글자 추출
 *   3) QR          — jsQR 로 QR 코드 안의 링크 해독
 *   4) 패턴 점수    — cryptoScamPatterns + linkScanner 로 신호 가중 합산
 *   5) 로컬 VLM     — 점수가 애매하거나 글자가 거의 없을 때만 Ollama 호출 (없으면 건너뜀)
 *
 * 결과의 dangerPercent / 임계값으로 자동삭제 여부를 정한다. 오삭제를 막기 위해
 * 자동삭제는 "점수 임계값 이상 + 서로 다른 신호 2종류 이상"을 모두 만족해야 한다.
 * VLM은 로컬이 이미 의심한 건을 확정으로 올릴 수만 있고, 로컬 근거 없이 단독으로
 * 삭제를 만들지 못한다 (AI 단독 판정 = 의심 → 관리자 알림만).
 */
const { createWorker } = require('tesseract.js');
const Jimp = require('jimp');
const jsQR = require('jsqr');

const config = require('../config');
const logger = require('../utils/logger');
const patterns = require('../constants/cryptoScamPatterns');
const linkScanner = require('./linkScanner');
const scamHashStore = require('./scamHashStore');
const localVlmService = require('./localVlmService');
const { t, DEFAULT_LANG } = require('./i18n');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB 초과는 스킵
const OCR_MAX_WIDTH = 1000; // OCR/QR 전 리사이즈 (속도/일관성)
const SUSPICIOUS_THRESHOLD = 45; // 이 이상이면 "의심"(관리자 알림 대상)

// 신호별 가중치 (각 종류는 한 번만 가산)
const WEIGHTS = {
  giveaway: 35,
  wallet: 40,
  url: 30,
  casino: 30,
  crypto: 15,
  celebrity: 15,
  extlink: 12,
  urgency: 10,
  money: 10,
  qr: 15,
  proof: 15,
};

// ── tesseract 워커 (지연 초기화 후 재사용) ──
let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('kor+eng').catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 256비트 dHash (그레이스케일 17x16, 가로 인접 픽셀 밝기 비교).
 * Jimp 기본 64비트 pHash는 "흰 배경+글자" 류 저정보 이미지에서 서로 다른 이미지끼리
 * 충돌(오매칭)이 잦아 자동삭제에 위험하므로, 변별력이 훨씬 높은 256비트 해시를 쓴다.
 */
function computeDHash(image) {
  const g = image.clone().greyscale().resize(17, 16);
  let bits = '';
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const l = Jimp.intToRGBA(g.getPixelColor(x, y)).r;
      const r = Jimp.intToRGBA(g.getPixelColor(x + 1, y)).r;
      bits += l > r ? '1' : '0';
    }
  }
  return bits;
}

/** {en, ko} 그룹 매칭 — ko는 부분문자열, en은 단어/구 경계. 매칭된 토큰 또는 null */
function matchGroup(textLower, group) {
  for (const ko of group.ko || []) {
    if (ko && textLower.includes(ko.toLowerCase())) return ko;
  }
  for (const en of group.en || []) {
    const e = en.toLowerCase();
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(e)}([^a-z0-9]|$)`, 'i');
    if (re.test(textLower)) return en;
  }
  return null;
}

// "보내면 두 배로 받는다" / "send and get back" 류 메커닉
const SEND_RECEIVE_EN = /\bsend\b[\s\S]{0,40}\b(receive|get|back|return|double)\b/i;
const SEND_RECEIVE_KO = /보내(면|시면|주시면)?[\s\S]{0,30}(받|돌려|두\s?배|2\s?배|배로)/;
const MULTIPLIER = /(^|[^a-z0-9])(x\s?(2|3|5|10|100)|(2|3|5|10|100)\s?x)([^a-z0-9]|$)/i;

// 가짜 "출금 성공" 인증 이미지 장르 — 출금/withdraw 문구와 성공/완료 문구 사이에
// 금액($2700.00 등)이 끼어 있어 casinoBonus의 고정 구절("withdrawal was successfully")에
// 안 걸리는 경우가 많다 → 사이 간격을 허용해 별도 포착한다.
const WITHDRAWAL_PROOF_EN = /\bwithdraw(al|n)?\b[\s\S]{0,40}\b(success|successful|successfully|completed|approved|confirmed)\b/i;
const WITHDRAWAL_PROOF_KO = /출금[\s\S]{0,30}(성공|완료|승인|처리)/;

// 금액/지급액 표기 ($2,500 · 2700 USDT 등) — 약한 신호
const MONEY = /(\$\s?\d[\d.,]*)|(\b\d[\d.,]*\s?(usdt|usdc|btc|eth|trx|usd|dollars?)\b)/i;
// OCR 텍스트엔 http:// 없는 맨 도메인(hexowin.net, hexowin149.pro 등)이 흔하다 → 따로 추출
const BARE_DOMAIN = /\b((?:[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?\.)+(?:com|net|org|io|pro|xyz|app|site|live|vip|win|club|info|biz|online|fund|gift|cash|top|cc|gg))(\/[^\s]*)?/gi;

/** {en, ko} 그룹에서 서로 다른 토큰이 몇 개 매칭되는지 */
function countGroup(textLower, group) {
  let n = 0;
  for (const ko of group.ko || []) {
    if (ko && textLower.includes(ko.toLowerCase())) n++;
  }
  for (const en of group.en || []) {
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(en.toLowerCase())}([^a-z0-9]|$)`, 'i');
    if (re.test(textLower)) n++;
  }
  return n;
}

function isExchangeDomain(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return patterns.exchangeDomains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** OCR 텍스트/QR/동봉 텍스트로부터 URL 신호 평가. hit=강신호(힌트/피싱패턴), ext=비안전 외부도메인 존재(약신호) */
function evaluateUrls(rawText, qrUrl, lang) {
  const urls = linkScanner.extractUrls(rawText);
  if (qrUrl) urls.push(qrUrl);
  const bare = (rawText.match(BARE_DOMAIN) || []).map((d) => (/^https?:/i.test(d) ? d : `http://${d}`));
  const all = [...new Set([...urls, ...bare])];

  let ext = false;
  for (const url of all) {
    if (linkScanner.isSafeDomain(url) || isExchangeDomain(url)) continue;

    const local = linkScanner.checkLocalPatterns(url, lang);
    if (local) return { hit: true, ext: true, reason: `${local.reason} (\`${url}\`)` };

    const lower = url.toLowerCase();
    for (const hint of patterns.scamUrlHints) {
      if (lower.includes(hint)) return { hit: true, ext: true, reason: t(lang, 'reason.urlScam', { hint, url: `\`${url}\`` }) };
    }
    ext = true; // 비안전 외부 도메인 존재 (약한 신호)
  }
  return { hit: false, ext, reason: null };
}

/** fetch 로 첨부 다운로드 (크기 제한). 실패 시 null */
async function downloadAttachment(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > MAX_IMAGE_BYTES) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength > MAX_IMAGE_BYTES) return null;
    return Buffer.from(ab);
  } catch (e) {
    logger.warn('스캠 스캔용 이미지 다운로드 실패', { url, error: e.message });
    return null;
  }
}

/**
 * 이미지 한 장 스캔
 * @returns {Promise<object>} { autoDelete, suspicious, dangerPercent, confidence, reason, signals, phash, ocrText, qrUrl, source }
 */
async function scanImage(buffer, mimeType, messageText, lang = DEFAULT_LANG) {
  const base = {
    autoDelete: false,
    suspicious: false,
    dangerPercent: 0,
    confidence: 0,
    reason: '',
    signals: [],
    phash: null,
    ocrText: '',
    qrUrl: null,
    source: 'local',
  };

  let image;
  try {
    image = await Jimp.read(buffer);
  } catch (e) {
    // 디코드 불가(실제 이미지 아님 등) → 스캠 아님으로 통과
    logger.warn('이미지 디코드 실패(스캠 스캔 스킵)', { error: e.message });
    return base;
  }

  // 1) 이미지 해시 — 알려진 스캠과 일치하면 즉시 차단
  let imgHash = null;
  try {
    imgHash = computeDHash(image); // 256bit dHash
  } catch { /* 무시 */ }
  base.phash = imgHash;

  const known = imgHash ? scamHashStore.matchKnownScam(imgHash) : null;
  if (known) {
    return {
      ...base,
      autoDelete: true,
      suspicious: true,
      dangerPercent: 100,
      confidence: 1,
      reason: t(lang, 'reason.knownHash'),
      signals: ['known-hash'],
      source: 'phash',
    };
  }

  // 작업용 리사이즈 클론
  const work = image.clone();
  if (work.bitmap.width > OCR_MAX_WIDTH) work.resize(OCR_MAX_WIDTH, Jimp.AUTO);

  // 2) QR 해독
  let qrUrl = null;
  try {
    const { data, width, height } = work.bitmap;
    const code = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height);
    if (code && code.data) qrUrl = code.data.trim();
  } catch { /* QR 없음/실패 무시 */ }
  base.qrUrl = qrUrl;

  // 3) OCR
  let ocrText = '';
  try {
    const png = await work.getBufferAsync(Jimp.MIME_PNG);
    const worker = await getWorker();
    const { data } = await worker.recognize(png);
    ocrText = (data && data.text) ? data.text : '';
  } catch (e) {
    logger.warn('OCR 실패', { error: e.message });
  }
  base.ocrText = ocrText;

  // 4) 패턴 점수
  const rawText = `${messageText || ''}\n${ocrText}\n${qrUrl || ''}`;
  // OCR이 줄바꿈/다중 공백으로 다단어 문구("withdrawal success", "connect wallet" 등)를
  // 끊어 읽으면 단일 공백 패턴이 안 잡힌다 → 매칭 전에 공백을 단일화 (폰 기종 무관 개선)
  const normText = rawText.replace(/\s+/g, ' ');
  const textLower = normText.toLowerCase();

  const tags = {};
  const reasons = [];

  // 정상 거래소 거래 화면(포지션/체결/손익 UI) — 여기선 "10x"·"2배"가 레버리지다.
  const trading = countGroup(textLower, patterns.tradingContext) >= 2;

  const gv = matchGroup(textLower, patterns.giveawayActions);
  if (gv) { tags.giveaway = true; reasons.push(t(lang, 'reason.giveaway', { token: gv })); }
  if (SEND_RECEIVE_EN.test(rawText) || SEND_RECEIVE_KO.test(rawText)) {
    tags.giveaway = true; reasons.push(t(lang, 'reason.sendReceive'));
  }
  if (!trading && (MULTIPLIER.test(rawText) || matchGroup(textLower, patterns.multiplierWords))) {
    tags.giveaway = true; reasons.push(t(lang, 'reason.multiplier'));
  }

  const wl = matchGroup(textLower, patterns.walletActions);
  if (wl) { tags.wallet = true; reasons.push(t(lang, 'reason.wallet', { token: wl })); }

  const ct = matchGroup(textLower, patterns.cryptoTerms);
  if (ct) { tags.crypto = true; reasons.push(t(lang, 'reason.crypto', { token: ct })); }

  const cs = matchGroup(textLower, patterns.casinoBonus);
  if (cs) { tags.casino = true; reasons.push(t(lang, 'reason.casino', { token: cs })); }
  if (WITHDRAWAL_PROOF_EN.test(rawText) || WITHDRAWAL_PROOF_KO.test(rawText)) {
    tags.proof = true; reasons.push(t(lang, 'reason.withdrawProof'));
  }

  const ce = matchGroup(textLower, patterns.celebrities);
  if (ce) { tags.celebrity = true; reasons.push(t(lang, 'reason.celebrity', { token: ce })); }

  const ug = matchGroup(textLower, patterns.urgency);
  if (ug) { tags.urgency = true; reasons.push(t(lang, 'reason.urgency', { token: ug })); }

  if (MONEY.test(rawText)) { tags.money = true; reasons.push(t(lang, 'reason.money')); }

  const urlEval = evaluateUrls(rawText, qrUrl, lang);
  if (urlEval.hit) { tags.url = true; reasons.push(urlEval.reason); }
  else if (urlEval.ext) { tags.extlink = true; reasons.push(t(lang, 'reason.extlink')); }

  if (qrUrl) { tags.qr = true; reasons.push(t(lang, 'reason.qr')); }

  // 점수 합산
  let score = 0;
  for (const tag of Object.keys(tags)) score += WEIGHTS[tag] || 0;
  score = Math.min(100, score);
  const tagCount = Object.keys(tags).length;

  const autoThreshold = config.SCAM_AUTODELETE_THRESHOLD;
  // 결정적 조합: 점수가 임계값 미만이어도 이 패턴이면 거의 100% 스캠 → 즉시 삭제
  // (사칭+카지노, 지갑탈취, 에어드랍 피싱) — 오삭제 위험 낮은 조합만 엄선
  const decisiveCombo = Boolean(
    (tags.celebrity && tags.casino)
    || (tags.wallet && (tags.crypto || tags.url))
    || (tags.giveaway && tags.wallet)
    // 가짜 출금 인증 스캠 서명 — 카지노/도박 브랜딩(vip-club, 보너스 등)이 반드시 있어야 하며
    // 여기에 암호화폐+금액 또는 "출금 성공" 문구가 겹칠 때만 결정. 정품 거래소 출금 스크린샷은
    // 도박 브랜딩이 없으므로 casino 태그가 안 붙어 오삭제되지 않는다.
    || (tags.casino && tags.crypto && tags.money)
    || (tags.casino && tags.proof)
  );
  let localAutoDelete = Boolean(
    (score >= autoThreshold && tagCount >= 2)
    || (decisiveCombo && score >= SUSPICIOUS_THRESHOLD)
  );
  // 거래 화면 화이트리스트: 스캠 행동 신호(에어드랍·지갑·스캠URL·카지노)가 없으면
  // 삭제·제재하지 않고 최대 의심(관리자 알림)까지만. Tesla 같은 종목명은 celebrity로 잡혀도 무시.
  const tradingWhitelisted = trading && !(tags.giveaway || tags.wallet || tags.url || tags.casino);
  if (tradingWhitelisted) localAutoDelete = false;
  let autoDelete = localAutoDelete;
  let suspicious = score >= SUSPICIOUS_THRESHOLD;
  const signals = [...Object.keys(tags)];
  if (tradingWhitelisted) signals.push('trading-whitelist');

  // 5) 로컬 VLM 보강 — 자동삭제는 아니지만 스캠 신호 조합이 있으면 VLM이 눈으로 재확인.
  //    (순수 양성 이미지 = 신호 0개는 VLM을 부르지 않아 CPU 비용을 묶어둔다.)
  const strongTag = tags.giveaway || tags.wallet || tags.url || tags.casino || tags.celebrity;
  const lowTextHint = ocrText.trim().length < 40 && (tags.crypto || tags.qr);
  const candidate = !autoDelete && (
    strongTag
    || tagCount >= 2
    || (tags.crypto && tags.money)
    || tags.qr
    || lowTextHint
  );

  // VLM은 "의심을 확정으로 올리는" 역할만 한다 — 없던 판정을 혼자 만들지 못한다.
  // 로컬이 스스로 의심(점수 45+)으로 보고, 서로 다른 신호가 2종류 이상일 때만 VLM 확정을 인정.
  // (오탐 사례: 카지노 삭제 공지 스크린샷 → 로컬은 "카지노" 한 단어 30점뿐인데
  //  3B VLM이 없는 유명인 사칭을 봤다며 0.95로 단정 → 삭제 + 자동 킥)
  const localCorroborated = tagCount >= 2 && score >= SUSPICIOUS_THRESHOLD;

  if (candidate) {
    const vlm = await localVlmService.analyzeImage(buffer);
    if (vlm) {
      signals.push(`vlm(scam=${vlm.scam},conf=${vlm.confidence.toFixed(2)})`);
      if (vlm.scam && vlm.confidence >= 0.8 && localCorroborated && !tradingWhitelisted) {
        autoDelete = true;
        suspicious = true;
        score = Math.max(score, 90);
        reasons.push(t(lang, 'reason.vlmScam', { pct: Math.round(vlm.confidence * 100), detail: vlm.reason }));
      } else if (vlm.scam && vlm.confidence >= 0.5) {
        // 로컬 뒷받침이 없는 AI 단독 판정 → 삭제·제재 없이 관리자 알림만(의심)
        suspicious = true;
        reasons.push(t(lang, 'reason.vlmSuspect', { pct: Math.round(vlm.confidence * 100), detail: vlm.reason }));
      }
    }
  }

  // 해시 블록리스트는 이후 OCR/AI 없이 100%로 즉시 삭제하는 fast-path라 오탐이 영구히 굳는다.
  // → AI가 개입하지 않은 로컬 확정 삭제만 학습한다.
  if (localAutoDelete && imgHash && !known) {
    scamHashStore.addScamHash(imgHash);
  }

  return {
    ...base,
    autoDelete,
    suspicious,
    dangerPercent: Math.round(score),
    confidence: Math.min(1, score / 100),
    reason: reasons.join(' · ') || '특이사항 없음',
    signals,
    phash: imgHash,
    ocrText,
    qrUrl,
  };
}

/**
 * 메시지에 달린 이미지들을 스캔. 하나라도 고신뢰 스캠이면 즉시 그 결과 반환.
 * @param {Array} imageAttachments discord.js Attachment 배열 (image/* 만)
 * @param {string} messageText 동봉 텍스트
 */
async function scanMessageImages(imageAttachments, messageText, prefetched, lang = DEFAULT_LANG) {
  let topSuspicious = null;
  const scanned = []; // [{ url, buffer, result }]

  for (const att of imageAttachments) {
    // 바이러스 검사 단계에서 이미 받은 버퍼가 있으면 재사용(중복 다운로드 방지)
    const buffer = (prefetched && prefetched.get(att.url)) || (await downloadAttachment(att.url));
    if (!buffer) {
      scanned.push({ url: att.url, buffer: null, result: null });
      continue;
    }

    const result = await scanImage(buffer, att.contentType, messageText, lang);
    result.attachmentName = att.name;
    result.attachmentUrl = att.url;
    result.buffer = buffer;
    scanned.push({ url: att.url, buffer, result });

    if (result.autoDelete) {
      // 삭제 확정 → 메시지 전체를 지우므로 나머지 이미지는 스캔할 필요 없음
      return { autoDelete: true, suspicious: true, trigger: result, scanned };
    }
    if (result.suspicious && (!topSuspicious || result.dangerPercent > topSuspicious.dangerPercent)) {
      topSuspicious = result;
    }
  }

  return { autoDelete: false, suspicious: !!topSuspicious, trigger: topSuspicious, scanned };
}

async function shutdown() {
  if (workerPromise) {
    try {
      const w = await workerPromise;
      await w.terminate();
    } catch { /* 무시 */ }
    workerPromise = null;
  }
}

module.exports = { scanImage, scanMessageImages, downloadAttachment, shutdown };
