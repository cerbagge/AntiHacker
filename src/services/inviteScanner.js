/**
 * 디스코드 초대 가드 — 메시지에 든 디스코드 링크(초대/채널)를 검사한다.
 * 링크가 있다는 사실만으로는 차단하지 않는다. 판단 근거는 언제나 "대상 서버"이며,
 * 함께 적힌 문구(멘션/광고 문구)로는 삭제하지 않는다. 차단 경로는 두 가지:
 *
 *   A) 초대 링크 — 초대 대상 서버로 판단 (흐름: 싼 것 → 비싼 것).
 *      1) 초대코드 추출 (discord.gg/CODE, discord.com/invite/CODE 등)
 *      2) client.fetchInvite(code) 로 대상 길드 메타(name/description/icon/nsfwLevel) 해석
 *
 *   B) 채널 딥링크 (discord.com/channels/<서버ID>/<채널ID>) — 대상 서버로 판단.
 *      1) 링크의 서버ID로 client.guilds.fetch(id) 로 길드 메타 해석
 *      2) 단, 봇이 함께 가입한 서버만 ID로 조회 가능하다. 미가입 외부 서버와
 *         DM 딥링크(/@me/…)는 대상 서버를 해석할 수 없으므로 통과.
 *
 *   공통 판정(classifyServer, 순수):
 *      a. 공식 nsfwLevel == Explicit(1) | AgeRestricted(3) → 성인(즉시, AI 불필요)
 *      b. 로컬 AI(VLM)가 이름+설명+아이콘 보고 adult/spam 판정 (신뢰도 임계값 이상)
 *      c. AI 불가/미달 시 노골적 키워드 폴백
 *
 * 도배 보호: 메시지당 링크 상한, 코드/길드별 결과 캐시(TTL), AI 호출은 imageQueue 슬롯으로 동시성 제한.
 */
const config = require('../config');
const logger = require('../utils/logger');
const localVlmService = require('./localVlmService');
const imageQueue = require('./imageQueue');
const { t, DEFAULT_LANG } = require('./i18n');

// GuildNSFWLevel: Default=0, Explicit=1, Safe=2, AgeRestricted=3
const NSFW_EXPLICIT = 1;
const NSFW_AGE_RESTRICTED = 3;

const MAX_INVITES_PER_MESSAGE = 3; // 메시지당 해석할 초대 수 상한(REST/AI 비용 보호)
const AI_DELETE_CONFIDENCE = 0.8; // AI 판정으로 삭제하려면 이 신뢰도 이상
const KEYWORD_CONFIDENCE = 0.6;
const ICON_MAX_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

// 초대 링크/코드 추출 (공식 디스코드 도메인만 — fetchInvite로 해석 가능한 것). 코드는 대소문자 보존.
const INVITE_REGEX =
  /(?:https?:\/\/)?(?:(?:canary|ptb)\.)?(?:discord(?:app)?\.com\/invite|discord\.gg)\/([a-z0-9-]{2,64})/gi;

