/**
 * 채팅 모더레이터 (실험 기능) — experimentalGuilds.json 에 적힌 서버에서만 동작
 *
 * 채널별 최근 6줄을 기억해 두고, 새 메시지가 오면 그 6줄 흐름을 로컬 LLM에 보내 마지막 줄을 판정한다.
 *  - confidence ≥ 0.9 : 메시지 삭제 + 10분 타임아웃
 *  - 자해·자살은 0.7 이상이면 타임아웃 대신 삭제 + 도움 안내 DM + 관리자에게 돌봄 요청
 *    (처벌이 아니라 안내라서 놓치는 쪽이 더 위험 — 실측에서 "약 다 먹고 끝낼거야"가 0.8로 나옴)
 *  - 그 외 0.7 ≤ conf < 0.9 : 조치 없이 로그에 '의심'으로만 남김
 * 로그 채널에는 원문 대신 LLM 요약 + 참여자 + 처벌 결과만 출력한다. (서버 로그에도 원문을 남기지 않음)
 * CHAT_MOD_LOG_ONLY=true(관찰 모드)면 삭제·타임아웃·DM 없이 '조치했을 판정'을 로그로만 남긴다.
 * CHAT_MOD_LOG_USER_ID 가 있으면 로그를 서버 로그 채널 대신 그 유저(봇 운영자) DM으로만 한국어로 보낸다.
 *
 * LLM은 CPU에서 메시지당 수 초 걸리므로 한 번에 하나씩 순서대로 처리하고, 밀린 메시지가
 * 너무 많으면 새 메시지 검사는 건너뛴다(fail-open). 메시지 처리 흐름(스캠 검사 등)은 막지 않는다.
 */
const { EmbedBuilder } = require('discord.js');
const config = require('../config');
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
const DM_LOG_LANG = 'ko'; // DM 로그 수신자(봇 운영자)는 한국어 사용

// 판정할 필요 없는 메시지: 글자가 없거나 ㅋㅋ/ㅠㅠ/문장부호뿐인 것 (문맥 버퍼에는 남긴다)
const TRIVIAL = /^[\sㅋㅎㅠㅜ.,!?~^…]*$/u;

const buffers = new Map(); // channelId -> [{ authorId, name, body }]
let pending = 0;
let chain = Promise.resolve();

/**
 * messageCreate 에서 호출. 실험 서버가 아니면 아무것도 하지 않는다.
 * @param {import('discord.js').Message} message
 */
