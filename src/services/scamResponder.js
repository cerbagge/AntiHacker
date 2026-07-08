/**
 * 스캠/바이러스/허니팟 대응 — 메시지 삭제 + 서버 로그 채널 출력.
 * 모든 알림 문구는 그 서버의 언어(/language)로 출력한다.
 *  - en/ko : 손으로 쓴 언어팩 (즉시)
 *  - 그 외 : 영어 베이스를 Google 번역(MT, 캐시). 번역 불가 시 영어 폴백.
 */
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const config = require('../config');
const logger = require('../utils/logger');
const alertStore = require('./alertStore');
const guildLogger = require('./guildLogger');
const guildConfigStore = require('./guildConfigStore');
const spamSweeper = require('./spamSweeper');
const sanctionService = require('./sanctionService');
const { humanizeDuration } = require('../utils/duration');
const { tl } = require('./i18n');

const ZWSP = '​'; // 빈 필드명용 제로폭 공백

/** 삭제 실패 시 "메시지 관리 권한 필요" 경고(굵게)를 하단에 추가 */
async function addNoPermNotice(embed, deleted, lang) {
  if (!deleted) embed.addFields({ name: ZWSP, value: `**${await tl(lang, 'notice.noPerm')}**` });
  return embed;
}

/**
 * `/spamsanction` 설정에 따라 작성자를 제재하고 결과를 임베드 필드로 남긴다.
 * type=none/미설정이면 아무 필드도 추가하지 않는다.
 */
async function addSanctionField(embed, message, lang) {
  const result = await sanctionService.applySanction(message);
  if (!result) return embed;

  let value;
  if (result.ok) {
    if (result.type === 'timeout') {
      const key = result.renewed ? 'sanction.timeoutRenew' : 'sanction.timeout';
      value = await tl(lang, key, { dur: humanizeDuration(result.durationMs) });
    } else if (result.type === 'ban' && result.durationMs > 0) {
      value = await tl(lang, 'sanction.banTemp', { dur: humanizeDuration(result.durationMs) });
    } else {
      value = await tl(lang, `sanction.${result.type}`);
    }
  } else {
    const key =
      result.skipped === 'gone'
        ? 'sanction.failGone'
        : result.skipped === 'perm'
          ? 'sanction.failPerm'
          : 'sanction.failErr';
    value = await tl(lang, key, { action: result.type });
  }
  embed.addFields({ name: await tl(lang, 'field.sanction'), value });
  return embed;
}

