/**
 * 스팸 스윕 — 허니팟(/spamchannel)에 걸린 유저는 도배봇으로 보고,
 * 그 유저가 "비슷한 시간대"에 올렸거나 "내용이 비슷한" 메시지를 서버 전역에서 함께 삭제한다.
 *
 * 매칭 판정(classify)은 부수효과 없는 순수 함수로 분리해 단위 테스트가 가능하다.
 *  - 시간창: |후보 시각 − 적발 시각| ≤ windowMs
 *  - 내용 유사도: 정규화 후 글자 바이그램 Dice 계수 ≥ similarity (적발 메시지에 텍스트가 있을 때만)
 * 둘 중 하나라도 걸리면 삭제 대상.
 */
const { PermissionsBitField } = require('discord.js');
const logger = require('../utils/logger');

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const FETCH_LIMIT = 100; // 채널당 가져올 최근 메시지 수 (REST 최대)
const MIN_CONTENT_LEN = 5; // 내용 유사도 비교를 허용할 최소 정규화 길이 (짧은 텍스트 오탐 방지)
const CHANNEL_CONCURRENCY = 8; // 동시에 훑을 채널 수 (레이트리밋 보호)

/** 내용 정규화: 소문자 + URL 토큰화(초대코드/링크 변형 흡수) + 공백/문장부호 정리 */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+|discord\.gg\/\S+|\b\S+\.(?:com|net|org|io|gg|xyz|app|co)\/\S*/g, ' url ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // 글자/숫자/공백만 남김
    .replace(/\s+/g, ' ')
    .trim();
}

/** 글자 바이그램 집합 */
function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 두 정규화 문자열의 Dice 유사도(0~1). 짧은 문자열은 완전일치만 1. */
function similarity(a, b) {
  if (a === b) return a.length ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return (2 * inter) / (A.size + B.size);
}

/**
 * 후보 메시지가 적발(anchor)과 연관된 스팸인지 판정.
 * @param {{id:string, content:string, createdTimestamp:number}} candidate
 * @param {{id:string, contentNorm:string, createdTimestamp:number, hasContent:boolean}} anchor
 * @param {{windowMs:number, similarity:number}} opts
 * @returns {null | {timeMatch:boolean, contentMatch:boolean, sim:number, dt:number}}
 */
function classify(candidate, anchor, opts) {
  if (candidate.id === anchor.id) return null; // 적발 메시지 자신은 제외(이미 삭제됨)
  const dt = Math.abs(candidate.createdTimestamp - anchor.createdTimestamp);
  const timeMatch = dt <= opts.windowMs;

  let contentMatch = false;
  let sim = 0;
  if (anchor.hasContent) {
    const candNorm = normalize(candidate.content);
    if (candNorm.length >= MIN_CONTENT_LEN) {
      sim = similarity(candNorm, anchor.contentNorm);
      contentMatch = sim >= opts.similarity;
    }
  }

  if (timeMatch || contentMatch) return { timeMatch, contentMatch, sim, dt };
  return null;
}

/** 동시 실행 상한이 있는 map */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 한 채널에서 모인 메시지들을 삭제(최근분은 bulkDelete, 14일 초과분은 개별 삭제) */
async function deleteMessages(channel, messages) {
  if (messages.length === 0) return 0;
  const now = Date.now();
  const recent = messages.filter((m) => now - m.createdTimestamp < FOURTEEN_DAYS_MS);
  const old = messages.filter((m) => now - m.createdTimestamp >= FOURTEEN_DAYS_MS);
  let deleted = 0;

  if (recent.length >= 2 && typeof channel.bulkDelete === 'function') {
    try {
      const res = await channel.bulkDelete(recent, true); // true: 14일 초과분 자동 제외(에러 방지)
      deleted += res.size;
    } catch (e) {
      logger.warn('스윕 bulkDelete 실패 → 개별 삭제로 폴백', { error: e.message, channel: channel.id });
      for (const m of recent) {
        try { await m.delete(); deleted++; } catch { /* 이미 삭제/권한없음 무시 */ }
      }
    }
  } else {
    for (const m of recent) {
      try { await m.delete(); deleted++; } catch { /* 무시 */ }
    }
  }

  for (const m of old) {
    try { await m.delete(); deleted++; } catch { /* 무시 */ }
  }
  return deleted;
}

/** 봇이 읽고+관리할 수 있는 텍스트 채널인지 */
function canSweep(channel, me) {
  if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) return false;
  if (!me) return channel.viewable === true; // 멤버 캐시 없으면 best-effort
  const perms = channel.permissionsFor(me);
  if (!perms) return false;
  return (
    perms.has(PermissionsBitField.Flags.ViewChannel) &&
    perms.has(PermissionsBitField.Flags.ReadMessageHistory) &&
    perms.has(PermissionsBitField.Flags.ManageMessages)
  );
}

/**
 * 허니팟에 걸린 유저의 연관 스팸(비슷한 시간/내용)을 서버 전역에서 삭제.
 * @param {import('discord.js').Message} anchorMessage 적발된(이미 삭제된) 메시지
 * @param {{windowMs:number, similarity:number}} opts
 * @returns {Promise<{deleted:number, byTime:number, byContent:number, channels:number, scanned:number}>}
 */
async function sweepRelatedMessages(anchorMessage, opts) {
  const result = { deleted: 0, byTime: 0, byContent: 0, channels: 0, scanned: 0 };
  const guild = anchorMessage.guild;
  if (!guild) return result;

  const me = guild.members.me;
  const authorId = anchorMessage.author.id;
  const anchorNorm = normalize(anchorMessage.content || '');
  const anchor = {
    id: anchorMessage.id,
    contentNorm: anchorNorm,
    createdTimestamp: anchorMessage.createdTimestamp,
    hasContent: anchorNorm.length >= MIN_CONTENT_LEN,
  };

  const channels = [...guild.channels.cache.values()].filter((ch) => canSweep(ch, me));

  await mapLimit(channels, CHANNEL_CONCURRENCY, async (channel) => {
    let fetched;
    try {
      fetched = await channel.messages.fetch({ limit: FETCH_LIMIT });
    } catch (e) {
      return; // 권한/일시 오류 채널은 건너뜀
    }
    const matched = [];
    for (const msg of fetched.values()) {
      if (msg.author?.id !== authorId) continue;
      result.scanned++;
      const verdict = classify(
        { id: msg.id, content: msg.content || '', createdTimestamp: msg.createdTimestamp },
        anchor,
        opts
      );
      if (verdict) {
        matched.push(msg);
        if (verdict.timeMatch) result.byTime++;
        if (verdict.contentMatch) result.byContent++;
      }
    }
    if (matched.length > 0) {
      const n = await deleteMessages(channel, matched);
      result.deleted += n;
      if (n > 0) result.channels++;
    }
  });

  return result;
}

module.exports = {
  sweepRelatedMessages,
  // 단위 테스트/재사용용 순수 함수
  normalize,
  similarity,
  classify,
};
