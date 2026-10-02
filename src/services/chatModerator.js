/**
 * 채팅 모더레이터 (실험 기능) — experimentalGuilds.json 에 적힌 서버에서만 동작
 *
 * 채널별 최근 6줄을 기억해 두고, 새 메시지가 오면 그 6줄 흐름을 로컬 LLM에 보내 마지막 줄을 판정한다.
 *  - confidence ≥ 0.9 : 메시지 삭제 + 10분 타임아웃
 *  - 자해·자살은 0.7 이상이면 타임아웃 대신 삭제 + 도움 안내 DM + 관리자에게 돌봄 요청
 *    (처벌이 아니라 안내라서 놓치는 쪽이 더 위험 — 실측에서 "약 다 먹고 끝낼거야"가 0.8로 나옴)
 *  - 그 외 0.7 ≤ conf < 0.9 : 조치 없이 로그에 '의심'으로만 남김
 * 로그 채널에는 원문 대신 LLM 요약 + 참여자 + 처벌 결과만 출력한다. (서버 로그에도 원문을 남기지 않음)
 *
 * LLM은 CPU에서 메시지당 수 초 걸리므로 한 번에 하나씩 순서대로 처리하고, 밀린 메시지가
 * 너무 많으면 새 메시지 검사는 건너뛴다(fail-open). 메시지 처리 흐름(스캠 검사 등)은 막지 않는다.
 */
const { EmbedBuilder } = require('discord.js');
const logger = require('../utils/logger');
const experimentalGuildStore = require('./experimentalGuildStore');
const chatSafetyService = require('./chatSafetyService');
const guildConfigStore = require('./guildConfigStore');
const guildLogger = require('./guildLogger');
const { tryDeleteMessage, addDeleteFailureNotice } = require('./scamResponder');
const { humanizeDuration } = require('../utils/duration');
const { tl } = require('./i18n');

const CONTEXT_LINES = 6;
const LINE_MAX_CHARS = 300;
const ACTION_CONFIDENCE = 0.9;
const ALERT_CONFIDENCE = 0.7;
const TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PENDING = 30;
const REASON = 'antihacker+ 실험 기능: 유해 채팅 자동 조치';

// 판정할 필요 없는 메시지: 글자가 없거나 ㅋㅋ/ㅠㅠ/문장부호뿐인 것 (문맥 버퍼에는 남긴다)
const TRIVIAL = /^[\sㅋㅎㅠㅜ.,!?~^…]*$/u;

const buffers = new Map(); // channelId -> [{ authorId, line }]
let pending = 0;
let chain = Promise.resolve();

/**
 * messageCreate 에서 호출. 실험 서버가 아니면 아무것도 하지 않는다.
 * @param {import('discord.js').Message} message
 */
function observe(message) {
  if (!message.guild || !experimentalGuildStore.isExperimental(message.guild.id)) return;

  const text = (message.cleanContent || '').replace(/\s+/g, ' ').trim();
  const body = text || (message.attachments.size > 0 ? '(첨부파일)' : '');
  if (!body) return;

  const name = message.member?.displayName || message.author.username;
  const buf = buffers.get(message.channel.id) || [];
  buf.push({ authorId: message.author.id, line: `${name}: ${body.slice(0, LINE_MAX_CHARS)}` });
  if (buf.length > CONTEXT_LINES) buf.shift();
  buffers.set(message.channel.id, buf);

  if (!text || TRIVIAL.test(text) || !/\p{L}/u.test(text)) return;

  if (pending >= MAX_PENDING) {
    logger.warn('채팅 모더레이터 대기열 가득 — 검사 건너뜀', { guild: message.guild.name, pending });
    return;
  }
  const window = buf.slice(); // 지금 시점의 6줄을 고정해서 판정
  pending++;
  chain = chain
    .then(() => review(message, window))
    .catch((e) => logger.error('채팅 모더레이터 처리 오류', { error: e.message }))
    .finally(() => { pending--; });
}

