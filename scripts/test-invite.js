/**
 * 초대 가드 드라이런 테스터 (읽기 전용 — 삭제/가입/게이트웨이 접속 없음)
 *
 * 실제 디스코드 API로 초대를 해석하고 실제 로컬 AI(VLM)로 판정만 해서 결과를 출력한다.
 * 봇 본체 로직(inviteScanner)을 그대로 태우되, client 는 REST 전용 어댑터로 대체해
 * 게이트웨이 세션을 열지 않는다(=돌아가는 봇과 충돌 없음).
 *
 * 사용법:
 *   node scripts/test-invite.js <초대링크 또는 코드> [더...]
 *   예) node scripts/test-invite.js discord.gg/python https://discord.com/invite/djs
 */
require('dotenv').config();
const { REST } = require('discord.js');
const config = require('../src/config');
const inviteScanner = require('../src/services/inviteScanner');
const localVlmService = require('../src/services/localVlmService');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('사용법: node scripts/test-invite.js <초대링크|코드> [더...]');
  process.exit(1);
}
if (!config.DISCORD_BOT_TOKEN) {
  console.log('DISCORD_BOT_TOKEN 이 .env 에 없습니다.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(config.DISCORD_BOT_TOKEN);

// inviteScanner 가 기대하는 최소 형태(guild.id/name/description/nsfwLevel/iconURL())로 맞춘 어댑터
const restClient = {
  async fetchInvite(code) {
    const inv = await rest.get(`/invites/${code}?with_counts=true`);
    const g = inv.guild;
    if (!g) return { guild: null };
    return {
      guild: {
        id: g.id,
        name: g.name,
        description: g.description,
        nsfwLevel: g.nsfw_level,
        iconURL: () => (g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=128` : null),
      },
    };
  },
};

(async () => {
  const vlmUp = await localVlmService.isAvailable();
  console.log(`로컬 AI(VLM): ${vlmUp ? 'ON' : 'OFF(공식등급+키워드만)'}\n`);

  for (const raw of args) {
    // 전체 메시지처럼 넣어도 inviteScanner 가 코드 추출
    const verdict = await inviteScanner.scanMessageInvites(restClient, raw, null, 'ko');
    if (verdict) {
      console.log(`🚫 ${raw}`);
      console.log(`   삭제대상 | 종류=${verdict.kind} 근거=${verdict.source} 신뢰도=${verdict.confidence}`);
      console.log(`   서버="${verdict.guildName}"`);
      console.log(`   사유: ${verdict.reason}\n`);
    } else {
      console.log(`✅ ${raw} → 안전(통과)\n`);
    }
  }
})().catch((e) => {
  console.error('테스트 오류:', e.message);
  process.exit(1);
});
