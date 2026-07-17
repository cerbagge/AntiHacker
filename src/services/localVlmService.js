/**
 * 로컬 VLM (Ollama) — 코인 스캠 이미지 2차 판정
 *
 * OCR/패턴 점수가 애매한 구간(또는 글자가 거의 없는 이미지)일 때만 호출한다.
 * Ollama가 설치/실행되어 있지 않으면 조용히 null 을 반환해서 파이프라인이 그대로 진행된다.
 * (CPU 추론이라 느리므로 타임아웃을 넉넉히 둔다.)
 *
 * 사용 모델 기본값: qwen2.5vl:3b  (config.OLLAMA_VLM_MODEL 로 변경)
 *   설치 후:  ollama pull qwen2.5vl:3b
 */
const config = require('../config');
const logger = require('../utils/logger');

const PROMPT = [
  'You are a strict Discord content-moderation classifier.',
  'Decide whether this image is a CRYPTOCURRENCY / CRYPTO-CASINO SCAM advertisement or proof.',
  'Treat ALL of these as scam:',
  '(1) crypto giveaway / airdrop ("send crypto and get more back", free coin claim, double your coins);',
  '(2) fake celebrity or brand endorsement of crypto (e.g. Elon Musk, MrBeast, Ronaldo, an exchange) —',
  'often a screenshot of a social post (X/Twitter) promising free money with a promo code and an external site;',
  '(3) crypto casino / gambling "bonus" sites: a promo/bonus code to activate, deposit/withdraw bonus,',
  'rakeback, VIP club, "free gift", linking to an unknown casino domain;',
  '(4) fake "Withdrawal Success" / payout / profit screenshots (e.g. "+2700 USDT", fake transfer receipts)',
  'used to lure victims, especially paired with a casino/giveaway site;',
  '(5) a spam post from a hacked / compromised account (e.g. a hijacked verified X/Twitter account)',
  'pushing crypto, or any image whose main purpose is to lure the viewer to an external phishing / illegal link.',
  'Strong tells: an external unfamiliar link/domain, a promo code, urgency ("post will be deleted", "don\'t miss"),',
  'celebrity face + money amounts, a QR code to a claim site.',
  'A normal photo, meme, game screenshot, or ordinary crypto discussion with NO promo/claim/payout-lure is NOT a scam.',
  'Respond with ONLY this JSON, nothing else:',
  '{"scam": true|false, "confidence": 0.0-1.0, "reason": "<short reason>"}',
].join(' ');

// 가용성 캐시 (Ollama 죽어있을 때 매번 핑 안 보내도록)
let availability = { ok: false, checkedAt: 0 };
const AVAIL_TTL_MS = 60 * 1000;

async function isAvailable() {
  if (config.SCAM_VLM_ENABLED === false) return false;
  const now = Date.now();
  if (now - availability.checkedAt < AVAIL_TTL_MS) return availability.ok;

  let ok = false;
  try {
    const res = await fetch(`${config.OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  availability = { ok, checkedAt: now };
  if (!ok) logger.info('로컬 VLM(Ollama) 미응답 — VLM 단계 건너뜀', { url: config.OLLAMA_URL });
  return ok;
}

function parseJson(text) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    return {
      scam: o.scam === true || o.scam === 'true',
      confidence: Math.min(1, Math.max(0, Number(o.confidence) || 0)),
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '',
    };
  } catch {
    return null;
  }
}

// ── 디스코드 초대 대상 서버(길드) 분석용 프롬프트 ──
// 이름/설명(텍스트) + 아이콘(이미지)을 보고 19+(성인) 서버 / 스팸·스캠 서버인지 판정.
const SERVER_PROMPT = [
  'You are a strict Discord SERVER moderation classifier.',
  "You are given a Discord server's NAME, DESCRIPTION and ICON image.",
  'Decide two flags:',
  '- adult: the server is an ADULT / NSFW / 18+ / 19+ / pornographic / sexual / escort / hookup server',
  '  (explicit sexual content, "야동", "성인", porn, hentai, OnlyFans-style, dating-for-sex).',
  '- spam: the server\'s MAIN purpose is SPAM or SCAM — mass-DM/ad farm, fake Nitro/giveaway,',
  '  crypto/airdrop scam, server nuke/raid/token-grabber service, follow-for-follow / self-promo farm,',
  '  cheats/selfbot/account selling, or other abusive advertising.',
  'A normal community, game, art, music, study, or hobby server is NEITHER (both false).',
  'Weigh the ICON as heavily as the text: a photo of a real person posed sexually or suggestively',
  '  (lingerie, nudity, exposed cleavage/body, seductive pose) is by itself a strong ADULT signal —',
  '  set adult=true even when the DESCRIPTION sounds harmless.',
  'Adult servers often DISGUISE the description with vague marketing instead of explicit words:',
  '  "daily posts/content/leaks/media", "for the boys", "Free VIP", "24/7 daily", "exclusive",',
  '  paired with a teaser photo of a woman/model as the icon. Treat that COMBINATION as adult.',
  'An explicit age marker in the NAME or DESCRIPTION — 🔞, "18+", "19+", "R18", "R-18", "NSFW" —',
  '  means adult=true regardless of how tame the rest reads.',
  'Judge from the visible name/description/icon only; do not assume.',
  'Respond with ONLY this JSON, nothing else:',
  '{"adult": true|false, "spam": true|false, "confidence": 0.0-1.0, "reason": "<short reason>"}',
].join(' ');

function parseServerJson(text) {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]);
    return {
      adult: o.adult === true || o.adult === 'true',
      spam: o.spam === true || o.spam === 'true',
      confidence: Math.min(1, Math.max(0, Number(o.confidence) || 0)),
      reason: typeof o.reason === 'string' ? o.reason.slice(0, 200) : '',
    };
  } catch {
    return null;
  }
}

/**
 * 디스코드 초대 대상 서버를 로컬 VLM으로 분석.
 * @param {{name?:string, description?:string, iconBuffer?:Buffer|null}} server
 * @returns {Promise<{adult:boolean,spam:boolean,confidence:number,reason:string}|null>} 사용 불가/오류 시 null
 */
async function analyzeDiscordServer({ name, description, iconBuffer } = {}) {
  if (!(await isAvailable())) return null;

  const prompt =
    `${SERVER_PROMPT}\nSERVER NAME: ${(name || '(unknown)').slice(0, 200)}\n` +
    `SERVER DESCRIPTION: ${(description || '(none)').slice(0, 1000)}`;

  try {
    const body = {
      model: config.OLLAMA_VLM_MODEL,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: 0 },
    };
    if (iconBuffer) body.images = [iconBuffer.toString('base64')];

    const res = await fetch(`${config.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.OLLAMA_TIMEOUT_MS),
    });

    if (!res.ok) {
      logger.warn('로컬 VLM 서버분석 응답 오류', { status: res.status });
      return null;
    }
    const data = await res.json();
    const parsed = parseServerJson(data.response || '');
    if (!parsed) logger.warn('로컬 VLM 서버분석 JSON 파싱 실패', { raw: (data.response || '').slice(0, 200) });
    return parsed;
  } catch (e) {
    logger.warn('로컬 VLM 서버분석 호출 실패', { error: e.message });
    availability = { ok: false, checkedAt: Date.now() };
    return null;
  }
}

