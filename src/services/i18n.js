/**
 * i18n 헬퍼 — 손으로 쓴 언어팩(en/ko)만 사용. (외부 번역 API 미사용 — 로컬 전용)
 * 지원하지 않는 언어/누락 키는 기본 언어(en)로 폴백.
 */
const translations = require('../constants/translations');

const DEFAULT_LANG = 'en';
const PACK_LANGS = Object.keys(translations); // ['en', 'ko']

// /language 선택지 — en/ko 만.
const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ko', label: '한국어 (Korean)' },
];
const SUPPORTED = LANGUAGES.map((l) => l.code);
const LANG_LABEL = Object.fromEntries(LANGUAGES.map((l) => [l.code, l.label]));

function isPackLang(lang) {
  return PACK_LANGS.includes(lang);
}

function t(lang, key, params) {
  const L = isPackLang(lang) ? lang : DEFAULT_LANG;
  let str = (translations[L] && translations[L][key]) || translations[DEFAULT_LANG][key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) str = str.split(`{${k}}`).join(String(v));
  }
  return str;
}

// 알림/명령 출력용. en/ko 만 지원하므로 t() 와 동일(호출부 비동기 시그니처 유지).
async function tl(lang, key, params) {
  return t(lang, key, params);
}

module.exports = { t, tl, isPackLang, DEFAULT_LANG, SUPPORTED, PACK_LANGS, LANGUAGES, LANG_LABEL };
