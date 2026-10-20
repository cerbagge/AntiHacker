/**
 * 스팸 함정 채널 메시지 AI 판정
 *
 * 함정 채널 글은 일단 지운 뒤, 연관 스윕·제재·해시 학습을 할지 이 판정으로 정한다.
 *   Claude(1차 Haiku → 애매하면 2차 Sonnet) → 안 되면 로컬 VLM(Ollama).
 * verdict:
 *   'spam'        — AI가 스팸으로 판정 → 스윕 + 제재 + 해시 학습
 *   'clean'       — AI가 일반 유저 실수로 판정 → 삭제 + 로그만
 *   'unavailable' — AI를 못 씀(키 없음·오류·시간 초과) → 스윕 + 제재, 해시 학습은 안 함
 */
const claudeReviewService = require('./claudeReviewService');
const localVlmService = require('./localVlmService');

/** AI에 넘길 메시지 설명 (글 + 첨부 이름) */
function describe(content, attachments) {
  const names = attachments.map((a) => a.name).filter(Boolean);
  return [
    `MESSAGE TEXT: ${(content || '').slice(0, 1500) || '(none)'}`,
    `ATTACHMENTS: ${names.length ? names.join(', ').slice(0, 300) : '(none)'}`,
  ].join('\n');
}

/**
 * @param {{content?:string, attachments?:Array, images?:Buffer[]}} input
 * @returns {Promise<{verdict:'spam'|'clean'|'unavailable', model:string|null, confidence:number|null}>}
 */
async function judge({ content = '', attachments = [], images = [] } = {}) {
  const text = describe(content, attachments);

  const claude = await claudeReviewService.analyzeHoneypot(text, images);
  const ai = claude || await localVlmService.analyzeHoneypot(text, images[0]);
  if (!ai) return { verdict: 'unavailable', model: null, confidence: null };

  return {
    verdict: ai.spam ? 'spam' : 'clean',
    model: claude ? claude.model : 'vlm',
    confidence: ai.confidence,
  };
}

module.exports = { judge };
