const patterns = require('../constants/phishingPatterns');
const { t, DEFAULT_LANG } = require('./i18n');

const URL_REGEX = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;

// 안전한 도메인 (분석 건너뜀)
const SAFE_DOMAINS = [
  'drive.google.com',
  'docs.google.com',
  'sheets.google.com',
  'slides.google.com',
  'forms.google.com',
  'photos.google.com',
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'github.com',
  'www.github.com',
  'moonightip.com',
  'www.moonightip.com',
];

function extractUrls(text) {
  return text.match(URL_REGEX) || [];
}

function isSafeDomain(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return SAFE_DOMAINS.some((d) => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return false;
  }
}

function checkLocalPatterns(url, lang = DEFAULT_LANG) {
  const lowerUrl = url.toLowerCase();

  // IP 주소 기반 URL 체크
  if (patterns.ipAddressUrl.test(url)) {
    return { dangerPercent: 85, reason: t(lang, 'reason.linkIp') };
  }

  // 피싱 도메인 키워드 체크
  for (const keyword of patterns.suspiciousDomainKeywords) {
    if (lowerUrl.includes(keyword)) {
      return { dangerPercent: 90, reason: t(lang, 'reason.linkPhish', { keyword }) };
    }
  }

  // 의심스러운 TLD + 브랜드명 조합 체크
  for (const tld of patterns.suspiciousTlds) {
    if (lowerUrl.includes(tld)) {
      for (const brand of patterns.brandKeywords) {
        if (lowerUrl.includes(brand)) {
          return { dangerPercent: 85, reason: t(lang, 'reason.linkTldBrand', { tld, brand }) };
        }
      }
    }
  }

  return null;
}

module.exports = { extractUrls, checkLocalPatterns, isSafeDomain };