// 채널 딥링크 추출 — discord.com/channels/<서버ID|@me>/<채널ID>. 서버ID가 있으면 그 길드를 해석해 판정한다.
// (DM 딥링크 @me 는 대상 서버가 없어 해석 불가 → 통과)
const CHANNEL_LINK_REGEX =
  /(?:https?:\/\/)?(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/channels\/(@me|\d{5,25})\/(\d{5,25})/gi;

// 노골적 성인 키워드(폴백용, 서버 이름·설명과 메시지 문구 공용) — 오탐을 줄이려 변별력 높은 토큰만.
const ADULT_KEYWORDS = [
  'porn', 'pornhub', 'hentai', 'onlyfans', ' xxx', 'xxx ', 'r-18', 'r18', '18+', '19+',
  'nsfw', 'sexchat', 'sexcam', 'escort', 'nude', 'nudes', 'camgirl', 'fansly',
  '야동', '성인방', '성인 방', '섹스', '섹트', '노출방', '후방주의', '음란',
];
// 스팸/스캠 키워드(폴백용, 서버 이름·설명과 메시지 문구 공용) — 매우 distinctive 한 것만.
const SPAM_KEYWORDS = [
  'free nitro', 'nitro giveaway', 'steamcommunity.com/gift', 'token grabber', 'token logger',
  'server nuker', 'account selling', 'account shop', 'cheap accounts', 'selfbot', 'self-bot',
  '셀프봇', '계정판매', '계정 판매', '토큰그래버', '디코털이',
];

// ── 결과 캐시 (코드 → verdict|null), 같은 초대 재게시 시 재해석 방지 ──
const cache = new Map(); // code -> { value, at }
function getCache(code) {
  const e = cache.get(code);
  if (!e) return undefined;
  if (Date.now() - e.at > CACHE_TTL_MS) { cache.delete(code); return undefined; }
  return e.value; // null 도 유효한 캐시값(=깨끗함)
}
function setCache(code, value) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(code, { value, at: Date.now() });
}

/** 텍스트에서 디스코드 초대코드 추출 (중복 제거, 등장 순서 유지) */
function extractInviteCodes(text) {
  const out = [];
  const seen = new Set();
  if (!text) return out;
  for (const m of String(text).matchAll(INVITE_REGEX)) {
    const code = m[1];
    if (code && !seen.has(code)) { seen.add(code); out.push(code); }
  }
  return out;
}

/** 텍스트에서 채널 딥링크의 대상 추출 (중복 제거, 등장 순서 유지). guild='@me' 면 DM 링크. */
function extractChannelTargets(text) {
  const out = [];
  const seen = new Set();
  if (!text) return out;
  for (const m of String(text).matchAll(CHANNEL_LINK_REGEX)) {
    const guild = m[1];
    const channelId = m[2];
    const key = `${guild}/${channelId}`;
    if (!seen.has(key)) { seen.add(key); out.push({ guild, channelId }); }
  }
  return out;
}

/** 외부(다른 서버/DM) 채널 딥링크만 추출 — 같은 서버 점프 링크는 제외 */
function extractExternalChannelTargets(text, ownGuildId) {
  return extractChannelTargets(text).filter(
    ({ guild }) => !(ownGuildId && guild === ownGuildId)
  );
}

function isOfficialNsfw(nsfwLevel) {
  return nsfwLevel === NSFW_EXPLICIT || nsfwLevel === NSFW_AGE_RESTRICTED;
}

/**
 * 대상 서버 판정 (부수효과 없는 순수 함수).
 * @param {{nsfwLevel?:number, name?:string, description?:string, ai?:({adult:boolean,spam:boolean,confidence:number,reason:string}|null)}} s
 * @returns {null | {flagged:true, adult:boolean, spam:boolean, source:'nsfwLevel'|'ai'|'keyword', detail:string, confidence:number}}
 */
function classifyServer({ nsfwLevel, name, description, ai } = {}) {
  // a) 공식 등급
  if (isOfficialNsfw(nsfwLevel)) {
    return { flagged: true, adult: true, spam: false, source: 'nsfwLevel', detail: String(nsfwLevel), confidence: 1 };
  }
  // b) AI (신뢰도 임계값 이상)
  if (ai && (ai.adult || ai.spam) && ai.confidence >= AI_DELETE_CONFIDENCE) {
    return { flagged: true, adult: !!ai.adult, spam: !!ai.spam, source: 'ai', detail: ai.reason || '', confidence: ai.confidence };
  }
  // c) 키워드 폴백
  const hay = `${name || ''} ${description || ''}`.toLowerCase();
  for (const kw of ADULT_KEYWORDS) {
    if (hay.includes(kw)) return { flagged: true, adult: true, spam: false, source: 'keyword', detail: kw.trim(), confidence: KEYWORD_CONFIDENCE };
  }
  for (const kw of SPAM_KEYWORDS) {
    if (hay.includes(kw)) return { flagged: true, adult: false, spam: true, source: 'keyword', detail: kw.trim(), confidence: KEYWORD_CONFIDENCE };
  }
  return null;
}

