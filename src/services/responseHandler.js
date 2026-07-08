const { EmbedBuilder } = require('discord.js');
const { getLevel } = require('../constants/dangerLevels');
const alertStore = require('./alertStore');
const guildLogger = require('./guildLogger');
const guildConfigStore = require('./guildConfigStore');
const { tl } = require('./i18n');
const logger = require('../utils/logger');

/**
 * 위험도 26% 이상이면 서버 로그 채널에 의심 알림 기록 (삭제 임계값 미만의 '의심' 건)
 */
async function handleResponse(message, dangerPercent, breakdown, analysisDetails) {
  const alert = alertStore.createAlert({
    guildId: message.guild?.id,
    channelId: message.channel.id,
    messageId: message.id,
    authorId: message.author.id,
    authorTag: message.author.tag,
    content: message.content || '',
    dangerPercent,
    breakdown,
    analysisDetails,
  });

  if (dangerPercent < 26) return alert.id;

  try {
    const lang = guildConfigStore.getLanguage(message.guild?.id);
    const reason = formatReason(analysisDetails);
    const messageLink = `https://discord.com/channels/${message.guild?.id}/${message.channel.id}/${message.id}`;
    const embed = new EmbedBuilder()
      .setTitle(await tl(lang, 'title.scam'))
      .setColor(0xfee75c)
      .setThumbnail(message.author.displayAvatarURL())
      .addFields(
        { name: await tl(lang, 'field.author'), value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
        { name: await tl(lang, 'field.channel'), value: `<#${message.channel.id}>`, inline: true },
        { name: await tl(lang, 'field.source'), value: messageLink },
      )
      .setTimestamp();

    await guildLogger.logToGuild(message.client, message.guild?.id, { embeds: [embed] });

    // 근거(reason)는 노출하지 않고 기록용으로만 — 서버 로그에 남긴다.
    logger.info(`알림 #${alert.id} 기록`, { author: message.author.tag, dangerPercent, reason });
  } catch (error) {
    logger.error('알림 기록 실패', { alertId: alert.id, error: error.message });
  }

  return alert.id;
}

/**
 * 감지 사유 포맷 (이미지/링크/파일/텍스트 분석 결과에서 추출)
 */
function formatReason(details) {
  if (!details) return '';
  const reasons = [];

  if (details.images) {
    for (const img of details.images) {
      if (img.dangerPercent > 0 && img.reason) reasons.push(`${img.originalName}: ${img.reason}`);
    }
  }
  if (details.links) {
    for (const link of details.links) {
      // URL은 백틱으로 감싸 실수 클릭 방지
      if (link.dangerPercent > 0 && link.reason) reasons.push(`\`${link.url}\`: ${link.reason}`);
    }
  }
  if (details.files) {
    for (const file of details.files) {
      if (file.dangerPercent > 0 && file.reason) reasons.push(`${file.originalName}: ${file.reason}`);
    }
  }
  if (details.text && details.text.dangerPercent > 0 && details.text.reason) {
    reasons.push(`${details.text.reason}`);
  }

  return reasons.length > 0 ? reasons.join('\n') : '';
}

/**
 * 수동 위험도 지정 + 피드백 + 학습 저장
 */
async function executeAction(client, alertId, assignedPercent, feedback) {
  const alert = alertStore.resolveAlert(alertId, assignedPercent);
  if (!alert) return null;

  if (feedback) {
    alert.feedback = feedback;
  }

  const levelInfo = getLevel(assignedPercent);

  logger.info(`알림 #${alertId} 위험도 지정`, {
    assignedPercent,
    label: levelInfo.label,
    feedback: feedback || null,
  });
  return { ...alert, savedCount: 0 };
}

module.exports = { handleResponse, executeAction };
