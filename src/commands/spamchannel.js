const { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } = require('discord.js');
const guildConfigStore = require('../services/guildConfigStore');
const { tl } = require('../services/i18n');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('spamchannel')
    .setDescription('Toggle the spam-trap (honeypot) channel. Any message posted there is treated as spam.')
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

    // 이미 그 채널이 함정으로 설정돼 있으면 → 토글 OFF(해제)
    if (guildConfigStore.getSpamChannel(guildId) === targetId) {
      guildConfigStore.setSpamChannel(guildId, null);
      return interaction.reply({
        content: await tl(lang, 'cmd.spamClear', { channel: `<#${targetId}>` }),
        flags: MessageFlags.Ephemeral,
      });
    }

    guildConfigStore.setSpamChannel(guildId, targetId);
    return interaction.reply({
      content: await tl(lang, 'cmd.spamSet', { channel: `<#${targetId}>` }),
      flags: MessageFlags.Ephemeral,
    });
  },
};