/** fetch 로 아이콘 다운로드 (크기 제한). 실패 시 null */
async function downloadImage(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > ICON_MAX_BYTES) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength > ICON_MAX_BYTES) return null;
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

async function resolveInvite(client, code) {
  try {
    return await client.fetchInvite(code);
  } catch (e) {
    // 만료/무효/존재안함 → 해석불가(깨끗 취급)
    return null;
  }
}

/** 채널 딥링크의 서버ID로 길드 해석 — 봇이 함께 가입한 서버만 조회됨. 미가입/접근불가면 null(통과) */
async function resolveGuild(client, guildId) {
  try {
    return await client.guilds.fetch(guildId);
  } catch (e) {
    return null;
  }
}

function finalize(verdict, code, guild) {
  return {
    code,
    guildId: guild.id,
    guildName: guild.name || '(unknown)',
    kind: verdict.adult ? 'adult' : 'spam',
    source: verdict.source,
    detail: verdict.detail,
    confidence: verdict.confidence,
  };
}

/**
 * 해석된 길드(초대 대상/채널 링크 대상 공용)를 판정 → classifyServer verdict|null.
 * 공식 등급이면 즉시, 아니면 로컬 AI(가용 + 슬롯 확보 시) → 키워드 폴백.
 */
async function analyzeGuildVerdict(guild, logCtx = {}) {
  const name = guild.name;
  const description = guild.description;
  const nsfwLevel = guild.nsfwLevel;

  // a) 공식 등급이면 즉시(AI 불필요)
  if (isOfficialNsfw(nsfwLevel)) {
    return { adult: true, spam: false, source: 'nsfwLevel', detail: String(nsfwLevel), confidence: 1 };
  }

  // b) 로컬 AI 분석 (VLM 가용 + 큐 슬롯 확보 시에만)
  let ai = null;
  if (config.SCAM_VLM_ENABLED && (await localVlmService.isAvailable())) {
    const slot = await imageQueue.acquire();
    if (slot) {
      try {
        let iconBuffer = null;
        const iconUrl = typeof guild.iconURL === 'function' ? guild.iconURL({ extension: 'png', size: 128 }) : null;
        if (iconUrl) iconBuffer = await downloadImage(iconUrl);
        ai = await localVlmService.analyzeDiscordServer({ name, description, iconBuffer });
      } catch (e) {
        logger.warn('대상 서버 AI 분석 실패', { ...logCtx, error: e.message });
      } finally {
        imageQueue.release();
      }
    }
  }

  // c) 최종 판정(AI + 키워드 폴백)
  return classifyServer({ nsfwLevel, name, description, ai });
}

/**
 * 초대코드 하나 분석. flagged 면 verdict, 아니면 null.
 * @param {string} ownGuildId 봇이 동작 중인 서버 id (자기 서버 초대는 스킵)
 */
async function analyzeInvite(client, code, ownGuildId) {
  const cached = getCache(code);
  if (cached !== undefined) return cached;

  const invite = await resolveInvite(client, code);
  const guild = invite && invite.guild;
  if (!guild || !guild.id) { setCache(code, null); return null; } // 그룹DM/해석실패
  if (ownGuildId && guild.id === ownGuildId) { setCache(code, null); return null; } // 자기 서버 초대

  const verdict = await analyzeGuildVerdict(guild, { code });
  const out = verdict ? finalize(verdict, code, guild) : null;
  setCache(code, out);
  return out;
}

/**
 * 채널 딥링크 하나 분석 (대상 서버ID로 길드 해석 후 초대와 동일 판정). flagged 면 verdict, 아니면 null.
 * 봇이 함께 가입한 서버만 해석 가능 — 미가입 외부 서버는 통과. linkKind='channel' 로 표시.
 */
