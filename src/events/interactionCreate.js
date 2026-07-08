const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const logger = require('../utils/logger');
const commandModules = require('../commands');
const guildConfigStore = require('../services/guildConfigStore');
const { tl } = require('../services/i18n');

const commands = new Map(commandModules.map((c) => [c.data.name, c]));

module.exports = (client) => {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const cmd = commands.get(interaction.commandName);
    if (!cmd) return;

    // 모든 명령은 관리자(Administrator) 전용 — 길드 밖/권한 없는 사용자 차단
    // (setDefaultMemberPermissions 의 UI 기본값을 서버설정에서 바꿔도 여기서 한 번 더 막는다)
    if (!interaction.inGuild() || !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({
        content: await tl(guildConfigStore.getLanguage(interaction.guildId), 'cmd.adminOnly'),
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      await cmd.execute(interaction);
    } catch (e) {
      logger.error('슬래시 명령 처리 실패', { command: interaction.commandName, error: e.message });
      if (interaction.deferred || interaction.replied) return;
      interaction
        .reply({ content: '명령 처리 중 오류가 발생했습니다.', flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  });
};
