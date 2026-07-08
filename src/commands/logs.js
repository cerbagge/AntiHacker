const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const guildConfigStore = require('../services/guildConfigStore');
const { tl } = require('../services/i18n');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('spamlog')
    .setDescription('Toggle this server\'s log channel for spam/scam detections and honeypot hits.')
    .addChannelOption((o) =>
      o
        .setName('channel')
        .setDescription('Target channel. Leave empty to use THIS channel; run again to turn it off.')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction) {
    const guildId = interaction.guildId;
    const lang = guildConfigStore.getLanguage(guildId);
    // channel 생략 시 → 명령을 친 현재 채널이 대상
    const targetId = interaction.options.getChannel('channel')?.id || interaction.channelId;

    // 이미 그 채널이 로그 채널이면 → 토글 OFF(해제)
    if (guildConfigStore.getLogChannel(guildId) === targetId) {
      guildConfigStore.setLogChannel(guildId, null);
      return interaction.reply({
        content: await tl(lang, 'cmd.logClear', { channel: `<#${targetId}>` }),
        flags: MessageFlags.Ephemeral,
      });
    }

    guildConfigStore.setLogChannel(guildId, targetId);
    return interaction.reply({
      content: await tl(lang, 'cmd.logSet', { channel: `<#${targetId}>` }),
      flags: MessageFlags.Ephemeral,
    });
  },
};