async function analyzeChannelLink(client, guildId) {
  const cacheKey = `ch:${guildId}`;
  const cached = getCache(cacheKey);
  if (cached !== undefined) return cached;

  const guild = await resolveGuild(client, guildId);
  if (!guild || !guild.id) { setCache(cacheKey, null); return null; } // 봇 미가입/접근불가 → 해석불가

  const verdict = await analyzeGuildVerdict(guild, { guildId });
  const out = verdict ? { ...finalize(verdict, null, guild), linkKind: 'channel' } : null;
  setCache(cacheKey, out);
  return out;
}

/** 사유 문자열(서버 언어) 생성 — 링크 종류(초대/채널)에 맞는 키 사용 */
function buildReason(v, lang) {
  const server = `\`${(v.guildName || '').slice(0, 80)}\``;
  const detail = (v.detail || '').slice(0, 120);
  const ch = v.linkKind === 'channel';
  if (v.kind === 'adult') {
    return v.source === 'nsfwLevel'
      ? t(lang, ch ? 'reason.channelNsfwLevel' : 'reason.inviteNsfwLevel', { server })
      : t(lang, ch ? 'reason.channelAdult' : 'reason.inviteAdult', { server, detail });
  }
  return t(lang, ch ? 'reason.channelSpam' : 'reason.inviteSpam', { server, detail });
}

/**
 * 메시지의 디스코드 링크(초대/채널)를 검사 → 첫 번째 flagged verdict 반환(없으면 null).
 * 링크가 없으면 비용 0으로 통과. 링크가 있어도 그 자체로는 차단하지 않고,
 * ① 초대 링크는 대상 서버(이름/설명/공식등급/아이콘)가 성인/스팸일 때만,
 * ② 채널 딥링크는 서버ID로 대상 길드를 해석(봇 공동 가입 서버만)해 성인/스팸일 때만 차단.
 *    DM 딥링크(@me)·봇 미가입 외부 서버는 해석 불가라 통과.
 * @param {import('discord.js').Client} client
 * @param {string} text
 * @param {string} ownGuildId
 * @param {string} lang
 */
async function scanMessageInvites(client, text, ownGuildId, lang = DEFAULT_LANG) {
  const codes = extractInviteCodes(text).slice(0, MAX_INVITES_PER_MESSAGE);
  const channelTargets = extractExternalChannelTargets(text, ownGuildId);
  if (codes.length === 0 && channelTargets.length === 0) return null; // 디스코드 링크 없음

  // 초대 링크 — 어떤 경우든(멘션 포함) 문구가 아니라 대상 서버를 해석해서 판단.
  // 대상 서버가 성인/스팸이면 차단, 정상/해석불가면 통과.
  if (codes.length > 0) {
    for (const code of codes) {
      const v = await analyzeInvite(client, code, ownGuildId);
      if (v) {
        v.reason = buildReason(v, lang);
        return v;
      }
    }
    return null;
  }

  // 채널 딥링크 — 서버ID로 대상 길드를 해석해 초대와 동일하게 서버 자체로 판단.
  // 봇이 함께 가입한 서버만 해석되고, DM(@me)·미가입 외부 서버는 통과.
  for (const { guild } of channelTargets.slice(0, MAX_INVITES_PER_MESSAGE)) {
    if (guild === '@me') continue; // DM 딥링크 — 대상 서버 없음
    const v = await analyzeChannelLink(client, guild);
    if (v) {
      v.reason = buildReason(v, lang);
      return v;
    }
  }
  return null;
}

module.exports = {
  scanMessageInvites,
  // 단위 테스트/재사용용
  extractInviteCodes,
  extractChannelTargets,
  extractExternalChannelTargets,
  classifyServer,
  isOfficialNsfw,
};
