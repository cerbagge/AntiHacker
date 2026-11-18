const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const guildConfigStore = require('../services/guildConfigStore');
const { tl } = require('../services/i18n');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('adguard')
    .setDescription('Block ads here: other-server Discord invites + AI-checked ad messages. Default off.')
    .addStringOption((o) =>
      o
        .setName('state')
        .setDescription('on = block ads, off = allow')
        .setRequired(true)
        .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction) {
    const on = interaction.options.getString('state') === 'on';
    guildConfigStore.setAdGuard(interaction.guildId, on);
    return interaction.reply({
      content: await tl(guildConfigStore.getLanguage(interaction.guildId), on ? 'cmd.adGuardOn' : 'cmd.adGuardOff'),
      flags: MessageFlags.Ephemeral,
    });
  },
};