function observe(message) {
  if (!message.guild || !experimentalGuildStore.isExperimental(message.guild.id)) return;

  // 전달(forward)된 메시지는 원문이 messageSnapshots 에 들어 있으므로 캡션과 합쳐서 본다
  const parts = [message.cleanContent];
  for (const snap of message.messageSnapshots?.values() || []) parts.push(snap.cleanContent || snap.content);
  const text = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const body = text || (message.attachments.size > 0 ? '(첨부파일)' : '');
  if (!body) return;

  const name = message.member?.displayName || message.author.username;
  const buf = buffers.get(message.channel.id) || [];
  buf.push({ authorId: message.author.id, name, body });
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
  // 대기 중에 실험 서버 목록에서 빠졌으면 판정·조치하지 않는다
  if (!experimentalGuildStore.isExperimental(message.guild.id)) return;

  // 이전 문맥 줄만 짧게 자르고, 판정 대상(마지막 줄)은 전체를 넣는다 — 앞에 무해한 글을 채워 숨기는 우회 방지
  const lines = window.map((w, i) =>
    `${w.name}: ${i === window.length - 1 ? w.body : w.body.slice(0, LINE_MAX_CHARS)}`);
  const verdict = await chatSafetyService.judge(lines);
  if (!verdict || verdict.category === 'none' || verdict.confidence < ALERT_CONFIDENCE) return;
  if (!experimentalGuildStore.isExperimental(message.guild.id)) return; // 판정하는 사이 빠진 경우

  const wouldAct = verdict.confidence >= (verdict.category === 'self_harm' ? ALERT_CONFIDENCE : ACTION_CONFIDENCE);
  const act = wouldAct && !config.CHAT_MOD_LOG_ONLY;
  const lang = guildConfigStore.getLanguage(message.guild.id);

  // 로그는 운영자 DM(설정 시) 또는 서버 로그 채널로 간다. DM이면 서버 언어와 무관하게 한국어.
  const dmUserId = config.CHAT_MOD_LOG_USER_ID;
  const logLang = dmUserId ? DM_LOG_LANG : lang;

  // 조치를 먼저 끝내고(빠르게) 요약은 그 뒤에 만든다(요약은 CPU에서 10초 이상 걸릴 수 있음).
  // 로그를 보낼 곳이 없으면 요약을 만들지 않는다(대기열을 오래 붙잡지 않도록).
  const actions = act ? await enforce(message, verdict.category, lang) : null;
  const hasLogTarget = !!dmUserId || !!guildConfigStore.getLogChannel(message.guild.id);
  const summary = hasLogTarget ? await chatSafetyService.summarize(lines, verdict.category, logLang) : null;

  logger.warn(`[실험] 유해 채팅 ${act ? '조치' : wouldAct ? '감지(관찰 모드)' : '의심(조치 안 함)'}`, {
    guild: message.guild.name,
    channel: message.channel.id,
    author: message.author.tag,
    category: verdict.category,
    confidence: verdict.confidence,
    deleted: actions?.del.deleted,
  });

  if (!hasLogTarget) return;
  const embed = await buildEmbed(message, window, verdict, actions, wouldAct, summary, logLang, !!dmUserId);
  if (!dmUserId) {
    await guildLogger.logToGuild(message.client, message.guild.id, { embeds: [embed] });
    return;
  }
  try {
    const user = await message.client.users.fetch(dmUserId);
    await user.send({ embeds: [embed] });
  } catch (e) {
    logger.warn('[실험] 채팅 모더레이터 DM 로그 전송 실패', { user: dmUserId, error: e.message });
  }
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
  // 캐시된 member 는 이후에 걸린 타임아웃을 모를 수 있어(GuildMembers intent 없음) 새로 받아온다
  const member = await message.guild.members.fetch({ user: message.author.id, force: true }).catch(() => null);
  if (!member) timeout = 'gone';
  else if ((member.communicationDisabledUntilTimestamp || 0) >= Date.now() + TIMEOUT_MS) {
    // 관리자나 다른 제재가 이미 더 긴 타임아웃을 걸었으면 10분으로 줄이지 않는다
    // (28일 초과 타임아웃은 timeoutRenewer 가 만료 시각으로 이어붙이므로 줄이면 추적이 끊긴다)
    timeout = 'kept';
  } else if (!member.moderatable) timeout = 'perm';
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

async function buildEmbed(message, window, verdict, actions, wouldAct, summary, lang, showGuild) {
  const counts = new Map();
  for (const w of window) counts.set(w.authorId, (counts.get(w.authorId) || 0) + 1);
  const participants = [...counts].map(([id, n]) => `<@${id}> ×${n}`).join('\n');

  const cat = await tl(lang, `chat.cat.${verdict.category}`);
  const embed = new EmbedBuilder()
    .setTitle(await tl(lang, actions ? 'title.chatAction' : wouldAct ? 'title.chatLogOnly' : 'title.chatSuspect'))
    .setColor(actions ? 0xed4245 : wouldAct ? 0xe67e22 : 0xfee75c)
    .setThumbnail(message.author.displayAvatarURL())
    .setDescription(`**${await tl(lang, 'field.summary')}**\n${(summary || (await tl(lang, 'chat.summaryFailed'))).slice(0, 1500)}`)
    .addFields(
      { name: await tl(lang, 'field.violator'), value: `${message.author.tag} (<@${message.author.id}>)`, inline: true },
      { name: await tl(lang, 'field.channel'), value: `<#${message.channel.id}>`, inline: true },
      { name: await tl(lang, 'field.category'), value: await tl(lang, 'chat.confidence', { cat, pct: Math.round(verdict.confidence * 100) }), inline: true },
      { name: await tl(lang, 'field.participants', { n: window.length }), value: participants.slice(0, 1024) },
      { name: await tl(lang, 'field.action'), value: await describeActions(actions, wouldAct, lang) },
    )
    .setTimestamp();
  // DM 로그는 여러 서버가 한곳에 모이므로 어느 서버인지 맨 앞에 보여준다
  if (showGuild) embed.spliceFields(0, 0, { name: await tl(lang, 'field.guild'), value: message.guild.name.slice(0, 256), inline: false });

  if (actions) await addDeleteFailureNotice(embed, actions.del, lang);
  if (wouldAct && verdict.category === 'self_harm') {
    embed.addFields({ name: '​', value: await tl(lang, 'chat.careNeeded') });
  }
  return embed;
}

async function describeActions(actions, wouldAct, lang) {
  if (!actions) return tl(lang, wouldAct ? 'chat.logOnly' : 'chat.noAction');
  const out = [await tl(lang, actions.del.deleted ? 'chat.deleted' : 'chat.notDeleted')];
  if ('dm' in actions) {
    out.push(await tl(lang, 'chat.noTimeoutSelfHarm'));
    out.push(await tl(lang, actions.dm ? 'chat.dmSent' : 'chat.dmFailed'));
  } else if (actions.timeout === 'ok') {
    out.push(await tl(lang, 'sanction.timeout', { dur: humanizeDuration(TIMEOUT_MS) }));
  } else if (actions.timeout === 'kept') {
    out.push(await tl(lang, 'chat.timeoutKept'));
  } else if (actions.timeout === 'gone') {
    out.push(await tl(lang, 'sanction.failGone'));
  } else {
    const key = actions.timeout === 'perm' ? 'sanction.failPerm' : 'sanction.failErr';
    out.push(await tl(lang, key, { action: 'timeout' }));
  }
  return out.join('\n');
}

module.exports = { observe };
