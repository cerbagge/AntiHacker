/**
 * 자동 제재 — 봇이 스팸/스캠으로 판정해 메시지를 삭제한 유저에게
 * `/spamsanction` 설정(timeout/kick/ban)을 적용한다.
 *
 * 제재 불가(봇 권한 부족·역할 서열·이미 나감)면 조용히 건너뛰고 결과를 반환해
 * 호출부가 로그 임베드에 표기할 수 있게 한다. type=none/미설정이면 아무것도 안 함.
 */
const logger = require('../utils/logger');
const guildConfigStore = require('./guildConfigStore');
const timeoutRenewer = require('./timeoutRenewer');
const tempBanStore = require('./tempBanStore');

const MAX_TIMEOUT_MS = timeoutRenewer.MAX_TIMEOUT_MS; // Discord 타임아웃 최대 28일
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // time 미지정 시 기본 1시간

const REASON = 'antihacker+ 자동 제재 (스팸/스캠 탐지)';

/**
 * @param {import('discord.js').Message} message 삭제 처리된 원본 메시지
 * @returns {Promise<null|{type:string, ok:boolean, durationMs?:number, skipped?:string}>}
 */
async function applySanction(message) {
  const guildId = message.guild?.id;
  if (!guildId) return null;

  const { type, durationMs } = guildConfigStore.getSanction(guildId);
  if (!type || type === 'none') return null;

  // 메시지 삭제 후에도 member 는 캐시에 남지만, 없으면 fetch
  let member = message.member;
  if (!member) {
    member = await message.guild.members.fetch(message.author.id).catch(() => null);
  }
  if (!member) return { type, ok: false, skipped: 'gone' };

  try {
    if (type === 'timeout') {
      if (!member.moderatable) return { type, ok: false, skipped: 'perm' };
      const target = durationMs || DEFAULT_TIMEOUT_MS;
      const chunk = Math.min(target, MAX_TIMEOUT_MS);
      await member.timeout(chunk, REASON);
      // 28일 초과분은 자동 갱신기에 등록 → 조각 만료 직전 재적용해 목표 기간까지 이어붙임
      if (target > MAX_TIMEOUT_MS) {
        const now = Date.now();
        timeoutRenewer.register(guildId, member.id, now + target, now + chunk);
      }
      // durationMs 는 로그에 '목표 총 기간'을 표기하기 위해 target 을 반환
      return { type, ok: true, durationMs: target, renewed: target > MAX_TIMEOUT_MS };
    }
    if (type === 'kick') {
      if (!member.kickable) return { type, ok: false, skipped: 'perm' };
      await member.kick(REASON);
      return { type, ok: true };
    }
    if (type === 'ban') {
      if (!member.bannable) return { type, ok: false, skipped: 'perm' };
      await member.ban({ reason: REASON });
      // 기간이 지정된 임시 밴이면 해제 예약. time 없으면 영구 밴(기존과 동일).
      if (durationMs > 0) {
        tempBanStore.register(guildId, member.id, Date.now() + durationMs);
      }
      return { type, ok: true, durationMs };
    }
  } catch (e) {
    logger.warn('자동 제재 실패', { type, guild: message.guild?.name, error: e.message });
    return { type, ok: false, skipped: 'error' };
  }
  return null;
}

module.exports = { applySanction, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS };
