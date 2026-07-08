const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, Role } = require('discord.js');
const guildConfigStore = require('../services/guildConfigStore');
const { tl } = require('../services/i18n');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('spamping')
    .setDescription('Set the role/user pinged on every log message. Empty or the same target turns it off.')
    .addMentionableOption((o) =>
      o
        .setName('roll')
        .setDescription('Role or user to ping. Leave empty to turn pinging off.')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction) {
    const guildId = interaction.guildId;
    const lang = guildConfigStore.getLanguage(guildId);

    const target = interaction.options.getMentionable('roll');
    // 대상 미지정 → 핑 해제
    if (!target) {
      guildConfigStore.setPingTarget(guildId, null);
      return interaction.reply({
        content: await tl(lang, 'cmd.pingClear'),
        flags: MessageFlags.Ephemeral,
      });
    }

    const mention = target instanceof Role ? `<@&${target.id}>` : `<@${target.id}>`;

    // 이미 같은 대상이면 → 토글 OFF
    if (guildConfigStore.getPingTarget(guildId) === mention) {
      guildConfigStore.setPingTarget(guildId, null);
      return interaction.reply({
        content: await tl(lang, 'cmd.pingClear'),
        flags: MessageFlags.Ephemeral,
      });
    }

    guildConfigStore.setPingTarget(guildId, mention);
    return interaction.reply({
      content: await tl(lang, 'cmd.pingSet', { target: mention }),
      flags: MessageFlags.Ephemeral,
      // 설정 확인 메시지에서는 실제로 멘션이 울리지 않도록
      allowedMentions: { parse: [] },
    });
  },
};
