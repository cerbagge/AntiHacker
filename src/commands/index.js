/**
 * 슬래시 명령 모듈 집합 — interactionCreate(처리)와 ready(등록)가 공유한다.
 * 각 모듈은 { data: SlashCommandBuilder, execute(interaction) } 형태.
 */
module.exports = [
  require('./spamchannel'),
  require('./logs'),
  require('./language'),
  require('./spamping'),
  require('./spamSanction'),
];
