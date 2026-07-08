/**
 * 서버(길드) 허용목록 — 봇 무단 사용 방지
 *
 * `allowedGuilds.json`(루트, ["서버ID", ...])에 등록된 서버에서만 봇이 작동한다.
 * 페일세이프: 목록이 비어 있으면(=미설정) 잠금을 끈다(모든 서버 허용). 실수로 자기
 * 서버에서 봇이 쫓겨나는 것을 막기 위함. 서버 ID를 하나라도 넣으면 잠금이 켜진다.
 *
 * 저장 컨벤션은 optoutStore.js 와 동일(루트 JSON). 런타임 편집 감지를 위해 watchFile 제공.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const ALLOW_PATH = path.join(__dirname, '..', '..', 'allowedGuilds.json');

let allowed = new Set();

function load() {
  try {
    if (fs.existsSync(ALLOW_PATH)) {
      const data = JSON.parse(fs.readFileSync(ALLOW_PATH, 'utf-8'));
      allowed = Array.isArray(data)
        ? new Set(data.map((x) => String(x).trim()).filter(Boolean))
        : new Set();
    } else {
      allowed = new Set();
    }
  } catch (e) {
    logger.warn('allowedGuilds.json 로드 실패', { error: e.message });
    allowed = new Set();
  }
  return allowed;
}
load();

// 목록이 비어 있으면 잠금 비활성(페일세이프)
function isEnabled() {
  return allowed.size > 0;
}

function isAllowed(guildId) {
  return !isEnabled() || allowed.has(String(guildId));
}

function getAll() {
  return [...allowed];
}

/** 파일이 런타임에 바뀌면 재로드 후 콜백 (서버 ID 삭제 시 해당 서버에서 나가도록) */
function watch(onChange) {
  try {
    fs.watchFile(ALLOW_PATH, { interval: 2000 }, (curr, prev) => {
      if (curr.mtimeMs === prev.mtimeMs) return;
      load();
      logger.info(`허용 서버 목록 변경 감지 — 현재 ${allowed.size}개`);
      if (onChange) onChange();
    });
  } catch (e) {
    logger.warn('allowedGuilds.json 감시 설정 실패', { error: e.message });
  }
}

module.exports = { load, isEnabled, isAllowed, getAll, watch, ALLOW_PATH };
