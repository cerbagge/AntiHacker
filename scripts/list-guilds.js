/**
 * 참여 서버 목록 조회 (읽기 전용 — 게이트웨이 접속/봇 재시작 없음)
 *
 * 돌아가는 봇을 끄지 않고도 현재 들어가 있는 서버 목록을 본다.
 * REST API(GET /users/@me/guilds)만 호출하므로 게이트웨이 세션을 열지 않아
 * 동작 중인 봇과 충돌하지 않는다(test-invite.js 와 동일한 방식).
 *
 * 사용법:  node scripts/list-guilds.js   (또는  npm run guilds)
 */
require('dotenv').config();
const { REST } = require('discord.js');
const config = require('../src/config');

if (!config.DISCORD_BOT_TOKEN) {
  console.log('DISCORD_BOT_TOKEN 이 .env 에 없습니다.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(config.DISCORD_BOT_TOKEN);

(async () => {
  // with_counts=true → 대략적 인원수(approximate_member_count)도 함께 받는다
  const guilds = await rest.get('/users/@me/guilds?with_counts=true');
  console.log(`현재 참여 중인 서버: ${guilds.length}개\n`);
  guilds
    .sort((a, b) => (b.approximate_member_count || 0) - (a.approximate_member_count || 0))
    .forEach((g) => {
      const n = g.approximate_member_count != null ? `${g.approximate_member_count}명` : '인원수 미상';
      console.log(`  ├ ${g.name} (ID: ${g.id}) — ${n}`);
    });
})().catch((e) => {
  console.error('서버 목록 조회 오류:', e.message);
  process.exit(1);
});
