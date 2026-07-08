/**
 * 28일 초과 타임아웃 자동 갱신기.
 *
 * Discord 타임아웃(Communication Disabled)은 API 상 최대 28일이라, 그 이상을
 * 지정하면 28일 단위로 재적용해 목표 기간까지 이어붙인다. 상태는 루트 JSON에
 * 저장(재시작 복원)하고, 주기 스케줄러가 만료 직전에 재적용한다.
 *
 * 저장 형식: timeoutRenewals.json
 *   { "<guildId>:<userId>": { guildId, userId, targetEndMs, appliedUntilMs } }
 *    - targetEndMs   : 최종적으로 타임아웃이 끝나야 하는 절대 시각(ms)
 *    - appliedUntilMs: 지금 걸어둔 28일 조각이 끝나는 절대 시각(ms)
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const STORE_PATH = path.join(__dirname, '..', '..', 'timeoutRenewals.json');

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // Discord 타임아웃 최대 28일
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1시간마다 점검
const RENEW_BUFFER_MS = 2 * 60 * 60 * 1000; // 조각 만료 2시간 전에 미리 갱신
const RENEW_REASON = 'antihacker+ 장기 타임아웃 자동 갱신';

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
    logger.warn('timeoutRenewals.json 로드 실패', { error: e.message });
    store = {};
  }
  return store;
}
load();

function save() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  } catch (e) {
    logger.error('timeoutRenewals.json 저장 실패', { error: e.message });
  }
}

const keyOf = (guildId, userId) => `${guildId}:${userId}`;

/**
 * 장기 타임아웃 추적 등록. sanctionService 가 첫 28일 조각을 건 직후 호출한다.
 * @param {string} guildId
 * @param {string} userId
 * @param {number} targetEndMs   최종 종료 절대 시각(ms)
 * @param {number} appliedUntilMs 방금 건 조각의 종료 절대 시각(ms)
 */
function register(guildId, userId, targetEndMs, appliedUntilMs) {
  store[keyOf(guildId, userId)] = { guildId, userId, targetEndMs, appliedUntilMs };
  save();
}

function remove(key) {
  if (store[key]) {
    delete store[key];
    save();
  }
}

/**
 * 한 번의 점검 주기 — 목표 도달 정리, 만료 임박 건 재적용, 관리자 수동해제 취소.
 */
async function tick(client) {
  const now = Date.now();
  for (const [key, e] of Object.entries(store)) {
    // 목표 기간 도달 → 추적 종료(남은 타임아웃은 자연 만료되게 둔다)
    if (now >= e.targetEndMs) {
      remove(key);
      continue;
    }

    const guild = client.guilds.cache.get(e.guildId);
    if (!guild) continue; // 봇이 그 서버에 일시적으로 없을 수 있음 → 유지

    const member = await guild.members.fetch(e.userId).catch(() => null);
    if (!member) {
      remove(key); // 서버를 나감
      continue;
    }

    const disabledUntil = member.communicationDisabledUntilTimestamp || 0;
    const stillTimedOut = disabledUntil > now;
    const atBoundary = now >= e.appliedUntilMs - RENEW_BUFFER_MS;

    if (atBoundary) {
      if (!member.moderatable) {
        // 봇 권한/서열 상실 → 더는 갱신 불가, 추적 포기
        logger.warn('타임아웃 갱신 포기 (권한 없음)', { guild: guild.name, user: member.user?.tag });
        remove(key);
        continue;
      }
      const remaining = e.targetEndMs - now;
      const chunk = Math.min(remaining, MAX_TIMEOUT_MS);
      try {
        await member.timeout(chunk, RENEW_REASON);
        e.appliedUntilMs = now + chunk;
        save();
        logger.info('타임아웃 자동 갱신', {
          guild: guild.name,
          user: member.user?.tag,
          remainingDays: Math.round(remaining / 86400000),
        });
      } catch (err) {
        logger.warn('타임아웃 갱신 실패', { guild: guild.name, user: member.user?.tag, error: err.message });
      }
    } else if (!stillTimedOut) {
      // 아직 갱신 시점이 아닌데 이미 풀렸다 → 관리자가 수동 해제 → 자동 갱신 취소
      remove(key);
      logger.info('타임아웃 수동 해제 감지 → 자동 갱신 취소', { guild: guild.name, user: member.user?.tag });
    }
  }
}

/**
 * ready 이벤트에서 1회 호출. 시작 시 즉시 한 번 점검(다운타임 복원) 후 주기 실행.
 */
function startScheduler(client) {
  const run = () => tick(client).catch((e) => logger.warn('타임아웃 갱신 점검 오류', { error: e.message }));
  run();
  setInterval(run, CHECK_INTERVAL_MS).unref?.();
  const count = Object.keys(store).length;
  logger.info(`장기 타임아웃 자동 갱신기 시작 — 추적 ${count}건, ${CHECK_INTERVAL_MS / 60000}분 주기`);
}

module.exports = { load, register, tick, startScheduler, MAX_TIMEOUT_MS, STORE_PATH };
