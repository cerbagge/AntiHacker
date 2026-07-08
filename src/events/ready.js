const { REST, Routes, ActivityType } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const messages = require('../utils/messages');
const commandModules = require('../commands');
const timeoutRenewer = require('../services/timeoutRenewer');
const tempBanStore = require('../services/tempBanStore');
const statsStore = require('../services/statsStore');

const PRESENCE_REFRESH_MS = 60 * 1000; // 서버 수·탐지 수 반영 주기

// 봇 상태(활동)를 "n개의 서버 감시 중 | m개의 스팸 계정 탐지 완료" 로 갱신
function updatePresence(client) {
  const n = client.guilds.cache.size;
  const m = statsStore.getDetections();
  const text = `${n}개의 서버 감시 중 | ${m}개의 스팸 계정 탐지 완료`;
  try {
    client.user.setPresence({
      activities: [{ name: text, type: ActivityType.Custom, state: text }],
      status: 'online',
    });
  } catch (e) {
    logger.warn('봇 상태 갱신 실패', { error: e.message });
  }
  return text;
}

module.exports = (client) => {
  client.on('ready', async () => {
    logger.info(`${messages.BOT_READY} ${client.user.tag} | ${client.guilds.cache.size}개 서버`);

    // 28일 초과 타임아웃 자동 갱신기 + 임시 밴 자동 해제기 — 재시작 복원 후 주기 점검 시작
    timeoutRenewer.startScheduler(client);
    tempBanStore.startScheduler(client);

    // 봇 상태 표시 — 최초 설정 + 주기 갱신(서버 수/누적 탐지 수 반영)
    const presenceText = updatePresence(client);
    logger.info(`봇 상태 설정: ${presenceText}`);
    setInterval(() => updatePresence(client), PRESENCE_REFRESH_MS);

    // 참여 중인 서버 목록 출력
    client.guilds.cache.forEach((guild) => {
      logger.info(`  ├ ${guild.name} (ID: ${guild.id}) — ${guild.memberCount}명`);
    });

    // 로컬 스캠 이미지 감지 상태 (RAM 업그레이드 전엔 OFF 권장)
    logger.info(
      config.SCAM_IMAGE_GUARD_ENABLED
        ? '로컬 스캠 이미지 감지: ON'
        : '로컬 스캠 이미지 감지: OFF — 활성화하려면 .env 에 SCAM_IMAGE_GUARD_ENABLED=true (RAM 업그레이드 후 권장)'
    );

    // 슬래시 명령 등록 (/spamchannel, /logs) — 전역 등록
    try {
      const rest = new REST({ version: '10' }).setToken(config.DISCORD_BOT_TOKEN);
      const body = commandModules.map((c) => c.data.toJSON());
      await rest.put(Routes.applicationCommands(client.user.id), { body });
      logger.info(`슬래시 명령 ${body.length}개 등록 완료: ${body.map((c) => '/' + c.name).join(', ')}`);
    } catch (e) {
      logger.error('슬래시 명령 등록 실패', { error: e.message });
    }
  });
};
