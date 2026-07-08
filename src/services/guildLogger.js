/**
 * 서버(길드)별 로그 채널 전송 헬퍼.
 *
 * 관리자 DM은 모든 서버 통합 알림이지만, `/logs` 로 지정한 채널에는 그 서버의
 * 스캠/스팸 의심·삭제·허니팟 적발 로그만 출력한다. 채널 미설정이면 조용히 스킵.
 */
const logger = require('../utils/logger');
const guildConfigStore = require('./guildConfigStore');

async function logToGuild(client, guildId, payload) {
  const logId = guildId && guildConfigStore.getLogChannel(guildId);
  if (!logId) return;

  // /spamping 으로 지정한 역할/유저가 있으면 로그 메시지 상단에 멘션을 붙인다.
  const ping = guildConfigStore.getPingTarget(guildId);
  const finalPayload = ping
    ? {
        ...payload,
        content: payload.content ? `${ping}\n${payload.content}` : ping,
        allowedMentions: { parse: ['users', 'roles'] },
      }
    : payload;

  try {
    const ch = await client.channels.fetch(logId);
    if (ch && ch.isTextBased()) await ch.send(finalPayload);
  } catch (e) {
    logger.warn('서버 로그 채널 전송 실패', { error: e.message, channel: logId });
  }
}

module.exports = { logToGuild };
