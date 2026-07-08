const { Client, GatewayIntentBits } = require('discord.js');
const config = require('./config');
const logger = require('./utils/logger');
const registerReady = require('./events/ready');
const registerMessageCreate = require('./events/messageCreate');
const registerGuildGuard = require('./events/guildGuard');
const registerInteractionCreate = require('./events/interactionCreate');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

registerGuildGuard(client);
registerReady(client);
registerMessageCreate(client);
registerInteractionCreate(client);

// 봇 토큰이 없으면 로그인하지 않고 대기 (AI/모더레이션 미동작). 토큰을 .env에 넣으면 정상 기동.
if (!config.DISCORD_BOT_TOKEN) {
  logger.warn('봇 토큰(DISCORD_BOT_TOKEN)이 없어 로그인하지 않고 대기합니다. 준비되면 .env에 토큰을 설정하세요.');
} else {
  client.login(config.DISCORD_BOT_TOKEN).catch((error) => {
    logger.error('봇 로그인 실패', { error: error.message });
    process.exit(1);
  });
}
