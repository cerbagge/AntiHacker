/**
 * Claude 최종 검수 — 코인 스캠 이미지 2차 판정
 *
 * scamImageScanner 의 VLM 단계에서 로컬 VLM보다 먼저 호출된다.
 *   1차 CLAUDE_MODEL(기본 Haiku 5.5, 빠르고 쌈) → 판단을 못 하면(거부·미완료·확신도 0.8 미만)
 *   2차 CLAUDE_ESCALATION_MODEL(기본 Sonnet 5.5) 에 다시 묻는다.
 * ANTHROPIC_API_KEY 가 없거나 1차 호출이 API 오류(한도 소진·과부하·인증 등)·타임아웃이면
 * null 을 돌려주고, 호출부가 로컬 VLM(Ollama)으로 전환한다.
 * 오류가 나면 그 모델은 잠시(retry-after, 없으면 400 은 1분·그 외 5분) 호출을 멈춰
 * 이미지마다 실패를 기다리지 않는다.
 * 판정 이유(reason)는 받지 않는다 — 스키마로 {scam, confidence} 만 출력하게 강제.
 */
const Anthropic = require('@anthropic-ai/sdk');
const Jimp = require('jimp');
const config = require('../config');
const logger = require('../utils/logger');
const { PROMPT } = require('./localVlmService');

// Claude 는 긴 변 1568px 초과 이미지를 서버에서 줄이므로 미리 줄여 업로드량을 아낀다.
const MAX_SIDE = 1568;
const DEFAULT_PAUSE_MS = 5 * 60 * 1000;
// 400 은 요청 문제일 수도, Workspace 지출 한도 도달일 수도 있다(둘 다 400) → 짧게만 쉰다
const BAD_REQUEST_PAUSE_MS = 60 * 1000;
// 1차 확신도가 이 미만이면 2차 모델에 묻는다 (스캐너의 삭제 확정 기준과 같은 값)
const ESCALATE_BELOW = 0.8;
// 거부·미완료·형식 오류 — API 는 정상이지만 판정을 못 받은 경우
const UNDECIDED = 'undecided';

const SCHEMA = {
  type: 'object',
  properties: {
    scam: { type: 'boolean' },
    confidence: { type: 'number' },
  },
  required: ['scam', 'confidence'],
  additionalProperties: false,
};

let client = null;
const pausedUntil = {}; // 모델별 — 한 모델의 429 가 다른 모델을 막지 않게

function getClient() {
  if (!config.CLAUDE_REVIEW_ENABLED) return null;
  if (!client) {
    // 재시도 없이 바로 실패시켜 로컬 VLM으로 넘긴다 (SDK 기본: 2회 재시도 + 10분 타임아웃)
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

/** 이 오류 뒤 그 모델을 얼마나 쉴지(ms). 413(그 이미지만 너무 큼)은 쉬지 않는다 */
function pauseMsFor(e) {
  if (e.status === 413) return 0;
  const retryAfter = Number(e.headers?.get?.('retry-after'));
  if (retryAfter > 0) return retryAfter * 1000;
  return e.status === 400 ? BAD_REQUEST_PAUSE_MS : DEFAULT_PAUSE_MS;
}

/** 한 모델에 묻는다. → 판정 | UNDECIDED(거부·미완료·형식 오류) | null(API 오류·쉬는 중) */
async function ask(api, model, jpeg) {
  if (Date.now() < (pausedUntil[model] || 0)) return null;

  let res;
  try {
    res = await api.messages.create({
      model,
      max_tokens: 4096,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
          { type: 'text', text: PROMPT },
        ],
      }],
    });
  } catch (e) {
    const pauseMs = pauseMsFor(e);
    if (pauseMs) pausedUntil[model] = Date.now() + pauseMs;
    logger.warn('Claude 최종검수 호출 실패', { model, status: e.status, error: e.message, pauseSec: Math.round(pauseMs / 1000) });
    return null;
  }

  if (res.stop_reason !== 'end_turn') {
    logger.warn('Claude 최종검수 판정 못 받음', { model, stop_reason: res.stop_reason, category: res.stop_details?.category });
    return UNDECIDED;
  }
  try {
    const o = JSON.parse(res.content.find((b) => b.type === 'text')?.text || '');
    return {
      scam: o.scam === true,
      confidence: Math.min(1, Math.max(0, Number(o.confidence) || 0)),
      model,
    };
  } catch {
    logger.warn('Claude 최종검수 JSON 파싱 실패', { model });
    return UNDECIDED;
  }
}

/**
 * @param {Buffer} buffer 이미지 버퍼 (scamImageScanner 가 디코드에 성공한 버퍼)
 * @returns {Promise<{scam:boolean,confidence:number,model:string}|null>} null → 로컬 VLM 사용
 */
async function analyzeImage(buffer) {
  const api = getClient();
  // 1차 모델이 쉬는 중이면 이미지 변환도 하지 않고 바로 로컬 VLM으로
  if (!buffer || !api || Date.now() < (pausedUntil[config.CLAUDE_MODEL] || 0)) return null;

  const jpeg = await toJpeg(buffer);
  if (!jpeg) return null;

  const first = await ask(api, config.CLAUDE_MODEL, jpeg);
  if (first === null) return null; // API 오류 → 로컬 VLM
  if (first !== UNDECIDED && first.confidence >= ESCALATE_BELOW) return first;

  // 1차가 판단을 못 함 → 2차 모델. 2차도 못 하면 1차의 애매한 판정, 그것도 없으면 로컬 VLM
  const second = await ask(api, config.CLAUDE_ESCALATION_MODEL, jpeg);
  if (second && second !== UNDECIDED) return second;
  return first === UNDECIDED ? null : first;
}

module.exports = { analyzeImage };