// ── 디스코드 링크 동반 메시지(문구) 분석용 프롬프트 ──
// 링크 자체가 아니라 함께 적힌 메시지 문구가 스팸/성인 유인인지 판정.
// 정상적인 통화방/서버 초대·공유는 통과시키는 것이 목적.
const LINK_MESSAGE_PROMPT = [
  'You are a strict Discord chat-message moderation classifier.',
  'You are given ONE chat message that contains a Discord invite or channel link',
  '(the link itself is replaced with a placeholder like [discord-invite]).',
  'Decide two flags about the MESSAGE TEXT, not the link:',
  '- adult: the text lures readers to sexual/adult content — adult voice-chat room invites with sexual framing',
  '  (e.g. "성인 통화방", "섹트", age/gender bait like "20살 여자"), nudes/cam/hookup offers, porn sharing.',
  '- spam: the text is unsolicited mass-advertising or a scam lure — fake Nitro/giveaway, crypto/airdrop scam,',
  '  account/cheat/selfbot selling, raid-or-nuke service, "join for free rewards" bait, copy-paste ad blasts.',
  'A normal message is NEITHER (both false): friends inviting each other to a voice call or server,',
  'sharing a community/game/study server with ordinary context, or casual chat that happens to include a link.',
  'Judge ONLY from the given text; do not assume.',
  'Respond with ONLY this JSON, nothing else:',
  '{"adult": true|false, "spam": true|false, "confidence": 0.0-1.0, "reason": "<short reason>"}',
].join(' ');

/**
 * 디스코드 링크가 포함된 메시지의 문구를 로컬 VLM으로 분석 (텍스트 전용).
 * @param {{content?:string}} msg
 * @returns {Promise<{adult:boolean,spam:boolean,confidence:number,reason:string}|null>} 사용 불가/오류 시 null
 */
async function analyzeLinkMessage({ content } = {}) {
  if (!(await isAvailable())) return null;

  const prompt = `${LINK_MESSAGE_PROMPT}\nMESSAGE: ${(content || '').slice(0, 1500)}`;

  try {
    const res = await fetch(`${config.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.OLLAMA_VLM_MODEL,
        prompt,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(config.OLLAMA_TIMEOUT_MS),
    });

    if (!res.ok) {
      logger.warn('로컬 VLM 링크메시지 분석 응답 오류', { status: res.status });
      return null;
    }
    const data = await res.json();
    const parsed = parseServerJson(data.response || '');
    if (!parsed) logger.warn('로컬 VLM 링크메시지 분석 JSON 파싱 실패', { raw: (data.response || '').slice(0, 200) });
    return parsed;
  } catch (e) {
    logger.warn('로컬 VLM 링크메시지 분석 호출 실패', { error: e.message });
    availability = { ok: false, checkedAt: Date.now() };
    return null;
  }
}

/**
 * @param {Buffer} buffer 이미지 원본 버퍼
 * @returns {Promise<{scam:boolean,confidence:number,reason:string}|null>} 사용 불가/오류 시 null
 */
async function analyzeImage(buffer) {
  if (!buffer || !(await isAvailable())) return null;

  try {
    const res = await fetch(`${config.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.OLLAMA_VLM_MODEL,
        prompt: PROMPT,
        images: [buffer.toString('base64')],
        stream: false,
        format: 'json',
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(config.OLLAMA_TIMEOUT_MS),
    });

    if (!res.ok) {
      logger.warn('로컬 VLM 응답 오류', { status: res.status });
      return null;
    }
    const data = await res.json();
    const parsed = parseJson(data.response || '');
    if (!parsed) logger.warn('로컬 VLM JSON 파싱 실패', { raw: (data.response || '').slice(0, 200) });
    return parsed;
  } catch (e) {
    logger.warn('로컬 VLM 호출 실패', { error: e.message });
    // 타임아웃/연결오류면 가용성 캐시 무효화
    availability = { ok: false, checkedAt: Date.now() };
    return null;
  }
}

module.exports = { analyzeImage, analyzeDiscordServer, analyzeLinkMessage, isAvailable };