async function buildScamEmbed(message, trigger, deleted, lang) {
  const embed = new EmbedBuilder()
    .setTitle(await tl(lang, 'title.scam'))
    .setColor(deleted ? 0xed4245 : 0xfee75c)
    .setThumbnail(message.author.displayAvatarURL())
    .addFields(
      { name: await tl(lang, 'field.author'), value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
      { name: await tl(lang, 'field.channel'), value: `<#${message.channel.id}>`, inline: true },
    )
    .setTimestamp();
  // 근거(trigger.reason)는 노출하지 않고 기록용으로만 — logger.warn + alertStore 에 남는다.
  return addNoPermNotice(embed, deleted, lang);
}

/**
 * 고신뢰 코인 스캠 이미지 → 삭제 + 서버 로그 채널.
 * @returns {Promise<number>} alert id
 */
async function handleScamDelete(message, scanResult) {
  const trigger = scanResult.trigger;
  const lang = guildConfigStore.getLanguage(message.guild?.id);

  let deleted = false;
  try {
    await message.delete();
    deleted = true;
  } catch (e) {
    logger.error('스캠 메시지 삭제 실패 (Manage Messages 권한 확인)', { error: e.message, guild: message.guild?.name });
  }

  const alert = alertStore.createAlert({
    guildId: message.guild?.id,
    channelId: message.channel.id,
    messageId: message.id,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content || '',
    dangerPercent: trigger.dangerPercent,
    breakdown: { A: 0, V: 0, H: 0, P: 0, S: 100 },
    analysisDetails: { scam: trigger },
  });

  logger.warn(`코인 스캠 이미지 ${deleted ? '삭제' : '감지(삭제실패)'} #${alert.id}`, {
    author: message.author.tag,
    danger: trigger.dangerPercent,
    signals: trigger.signals,
    reason: trigger.reason,
    source: trigger.source,
  });

  const embed = await buildScamEmbed(message, trigger, deleted, lang);
  await addSanctionField(embed, message, lang);
  // 첨부는 전송할 때마다 새로 생성(스트림 재사용 문제 방지)
  const makeFiles = () =>
    trigger.buffer ? [new AttachmentBuilder(trigger.buffer, { name: `scam_${trigger.attachmentName || 'image'}` })] : [];

  if (config.SCAM_LOG_CHANNEL_ID) {
    try {
      const ch = await message.client.channels.fetch(config.SCAM_LOG_CHANNEL_ID);
      if (ch && ch.isTextBased()) await ch.send({ embeds: [embed], files: makeFiles() });
    } catch (e) {
      logger.warn('스캠 로그 채널 전송 실패', { error: e.message, channel: config.SCAM_LOG_CHANNEL_ID });
    }
  }
  await guildLogger.logToGuild(message.client, message.guild?.id, { embeds: [embed], files: makeFiles() });

  return alert.id;
}

/**
 * 바이러스 첨부 → 삭제 + 서버 로그 채널. 감염 파일은 재업로드하지 않는다.
 * @returns {Promise<number>} alert id
 */
async function handleVirusDelete(message, attachment, scan) {
  const lang = guildConfigStore.getLanguage(message.guild?.id);

  let deleted = false;
  try {
    await message.delete();
    deleted = true;
  } catch (e) {
    logger.error('바이러스 메시지 삭제 실패 (Manage Messages 권한 확인)', { error: e.message, guild: message.guild?.name });
  }

  const alert = alertStore.createAlert({
    guildId: message.guild?.id,
    channelId: message.channel.id,
    messageId: message.id,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content || '',
    dangerPercent: 100,
    breakdown: { A: 0, V: 0, H: 0, P: 0, S: 100 },
    analysisDetails: { virus: { file: attachment.name, signatures: scan.signatures || [] } },
  });

  logger.warn(`바이러스 첨부 ${deleted ? '삭제' : '감지(삭제실패)'} #${alert.id}`, {
    author: message.author.tag,
    file: attachment.name,
    signatures: scan.signatures,
  });

  const embed = new EmbedBuilder()
    .setTitle(await tl(lang, 'title.virus'))
    .setColor(0xed4245)
    .setThumbnail(message.author.displayAvatarURL())
    .addFields(
      { name: await tl(lang, 'field.author'), value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
      { name: await tl(lang, 'field.channel'), value: `<#${message.channel.id}>`, inline: true },
      { name: await tl(lang, 'field.file'), value: (attachment.name || '-').slice(0, 256), inline: true },
    )
    .setTimestamp();
  await addNoPermNotice(embed, deleted, lang);
  await addSanctionField(embed, message, lang);

  if (config.SCAM_LOG_CHANNEL_ID) {
    try {
      const ch = await message.client.channels.fetch(config.SCAM_LOG_CHANNEL_ID);
      if (ch && ch.isTextBased()) await ch.send({ embeds: [embed] });
    } catch (e) {
      logger.warn('바이러스 로그 채널 전송 실패', { error: e.message });
    }
  }
  await guildLogger.logToGuild(message.client, message.guild?.id, { embeds: [embed] });

  return alert.id;
}

/**
 * 허니팟(스팸 함정) 채널 적발 → 삭제 + 서버 로그 채널.
 * @returns {Promise<number>} alert id
 */
async function handleHoneypot(message) {
  const lang = guildConfigStore.getLanguage(message.guild?.id);

  let deleted = false;
  try {
    await message.delete();
    deleted = true;
  } catch (e) {
    logger.error('허니팟 메시지 삭제 실패 (Manage Messages 권한 확인)', { error: e.message, guild: message.guild?.name });
  }

  const alert = alertStore.createAlert({
    guildId: message.guild?.id,
    channelId: message.channel.id,
    messageId: message.id,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content || '',
    dangerPercent: 100,
    breakdown: { A: 0, V: 0, H: 0, P: 0, S: 100 },
    analysisDetails: { honeypot: true },
  });

  logger.warn(`허니팟 적발 ${deleted ? '삭제' : '감지(삭제실패)'} #${alert.id}`, {
    author: message.author.tag,
    channel: message.channel.id,
  });

  // ── 연관 스팸 스윕 ──
  // 허니팟에 걸린 유저는 도배봇으로 본다 → 같은 유저가 비슷한 시간대/내용으로
  // 다른 채널에 뿌린 메시지까지 서버 전역에서 함께 삭제. (실패해도 본 처리에는 영향 없음)
  let sweep = null;
  if (config.SPAM_SWEEP_ENABLED && message.guild) {
    try {
      sweep = await spamSweeper.sweepRelatedMessages(message, {
        windowMs: config.SPAM_SWEEP_WINDOW_MS,
        similarity: config.SPAM_SWEEP_SIMILARITY,
      });
      if (sweep.deleted > 0) {
        logger.warn(`연관 스팸 스윕 ${sweep.deleted}건 삭제 #${alert.id}`, {
          author: message.author.tag,
          byTime: sweep.byTime,
          byContent: sweep.byContent,
          channels: sweep.channels,
        });
      }
    } catch (e) {
      logger.warn('연관 스팸 스윕 실패', { error: e.message, guild: message.guild?.name });
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(await tl(lang, 'title.honeypot'))
    .setColor(0xed4245)
    .setThumbnail(message.author.displayAvatarURL())
    .addFields(
      { name: await tl(lang, 'field.author'), value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
      { name: await tl(lang, 'field.channel'), value: `<#${message.channel.id}>`, inline: true },
      { name: await tl(lang, 'field.content'), value: (message.content || (await tl(lang, 'content.none'))).slice(0, 1024) },
    )
    .setTimestamp();
  if (sweep && sweep.deleted > 0) {
    embed.addFields({
      name: await tl(lang, 'field.swept'),
      value: await tl(lang, 'sweep.summary', { total: sweep.deleted, time: sweep.byTime, content: sweep.byContent, channels: sweep.channels }),
    });
  }
  await addNoPermNotice(embed, deleted, lang);
  await addSanctionField(embed, message, lang);

  await guildLogger.logToGuild(message.client, message.guild?.id, { embeds: [embed] });

  return alert.id;
}

/**
 * NSFW/스팸 디스코드 서버 초대 → 삭제 + 서버 로그 채널.
 * @param {import('discord.js').Message} message
 * @param {{guildName:string, kind:string, source:string, reason:string, confidence:number}} verdict
 * @returns {Promise<number>} alert id
 */
async function handleNsfwInviteDelete(message, verdict) {
  const lang = guildConfigStore.getLanguage(message.guild?.id);

  let deleted = false;
  try {
    await message.delete();
    deleted = true;
  } catch (e) {
    logger.error('NSFW 초대 메시지 삭제 실패 (Manage Messages 권한 확인)', { error: e.message, guild: message.guild?.name });
  }

  const alert = alertStore.createAlert({
    guildId: message.guild?.id,
    channelId: message.channel.id,
    messageId: message.id,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content || '',
    dangerPercent: 100,
    breakdown: { A: 0, V: 0, H: 0, P: 0, S: 100 },
    analysisDetails: { invite: { server: verdict.guildName, kind: verdict.kind, source: verdict.source } },
  });

  logger.warn(`NSFW/스팸 서버 초대 ${deleted ? '삭제' : '감지(삭제실패)'} #${alert.id}`, {
    author: message.author.tag,
    server: verdict.guildName,
    kind: verdict.kind,
    source: verdict.source,
    confidence: verdict.confidence,
    reason: verdict.reason,
  });

  const isChannelLink = verdict.linkKind === 'channel' || verdict.linkKind === 'dm';
  const embed = new EmbedBuilder()
    .setTitle(await tl(lang, isChannelLink ? 'title.channelLink' : 'title.invite'))
    .setColor(0xed4245)
    .setThumbnail(message.author.displayAvatarURL())
    .addFields(
      { name: await tl(lang, 'field.author'), value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
      { name: await tl(lang, 'field.channel'), value: `<#${message.channel.id}>`, inline: true },
      { name: await tl(lang, 'field.server'), value: (verdict.guildName || '-').slice(0, 256), inline: true },
    )
    .setTimestamp();
  await addNoPermNotice(embed, deleted, lang);
  await addSanctionField(embed, message, lang);

  if (config.SCAM_LOG_CHANNEL_ID) {
    try {
      const ch = await message.client.channels.fetch(config.SCAM_LOG_CHANNEL_ID);
      if (ch && ch.isTextBased()) await ch.send({ embeds: [embed] });
    } catch (e) {
      logger.warn('NSFW 초대 로그 채널 전송 실패', { error: e.message });
    }
  }
  await guildLogger.logToGuild(message.client, message.guild?.id, { embeds: [embed] });

  return alert.id;
}

module.exports = { handleScamDelete, handleVirusDelete, handleHoneypot, handleNsfwInviteDelete };
