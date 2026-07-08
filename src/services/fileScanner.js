const path = require('path');
const dangerousExtensions = require('../constants/dangerousExtensions');
const patterns = require('../constants/phishingPatterns');
const { t, DEFAULT_LANG } = require('./i18n');

function scanFiles(attachments, lang = DEFAULT_LANG) {
  const results = [];

  for (const attachment of attachments) {
    const filename = attachment.name || '';
    const lowerFilename = filename.toLowerCase();
    const ext = path.extname(lowerFilename);

    // 1. 위험한 확장자 체크
    if (dangerousExtensions.includes(ext)) {
      results.push({
        isMalicious: true,
        confidence: 0.95,
        reason: t(lang, 'reason.fileDangerExt', { ext }),
        filename,
        source: 'extension',
      });
      continue;
    }

    // 2. 이중 확장자 체크 (예: document.pdf.exe)
    if (patterns.doubleExtension.test(lowerFilename)) {
      results.push({
        isMalicious: true,
        confidence: 0.95,
        reason: t(lang, 'reason.fileDoubleExt'),
        filename,
        source: 'double_extension',
      });
      continue;
    }

    // 3. 의심스러운 파일명 키워드 체크
    for (const keyword of patterns.suspiciousFilenameKeywords) {
      if (lowerFilename.includes(keyword)) {
        results.push({
          isMalicious: true,
          confidence: 0.8,
          reason: t(lang, 'reason.fileSuspName', { keyword }),
          filename,
          source: 'filename_keyword',
        });
        break;
      }
    }
  }

  return results;
}

module.exports = { scanFiles };
