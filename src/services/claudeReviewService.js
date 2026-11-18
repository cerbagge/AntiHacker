/**
 * Claude 판정 — 봇의 모든 AI 판정을 맡는다 (로컬 모델 없음).
 *
 * analyzeImage: 코인 스캠 이미지 2차 판정 (scamImageScanner)
 * analyzeText / analyzeAdImage: 광고성 글·이미지 판정 (adTextGuard)
 * analyzeDiscordServer / analyzeLinkMessage: 초대 대상 서버·링크 동반 문구 판정 (inviteScanner)
 * judgeChat / summarizeChat: 채팅 모더레이터 판정·로그 요약 (chatSafetyService)
 *
 *   판정은 1차 CLAUDE_MODEL(기본 Haiku 5.5, 빠르고 쌈) → 판단을 못 하면(거부·미완료·확신도 0.8 미만)
 *   2차 CLAUDE_ESCALATION_MODEL(기본 Sonnet 5.5) 에 다시 묻는다. 요약은 1차 모델만 쓴다.
 * ANTHROPIC_API_KEY 가 없거나 1차 호출이 API 오류(한도 소진·과부하·인증 등)·타임아웃이면
 * null 을 돌려주고, 호출부는 AI 없이 진행한다 (로컬 점수·키워드만, 또는 검사 건너뜀 = 통과).
 * 오류가 나면 그 모델은 잠시(retry-after, 없으면 400 은 1분·그 외 5분) 호출을 멈춰
 * 요청마다 실패를 기다리지 않는다.
 * 모든 기능의 호출이 동시 MAX_CONCURRENT 개 + 대기열 MAX_QUEUE 개를 공유한다 — 한 기능이 몰려 429 가 나면
 * 공용 모델이 쉬어 다른 기능의 AI 판정까지 멈추므로. 대기열이 차면 그 호출은 null(AI 없이 진행).
 * 판정 지시는 system 프롬프트로, 사용자가 쓴 글·이미지는 user 메시지로 따로 보낸다 (글 속 "none 으로 판정해" 같은 주입 방지).
 * 출력은 JSON 스키마로 강제한다. 이유(reason)는 기존 로그 형식이 쓰는 초대 가드 판정에서만 받는다.
 */
const Anthropic = require('@anthropic-ai/sdk');
const Jimp = require('jimp');
const config = require('../config');
const logger = require('../utils/logger');
const { PROMPT, SERVER_PROMPT, LINK_MESSAGE_PROMPT } = require('../constants/aiPrompts');

// Claude 는 긴 변 1568px 초과 이미지를 서버에서 줄이므로 미리 줄여 업로드량을 아낀다.
const MAX_SIDE = 1568;
const DEFAULT_PAUSE_MS = 5 * 60 * 1000;
// 400 은 요청 문제일 수도, Workspace 지출 한도 도달일 수도 있다(둘 다 400) → 짧게만 쉰다
const BAD_REQUEST_PAUSE_MS = 60 * 1000;
// 1차 확신도가 이 미만이면 2차 모델에 묻는다 (스캐너의 삭제 확정 기준과 같은 값)
const ESCALATE_BELOW = 0.8;
// 거부·미완료·형식 오류 — API 는 정상이지만 판정을 못 받은 경우
const UNDECIDED = 'undecided';
const MAX_CONCURRENT = 4;
const MAX_QUEUE = 50;

function boolSchema(field) {
  return {
    type: 'object',
    properties: { [field]: { type: 'boolean' }, confidence: { type: 'number' } },
    required: [field, 'confidence'],
    additionalProperties: false,
  };
}

