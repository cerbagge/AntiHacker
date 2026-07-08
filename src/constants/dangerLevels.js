/**
 * 위험도 퍼센트 기반 가이드라인
 *
 * 0%       — 정상
 * 1~25%    — 경미한 위반
 * 26~50%   — 중간 위반
 * 51~75%   — 심각한 위반
 * 76~100%  — 즉시 차단
 */

const LEVELS = Object.freeze({
  SAFE:     { label: '정상',       min: 0,  max: 0  },
  LOW:      { label: '경미한 위반', min: 1,  max: 25 },
  MEDIUM:   { label: '중간 위반',   min: 26, max: 50 },
  HIGH:     { label: '심각한 위반', min: 51, max: 75 },
  CRITICAL: { label: '즉시 차단',   min: 76, max: 100 },
});

function getLevel(dangerPercent) {
  const p = Math.max(0, Math.min(100, dangerPercent));
  if (p === 0) return LEVELS.SAFE;
  if (p <= 25) return LEVELS.LOW;
  if (p <= 50) return LEVELS.MEDIUM;
  if (p <= 75) return LEVELS.HIGH;
  return LEVELS.CRITICAL;
}

// 위험 카테고리 라벨 (A:성인, V:폭력, H:혐오, P:개인정보, S:스팸/사기)
// antihacker+는 로컬 검사라 실제로는 S(스팸/사기)만 사용하지만, 알림 포맷 호환을 위해 전체 유지.
const BREAKDOWN_LABELS = {
  A: '성인/NSFW',
  V: '폭력/고어',
  H: '혐오/욕설',
  P: '개인정보',
  S: '스팸/사기',
};

module.exports = { LEVELS, getLevel, BREAKDOWN_LABELS };