async function review(message, window) {
  const lines = window.map((w) => w.line);
  const verdict = await chatSafetyService.judge(lines);
  if (!verdict || verdict.category === 'none' || verdict.confidence < ALERT_CONFIDENCE) return;

  const act = verdict.confidence >= (verdict.category === 'self_harm' ? ALERT_CONFIDENCE : ACTION_CONFIDENCE);
  const lang = guildConfigStore.getLanguage(message.guild.id);

  // 조치를 먼저 끝내고(빠르게) 요약은 그 뒤에 만든다(요약은 CPU에서 10초 이상 걸릴 수 있음)
  const actions = act ? await enforce(message, verdict.category, lang) : null;
  const summary = await chatSafetyService.summarize(lines, verdict.category, lang);

  logger.warn(`[실험] 유해 채팅 ${act ? '조치' : '의심(조치 안 함)'}`, {
    guild: message.guild.name,
    channel: message.channel.id,
    author: message.author.tag,
    category: verdict.category,
    confidence: verdict.confidence,
    deleted: actions?.del.deleted,
  });

  const embed = await buildEmbed(message, window, verdict, actions, summary, lang);
  await guildLogger.logToGuild(message.client, message.guild.id, { embeds: [embed] });
}

/** 삭제 + (자해면 도움 DM, 그 외는 10분 타임아웃) */
async function enforce(message, category, lang) {
  const del = await tryDeleteMessage(message);
  if (category === 'self_harm') {
    let dm = false;
    try {
      await message.author.send(await tl(lang, 'chat.helpDm', { server: message.guild.name }));
      dm = true;
    } catch {
      dm = false;
    }
    return { del, dm };
  }

  let timeout;
  const member = message.member || (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member) timeout = 'gone';
  else if (!member.moderatable) timeout = 'perm';
  else {
    try {
      await member.timeout(TIMEOUT_MS, REASON);
      timeout = 'ok';
    } catch (e) {
      logger.warn('[실험] 타임아웃 실패', { guild: message.guild.name, error: e.message });
      timeout = 'error';
    }
  }
  return { del, timeout };
}

async function buildEmbed(message, window, verdict, actions, summary, lang) {
  const counts = new Map();
  for (const w of window) counts.set(w.authorId, (counts.get(w.authorId) || 0) + 1);
  const participants = [...counts].map(([id, n]) => `<@${id}> ×${n}`).join('\n');

  const cat = await tl(lang, `chat.cat.${verdict.category}`);
  const embed = new EmbedBuilder()
    .setTitle(await tl(lang, actions ? 'title.chatAction' : 'title.chatSuspect'))
    .setColor(actions ? 0xed4245 : 0xfee75c)
    .setThumbnail(message.author.displayAvatarURL())
    .setDescription(`**${await tl(lang, 'field.summary')}**\n${(summary || (await tl(lang, 'chat.summaryFailed'))).slice(0, 1500)}`)
    .addFields(
      { name: await tl(lang, 'field.violator'), value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
      { name: await tl(lang, 'field.channel'), value: `<#${message.channel.id}>`, inline: true },
      { name: await tl(lang, 'field.category'), value: await tl(lang, 'chat.confidence', { cat, pct: Math.round(verdict.confidence * 100) }), inline: true },
      { name: await tl(lang, 'field.participants', { n: window.length }), value: participants.slice(0, 1024) },
      { name: await tl(lang, 'field.action'), value: await describeActions(actions, lang) },
    )
    .setTimestamp();

  if (actions) await addDeleteFailureNotice(embed, actions.del, lang);
  if (actions && verdict.category === 'self_harm') {
    embed.addFields({ name: '​', value: await tl(lang, 'chat.careNeeded') });
  }
  return embed;
}

async function describeActions(actions, lang) {
  if (!actions) return tl(lang, 'chat.noAction');
  const out = [await tl(lang, actions.del.deleted ? 'chat.deleted' : 'chat.notDeleted')];
  if ('dm' in actions) {
    out.push(await tl(lang, 'chat.noTimeoutSelfHarm'));
    out.push(await tl(lang, actions.dm ? 'chat.dmSent' : 'chat.dmFailed'));
  } else if (actions.timeout === 'ok') {
    out.push(await tl(lang, 'sanction.timeout', { dur: humanizeDuration(TIMEOUT_MS) }));
  } else if (actions.timeout === 'gone') {
    out.push(await tl(lang, 'sanction.failGone'));
  } else {
    const key = actions.timeout === 'perm' ? 'sanction.failPerm' : 'sanction.failErr';
    out.push(await tl(lang, key, { action: 'timeout' }));
  }
  return out.join('\n');
}

module.exports = { observe };
