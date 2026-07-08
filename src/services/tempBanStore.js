/**
 * 임시 밴(기간제 밴) 스케줄러.
 *
 * Discord 엔 임시 밴이 없어 봇이 직접 구현한다: `/spamsanction type:ban time:...` 로
 * 기간을 지정하면 밴을 걸 때 "해제 시각"을 기록하고, 주기 스케줄러가 그 시각을
 * 지나면 자동으로 unban 한다. 상태는 루트 JSON에 저장(재시작 복원).
 *
 * 저장 형식: tempBans.json
 *   { "<guildId>:<userId>": { guildId, userId, unbanAtMs } }
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const STORE_PATH = path.join(__dirname, '..', '..', 'tempBans.json');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1시간마다 점검
const UNBAN_REASON = 'antihacker+ 임시 밴 기간 만료 → 자동 해제';
const UNKNOWN_BAN = 10026; // 이미 밴이 아님(관리자 수동 해제 등)

let store = {};

function load() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
      store = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } else {
      store = {};
    }
  } catch (e) {
    logger.warn('tempBans.json 로드 실패', { error: e.message });
    store = {};
  }
  return store;
}
load();

function save() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  } catch (e) {
    logger.error('tempBans.json 저장 실패', { error: e.message });
  }
}

const keyOf = (guildId, userId) => `${guildId}:${userId}`;

/**
 * 임시 밴 등록. sanctionService 가 밴을 건 직후 호출한다.
 * @param {string} guildId
 * @param {string} userId
 * @param {number} unbanAtMs 자동 해제 절대 시각(ms)
 */
function register(guildId, userId, unbanAtMs) {
  store[keyOf(guildId, userId)] = { guildId, userId, unbanAtMs };
  save();
}

function remove(key) {
  if (store[key]) {
    delete store[key];
    save();
  }
}

/** 한 번의 점검 주기 — 해제 시각 지난 밴을 unban 한다. */
async function tick(client) {
  const now = Date.now();
  for (const [key, e] of Object.entries(store)) {
    if (now < e.unbanAtMs) continue; // 아직 기간 안 지남

    const guild = client.guilds.cache.get(e.guildId);
    if (!guild) continue; // 봇이 그 서버에 일시적으로 없을 수 있음 → 유지

    try {
      await guild.bans.remove(e.userId, UNBAN_REASON);
      remove(key);
      logger.info('임시 밴 자동 해제', { guild: guild.name, user: e.userId });
    } catch (err) {
      if (err?.code === UNKNOWN_BAN) {
        remove(key); // 이미 해제됨(관리자 수동 등) → 추적 정리
        logger.info('임시 밴 대상이 이미 해제됨 → 추적 정리', { guild: guild.name, user: e.userId });
      } else {
        // 권한 부족 등 → 다음 주기에 재시도
        logger.warn('임시 밴 자동 해제 실패(재시도 예정)', { guild: guild.name, user: e.userId, error: err.message });
      }
    }
  }
}

/** ready 이벤트에서 1회 호출. 시작 시 즉시 점검(다운타임 복원) 후 주기 실행. */
function startScheduler(client) {
  const run = () => tick(client).catch((e) => logger.warn('임시 밴 점검 오류', { error: e.message }));
  run();
  setInterval(run, CHECK_INTERVAL_MS).unref?.();
  logger.info(`임시 밴 자동 해제기 시작 — 추적 ${Object.keys(store).length}건, ${CHECK_INTERVAL_MS / 60000}분 주기`);
}

module.exports = { load, register, tick, startScheduler, STORE_PATH };
