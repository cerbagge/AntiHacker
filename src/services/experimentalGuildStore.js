/**
 * 실험 기능 적용 서버 목록 — 채팅 모더레이터(LLM 메시지 판정) 전용
 *
 * `experimentalGuilds.json`(루트, ["서버ID", ...])에 적힌 서버에서만 실험 기능이 동작한다.
 * allowedGuilds.json 과 달리 목록이 비어 있으면(=미설정) 어떤 서버에도 적용하지 않는다.
 * 실행 중에 파일을 고치면 2초 안에 다시 읽는다(재시작 불필요).
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const FILE_PATH = path.join(__dirname, '..', '..', 'experimentalGuilds.json');

let guilds = new Set();

function load() {
  try {
    if (fs.existsSync(FILE_PATH)) {
      const data = JSON.parse(fs.readFileSync(FILE_PATH, 'utf-8'));
      guilds = Array.isArray(data)
        ? new Set(data.map((x) => String(x).trim()).filter(Boolean))
        : new Set();
    } else {
      guilds = new Set();
    }
  } catch (e) {
    logger.warn('experimentalGuilds.json 로드 실패', { error: e.message });
    guilds = new Set();
  }
  return guilds;
}
load();

try {
  fs.watchFile(FILE_PATH, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs) return;
    load();
    logger.info(`실험 기능 서버 목록 변경 감지 — 현재 ${guilds.size}개`);
  });
} catch (e) {
  logger.warn('experimentalGuilds.json 감시 설정 실패', { error: e.message });
}

function isExperimental(guildId) {
  return !!guildId && guilds.has(String(guildId));
}

module.exports = { load, isExperimental, FILE_PATH };
