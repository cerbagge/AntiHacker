// 피싱/악성 URL 감지를 위한 패턴
module.exports = {
  // 의심스러운 도메인 키워드 (브랜드 사칭)
  suspiciousDomainKeywords: [
    'discord-gift', 'discord-nitro', 'free-nitro', 'discordgift',
    'stearncommunnity', 'steamcommunlty', 'steamcomrnunity',
    'login-verify', 'account-verify', 'security-check',
    'free-robux', 'free-vbucks',
    'wallet-connect', 'metamask-verify',
  ],

  // IP 주소 기반 URL (http://123.45.67.89/...)
  ipAddressUrl: /https?:\/\/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/,

  // 의심스러운 TLD + 브랜드명 조합
  suspiciousTlds: ['.xyz', '.top', '.click', '.buzz', '.tk', '.ml', '.ga', '.cf', '.gq'],
  brandKeywords: [
    'discord', 'steam', 'roblox', 'minecraft', 'paypal',
    'apple', 'google', 'microsoft', 'netflix', 'amazon',
    'instagram', 'facebook', 'twitter', 'kakao', 'naver',
  ],

  // 이중 확장자 패턴 (예: photo.jpg.exe)
  doubleExtension: /\.\w{2,4}\.(exe|bat|cmd|scr|vbs|ps1|msi|hta|lnk|dll)$/i,

  // 의심스러운 파일명 키워드
  suspiciousFilenameKeywords: [
    'crack', 'keygen', 'hack', 'cheat', 'exploit',
    'free_nitro', 'free-nitro', 'freenitro',
    'password', 'stealer', 'grabber', 'rat', 'trojan',
  ],
};
