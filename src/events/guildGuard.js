/**
 * 서버 잠금 가드 — 허용목록에 없는 서버에서 자동 퇴장
 *
 *  - 시작 시(ready): 현재 참여 중인 서버 중 비허용 서버에서 모두 나감
 *  - 초대 시(guildCreate): 비허용 서버면 즉시 나감
 *  - 목록 변경 시(watch): 방금 목록에서 빠진 서버에서 나감
 *
 * 허용목록이 비어 있으면(미설정) 아무 것도 하지 않음(페일세이프).
 */
const store = require('../services/guildAllowlistStore');
const logger = require('../utils/logger');

async function leaveIfNotAllowed(guild, reason) {
  if (store.isAllowed(guild.id)) return false;
  logger.warn(`${reason} — 비허용 서버 퇴장: ${guild.name} (${guild.id})`);
  try {
    await guild.leave();
  } catch (e) {
    logger.error('서버 퇴장 실패', { id: guild.id, error: e.message });
  }
  return true;
}

async function enforceAll(client) {
  if (!store.isEnabled()) {
    logger.warn('서버 허용목록이 비어 있어 서버 잠금 비활성 — allowedGuilds.json 에 서버 ID를 넣으면 활성화됩니다.');
    return;
  }
  let left = 0;
  for (const guild of client.guilds.cache.values()) {
    if (await leaveIfNotAllowed(guild, '시작 점검')) left++;
  }
  logger.info(`서버 잠금 적용 — 허용 ${store.getAll().length}개 | 이번에 퇴장 ${left}개 | 현재 참여 ${client.guilds.cache.size}개`);
}

module.exports = (client) => {
  client.on('ready', () => {
    enforceAll(client);
  });

  client.on('guildCreate', async (guild) => {
    if (!store.isEnabled()) {
      logger.info(`새 서버 참여(허용목록 비활성): ${guild.name} (${guild.id})`);
      return;
    }
    const left = await leaveIfNotAllowed(guild, '초대 차단');
    if (!left) logger.info(`허용 서버 참여: ${guild.name} (${guild.id})`);
  });

  // 목록이 런타임에 바뀌면(서버 ID 삭제 등) 즉시 재점검 → 빠진 서버에서 나감
  store.watch(() => enforceAll(client));
};
