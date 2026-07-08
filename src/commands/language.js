const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const guildConfigStore = require('../services/guildConfigStore');
const { tl, SUPPORTED, LANGUAGES, LANG_LABEL, DEFAULT_LANG } = require('../services/i18n');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('language')
    .setDescription('Set the language for this server\'s log/alert output (en/ko native, others via Google Translate).')
    .addStringOption((o) =>
      o
        .setName('lang')
        .setDescription('Output language')
        .setRequired(true)
        .addChoices(...LANGUAGES.map((l) => ({ name: l.label, value: l.code }))))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction) {
    const lang = interaction.options.getString('lang');
    const chosen = SUPPORTED.includes(lang) ? lang : DEFAULT_LANG;
    guildConfigStore.setLanguage(interaction.guildId, chosen);
    return interaction.reply({
      content: await tl(chosen, 'cmd.langSet', { lang: LANG_LABEL[chosen] || chosen }),
      flags: MessageFlags.Ephemeral,
    });
  },
};
