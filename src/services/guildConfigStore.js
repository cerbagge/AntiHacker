/**
 * 서버(길드)별 설정 저장소 — 허니팟(스팸 함정) 채널 + 로그 채널
 *
 * `guildConfig.json`(루트): { "<guildId>": { "spamChannelId": "...", "logChannelId": "..." } }
 * 저장 컨벤션은 optoutStore / guildAllowlistStore 와 동일(루트 JSON, sync load/save).
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { DEFAULT_LANG } = require('./i18n');

const CONFIG_PATH = path.join(__dirname, '..', '..', 'guildConfig.json');

let store = {};

function load() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      store = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } else {
      store = {};
    }
  } catch (e) {
    logger.warn('guildConfig.json 로드 실패', { error: e.message });
    store = {};
  }
  return store;
}
load();

function save() {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(store, null, 2));
  } catch (e) {
    logger.error('guildConfig.json 저장 실패', { error: e.message });
  }
}

function setField(guildId, field, value) {
  const gid = String(guildId);
  if (!store[gid]) store[gid] = {};
  if (value) store[gid][field] = String(value);
  else delete store[gid][field];
  if (Object.keys(store[gid]).length === 0) delete store[gid]; // 빈 객체 정리
  save();
}

const get = (guildId) => store[String(guildId)] || {};

module.exports = {
  load,
  CONFIG_PATH,
  getSpamChannel: (g) => get(g).spamChannelId || null,
  getLogChannel: (g) => get(g).logChannelId || null,
  getLanguage: (g) => get(g).language || DEFAULT_LANG,
  setSpamChannel: (g, c) => setField(g, 'spamChannelId', c),
  setLogChannel: (g, c) => setField(g, 'logChannelId', c),
  setLanguage: (g, lang) => setField(g, 'language', lang),
  // 로그 메시지에 붙일 핑 대상(역할/유저 멘션 문자열, 예: "<@&123>" / "<@123>")
  getPingTarget: (g) => get(g).pingTarget || null,
  setPingTarget: (g, mention) => setField(g, 'pingTarget', mention),
  // 자동 제재: type(timeout/kick/ban/none) + durationMs(타임아웃 전용)
  getSanction: (g) => ({
    type: get(g).sanctionType || 'none',
    durationMs: Number(get(g).sanctionMs) || 0,
  }),
  setSanction: (g, type, durationMs) => {
    setField(g, 'sanctionType', type && type !== 'none' ? type : null);
    setField(g, 'sanctionMs', durationMs || null);
  },
};
