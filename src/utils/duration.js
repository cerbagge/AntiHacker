/**
 * 기간 문자열 파서/포맷터 — `/spamsanction time` 에서 사용.
 *
 * 형식: 숫자+단위 토큰의 나열. 예) "4h3m13s", "1Y", "2M10h".
 * 단위(대소문자 구분): Y(년) · M(월) · h(시간) · m(분) · s(초)
 *  - M(대문자)=월, m(소문자)=분 이 서로 다르다.
 */

// 월=30일, 년=365일로 근사 (표시/타임아웃용, 정확한 달력 연산 아님)
const UNIT_MS = {
  Y: 365 * 24 * 60 * 60 * 1000,
  M: 30 * 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  s: 1000,
};

/**
 * "4h3m13s" → ms. 형식이 조금이라도 어긋나면(잘못된 문자/공백/빈값) null.
 * @param {string} str
 * @returns {number|null}
 */
function parseDuration(str) {
  if (!str || typeof str !== 'string') return null;
  const cleaned = str.trim();
  const re = /(\d+)([YMhms])/g; // 대소문자 구분
  let total = 0;
  let lastIndex = 0;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    if (m.index !== lastIndex) return null; // 토큰 사이에 잡문자
    total += Number(m[1]) * UNIT_MS[m[2]];
    lastIndex = re.lastIndex;
  }
  if (lastIndex !== cleaned.length) return null; // 끝까지 소비 못함 → 형식 오류
  return total > 0 ? total : null;
}

/**
 * ms → 같은 토큰 표기("1h30m13s"). 로그 필드 표시용.
 * @param {number} ms
 * @returns {string}
 */
function humanizeDuration(ms) {
  if (!ms || ms <= 0) return '0s';
  let rem = ms;
  let out = '';
  for (const label of ['Y', 'M', 'h', 'm', 's']) {
    const n = Math.floor(rem / UNIT_MS[label]);
    if (n > 0) {
      out += n + label;
      rem -= n * UNIT_MS[label];
    }
  }
  return out || '0s';
}

module.exports = { parseDuration, humanizeDuration };
