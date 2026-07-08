const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const guildConfigStore = require('../services/guildConfigStore');
const { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } = require('../services/sanctionService');
const { parseDuration, humanizeDuration } = require('../utils/duration');
const { tl } = require('../services/i18n');

const TYPES = ['timeout', 'kick', 'ban', 'none'];

module.exports = {
  data: new SlashCommandBuilder()
    // 슬래시 명령 이름은 소문자만 허용 → spamsanction
    .setName('spamsanction')
    .setDescription('How the bot handles a user it flags: timeout / kick / ban / none.')
    .addStringOption((o) =>
      o
        .setName('type')
        .setDescription('Sanction to apply on auto-removed users')
        .setRequired(true)
        .addChoices(
          { name: 'timeout', value: 'timeout' },
          { name: 'kick', value: 'kick' },
          { name: 'ban', value: 'ban' },
          { name: 'none', value: 'none' },
        ))
    .addStringOption((o) =>
      o
        .setName('time')
        .setDescription('Duration, e.g. 4h3m13s — Y(year) M(month) h(hour) m(min) s(sec). For timeout & ban (ban=temp).')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  async execute(interaction) {
    const guildId = interaction.guildId;
    const lang = guildConfigStore.getLanguage(guildId);
    const type = interaction.options.getString('type');
    const timeStr = interaction.options.getString('time');

    if (!TYPES.includes(type) || type === 'none') {
      guildConfigStore.setSanction(guildId, 'none', 0);
      return interaction.reply({
        content: await tl(lang, 'cmd.sanctionNone'),
        flags: MessageFlags.Ephemeral,
      });
    }

    // time 은 timeout/ban 에서만 의미 있음(kick 은 무시). 지정됐는데 파싱 실패면 거부.
    let durationMs = 0;
    if (timeStr) {
      durationMs = parseDuration(timeStr);
      if (durationMs === null) {
        return interaction.reply({
          content: await tl(lang, 'cmd.sanctionBadTime', { time: timeStr }),
          flags: MessageFlags.Ephemeral,
        });
      }
    }

    const storedMs = type === 'timeout' || type === 'ban' ? durationMs : 0;
    guildConfigStore.setSanction(guildId, type, storedMs);

    // 확인 메시지의 기간 라벨:
    //  - timeout: time 미지정 시 기본 1시간, 28일 초과면 자동 갱신 안내
    //  - ban: time 있으면 임시 밴(만료 후 자동 해제), 없으면 영구 밴
    let durLabel = '';
    if (type === 'timeout') {
      const eff = durationMs || DEFAULT_TIMEOUT_MS;
      const renew = eff > MAX_TIMEOUT_MS ? await tl(lang, 'cmd.sanctionRenewNote') : '';
      durLabel = ` (${humanizeDuration(eff)})${renew}`;
    } else if (type === 'ban') {
      durLabel =
        durationMs > 0
          ? ` (${humanizeDuration(durationMs)}${await tl(lang, 'cmd.sanctionUnbanNote')})`
          : ` (${await tl(lang, 'cmd.sanctionPermanent')})`;
    }
    return interaction.reply({
      content: await tl(lang, 'cmd.sanctionSet', { type, dur: durLabel }),
      flags: MessageFlags.Ephemeral,
    });
  },
};
