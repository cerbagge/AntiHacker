require('dotenv').config();

// 비밀값이 없어도 봇이 죽지 않도록 (대기 모드 허용) — 없으면 경고만 출력하고 계속.
//  · DISCORD_BOT_TOKEN 없음 → 로그인하지 않고 대기 (index.js)
const expected = ['DISCORD_BOT_TOKEN'];
for (const key of expected) {
  if (!process.env[key]) {
    console.warn(`[경고] 환경변수 ${key} 미설정 — 관련 기능은 비활성화된 채로 기동합니다.`);
  }
}

module.exports = Object.freeze({
  DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN || '',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // ── 코인 스캠 이미지 자동삭제 (antihacker+) ──
  // 로컬 스캠 이미지 감지 전체 ON/OFF 마스터 스위치. 기본 OFF.
  // RAM 업그레이드(32GB) 전엔 OFF 유지 권장. 켜려면 .env 에 SCAM_IMAGE_GUARD_ENABLED=true
  SCAM_IMAGE_GUARD_ENABLED: process.env.SCAM_IMAGE_GUARD_ENABLED === 'true',
  // 자동삭제 임계값(점수). 이 이상 + 서로 다른 신호 2종류 이상이면 삭제
  SCAM_AUTODELETE_THRESHOLD: parseInt(process.env.SCAM_AUTODELETE_THRESHOLD, 10) || 70,
  // 로컬 VLM(Ollama) 사용 여부. 'false'로 명시하면 끔 (기본 켬, Ollama 없으면 자동 스킵)
  SCAM_VLM_ENABLED: process.env.SCAM_VLM_ENABLED !== 'false',
  // 로컬 VLM(Ollama) 설정
  OLLAMA_URL: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  OLLAMA_VLM_MODEL: process.env.OLLAMA_VLM_MODEL || 'qwen2.5vl:7b',
  OLLAMA_TIMEOUT_MS: parseInt(process.env.OLLAMA_TIMEOUT_MS, 10) || 180000,

  // ── 첨부 바이러스 검사 (ClamAV, 로컬 clamd 데몬) ──
  // AI가 아니라 시그니처 기반이라 가벼움 → RAM 업그레이드와 무관하게 동작. ClamAV 없으면 자동 스킵.
  VIRUS_SCAN_ENABLED: process.env.VIRUS_SCAN_ENABLED !== 'false', // 기본 켬
  CLAMAV_BINARY: process.env.CLAMAV_BINARY || 'clamdscan',
  CLAMAV_TIMEOUT_MS: parseInt(process.env.CLAMAV_TIMEOUT_MS, 10) || 120000,

  // ── 이미지 처리 안정장치 (동시성 상한 + 대기열) ──
  // 동시에 처리(다운로드+OCR/VLM)하는 이미지 수 상한. 대기 메시지는 버퍼를 안 들어 메모리 보호.
  IMAGE_MAX_CONCURRENT: parseInt(process.env.IMAGE_MAX_CONCURRENT, 10) || 6,
  // 대기열 상한. 이걸 넘으면 과부하로 보고 해당 메시지 검사를 건너뜀(fail-open).
  IMAGE_MAX_QUEUE: parseInt(process.env.IMAGE_MAX_QUEUE, 10) || 200,

  // ── 스팸 스윕 (허니팟 적발 유저의 연관 메시지 전역 삭제) ──
  // 허니팟(/spamchannel)에 걸린 유저는 도배봇으로 보고, 그 유저가 비슷한 시간대/내용으로
  // 다른 채널에 뿌린 메시지까지 함께 삭제한다. 기본 켬. 끄려면 SPAM_SWEEP_ENABLED=false
  SPAM_SWEEP_ENABLED: process.env.SPAM_SWEEP_ENABLED !== 'false',
  // 시간창(ms): 적발 시각 ±이 값 안에 올라온 같은 유저 메시지를 함께 삭제. 기본 5분.
  SPAM_SWEEP_WINDOW_MS: parseInt(process.env.SPAM_SWEEP_WINDOW_MS, 10) || 5 * 60 * 1000,
  // 내용 유사도 임계값(0~1, 글자 바이그램 Dice). 이 이상이면 내용이 비슷한 것으로 보고 삭제. 기본 0.85.
  SPAM_SWEEP_SIMILARITY: parseFloat(process.env.SPAM_SWEEP_SIMILARITY) || 0.85,

  // ── 디스코드 초대 가드 (NSFW/스팸 초대 자동삭제) ──
  // 메시지의 디스코드 링크(초대/채널)를 검사 — 링크 자체로는 차단하지 않고,
  // ① 초대 대상 서버가 19+(성인)/스팸(공식 nsfwLevel + 로컬 AI + 키워드 폴백)이거나
  // ② 함께 적힌 문구가 스팸/성인 유인(키워드 + 로컬 AI)일 확률이 높을 때만 삭제. 기본 켬.
  INVITE_GUARD_ENABLED: process.env.INVITE_GUARD_ENABLED !== 'false',

  // ── 채팅 모더레이터 (실험 기능) ──
  // experimentalGuilds.json 에 적힌 서버에서만 동작. 판정·요약에 쓸 Ollama 텍스트 모델.
  CHAT_MOD_MODEL: process.env.CHAT_MOD_MODEL || 'exaone3.5:7.8b',
  // 관찰 모드: true 면 삭제·타임아웃·DM 없이 로그만 남긴다 (실험 서버에서 오탐을 먼저 지켜볼 때)
  CHAT_MOD_LOG_ONLY: process.env.CHAT_MOD_LOG_ONLY === 'true',
  // 로그를 받을 유저 ID: 있으면 서버 로그 채널 대신 이 유저 DM으로만 보낸다 (봇과 서버를 하나 이상 공유해야 DM 가능)
  CHAT_MOD_LOG_USER_ID: (process.env.CHAT_MOD_LOG_USER_ID || '').trim(),
});