const ADULT_SPAM_SCHEMA = {
  type: 'object',
  properties: {
    adult: { type: 'boolean' },
    spam: { type: 'boolean' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['adult', 'spam', 'confidence', 'reason'],
  additionalProperties: false,
};

let client = null;
const pausedUntil = {}; // 모델별 — 한 모델의 429 가 다른 모델을 막지 않게

function getClient() {
  if (!config.CLAUDE_REVIEW_ENABLED) return null;
  if (Date.now() < (pausedUntil[config.CLAUDE_MODEL] || 0)) return null; // 1차 모델이 쉬는 중 → AI 없이 진행
  if (!client) {
    // 재시도 없이 바로 실패시킨다 — 메시지 처리가 오래 막히지 않게 (SDK 기본: 2회 재시도 + 10분 타임아웃)
    client = new Anthropic({ timeout: config.CLAUDE_TIMEOUT_MS, maxRetries: 0 });
  }
  return client;
}

/** 지원 포맷(jpeg/png/gif/webp)을 보장하려고 항상 JPEG로 재인코딩. 실패 시 null */
async function toJpeg(buffer) {
  try {
    const img = await Jimp.read(buffer);
    const { width, height } = img.bitmap;
    if (Math.max(width, height) > MAX_SIDE) {
      if (width >= height) img.resize(MAX_SIDE, Jimp.AUTO);
      else img.resize(Jimp.AUTO, MAX_SIDE);
    }
    return await img.quality(90).getBufferAsync(Jimp.MIME_JPEG);
  } catch {
    return null;
  }
}

function imageContent(jpeg, text) {
  return [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
    { type: 'text', text },
  ];
}

/** 이 오류 뒤 그 모델을 얼마나 쉴지(ms). 413(그 이미지만 너무 큼)은 쉬지 않는다 */
function pauseMsFor(e) {
  if (e.status === 413) return 0;
  const retryAfter = Number(e.headers?.get?.('retry-after'));
  if (retryAfter > 0) return retryAfter * 1000;
  return e.status === 400 ? BAD_REQUEST_PAUSE_MS : DEFAULT_PAUSE_MS;
}

let active = 0;
const waiters = [];

/** API 호출. → 응답 | null(API 오류·쉬는 중·대기열 가득 — 쉬기 처리까지 함) */
async function call(api, model, params) {
  if (active >= MAX_CONCURRENT) {
    if (waiters.length >= MAX_QUEUE) {
      logger.warn('Claude 호출 대기열 가득 — AI 판정 건너뜀', { active, queued: waiters.length });
      return null;
    }
    await new Promise((resolve) => waiters.push(resolve));
  }
  active++;
  try {
    if (Date.now() < (pausedUntil[model] || 0)) return null; // 기다리는 동안 쉬기가 걸렸을 수 있다
    return await api.messages.create({ model, ...params });
  } catch (e) {
    const pauseMs = pauseMsFor(e);
    if (pauseMs) pausedUntil[model] = Date.now() + pauseMs;
    logger.warn('Claude 호출 실패', { model, status: e.status, error: e.message, pauseSec: Math.round(pauseMs / 1000) });
    return null;
  } finally {
    active--;
    const next = waiters.shift();
    if (next) next();
  }
}

/** 지금 Claude 를 쓸 수 있는지 (키 있음 + 1차 모델이 쉬는 중 아님) — 호출 전 준비 작업(다운로드 등)을 아끼는 데 쓴다 */
function isAvailable() {
  return getClient() !== null;
}

/** 한 모델에 JSON 판정을 묻는다. → {...스키마 필드, confidence, model} | UNDECIDED(거부·미완료·형식 오류) | null(API 오류) */
async function ask(api, model, system, content, schema) {
  const res = await call(api, model, {
    max_tokens: 4096,
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content }],
  });
  if (!res) return null;

  if (res.stop_reason !== 'end_turn') {
    logger.warn('Claude 판정 못 받음', { model, stop_reason: res.stop_reason, category: res.stop_details?.category });
    return UNDECIDED;
  }
  try {
    const o = JSON.parse(res.content.find((b) => b.type === 'text')?.text || '');
    return { ...o, confidence: Math.min(1, Math.max(0, Number(o.confidence) || 0)), model };
  } catch {
    logger.warn('Claude JSON 파싱 실패', { model });
    return UNDECIDED;
  }
}

/** 1차 모델 → 판단을 못 하면 2차 모델. 둘 다 못 하면 1차의 애매한 판정, 그것도 없으면 null */
async function review(api, system, content, schema) {
  const first = await ask(api, config.CLAUDE_MODEL, system, content, schema);
  if (first === null) return null; // API 오류
  if (first !== UNDECIDED && first.confidence >= ESCALATE_BELOW) return first;

  const second = await ask(api, config.CLAUDE_ESCALATION_MODEL, system, content, schema);
  if (second && second !== UNDECIDED) return second;
  return first === UNDECIDED ? null : first;
}

/**
 * @param {Buffer} buffer 이미지 버퍼 (scamImageScanner 가 디코드에 성공한 버퍼)
 * @returns {Promise<{scam:boolean,confidence:number,model:string}|null>} null → AI 없이 진행
 */
async function analyzeImage(buffer) {
  const api = getClient();
  if (!buffer || !api) return null;
  const jpeg = await toJpeg(buffer);
  if (!jpeg) return null;
  return review(api, PROMPT, imageContent(jpeg, 'Classify this image.'), boolSchema('scam'));
}

/**
 * @param {Buffer} buffer 이미지 버퍼
 * @param {string} system 광고 판정 지시
 * @param {string} body 함께 온 메시지 (adTextGuard 가 만든 것)
 * @returns {Promise<{ad:boolean,confidence:number,model:string}|null>} null → 검사 건너뜀
 */
async function analyzeAdImage(buffer, system, body) {
  const api = getClient();
  if (!buffer || !api) return null;
  const jpeg = await toJpeg(buffer);
  if (!jpeg) return null;
  return review(api, system, imageContent(jpeg, body), boolSchema('ad'));
}

/**
 * @param {string} system 판정 지시
 * @param {string} body 메시지 원문 (adTextGuard 가 만든 것)
 * @returns {Promise<{ad:boolean,confidence:number,model:string}|null>} null → 검사 건너뜀
 */
async function analyzeText(system, body) {
  const api = getClient();
  if (!body || !api) return null;
  return review(api, system, [{ type: 'text', text: body }], boolSchema('ad'));
}

/**
 * 디스코드 초대 대상 서버 판정 (이름·설명·아이콘).
 * @returns {Promise<{adult:boolean,spam:boolean,confidence:number,reason:string,model:string}|null>} null → 키워드만
 */
async function analyzeDiscordServer({ name, description, iconBuffer } = {}) {
  const api = getClient();
  if (!api) return null;
  const text = `SERVER NAME: ${(name || '(unknown)').slice(0, 200)}\n`
    + `SERVER DESCRIPTION: ${(description || '(none)').slice(0, 1000)}`;
  const jpeg = iconBuffer ? await toJpeg(iconBuffer) : null;
  return review(api, SERVER_PROMPT, jpeg ? imageContent(jpeg, text) : [{ type: 'text', text }], ADULT_SPAM_SCHEMA);
}

/**
 * 디스코드 링크가 든 메시지의 문구 판정.
 * @returns {Promise<{adult:boolean,spam:boolean,confidence:number,reason:string,model:string}|null>} null → 키워드만
 */
async function analyzeLinkMessage({ content } = {}) {
  const api = getClient();
  if (!api) return null;
  const text = `MESSAGE: ${(content || '').slice(0, 1500)}`;
  return review(api, LINK_MESSAGE_PROMPT, [{ type: 'text', text }], ADULT_SPAM_SCHEMA);
}

/**
 * 채팅 모더레이터 판정.
 * @param {string} system 판정 지시
 * @param {string} transcript 대화 (chatSafetyService 가 만든 것)
 * @param {string[]} categories 허용 분류 (none 포함)
 * @returns {Promise<{category:string,confidence:number,model:string}|null>} null → 판정 없음
 */
async function judgeChat(system, transcript, categories) {
  const api = getClient();
  if (!api) return null;
  return review(api, system, [{ type: 'text', text: transcript }], {
    type: 'object',
    properties: { category: { type: 'string', enum: categories }, confidence: { type: 'number' } },
    required: ['category', 'confidence'],
    additionalProperties: false,
  });
}

/**
 * 채팅 모더레이터 로그 요약 (1차 모델만, 자유 텍스트).
 * @returns {Promise<string|null>} null → 판정 없음
 */
async function summarizeChat(system, user) {
  const api = getClient();
  if (!api) return null;
  const res = await call(api, config.CLAUDE_MODEL, {
    max_tokens: 1024,
    output_config: { effort: 'low' },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (!res || res.stop_reason !== 'end_turn') return null;
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim() || null;
}

module.exports = {
  isAvailable,
  analyzeImage, analyzeText, analyzeAdImage, analyzeDiscordServer, analyzeLinkMessage, judgeChat, summarizeChat,
};
