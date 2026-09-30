/**
 * 코인 기브어웨이/에어드랍 스캠 이미지 감지용 패턴 (로컬, AI 불필요)
 *
 * 각 그룹은 { en, ko } 로 나뉜다:
 *  - en: 영어 토큰 → 단어 경계(\b)로 매칭 (예: "eth"가 "together"에 매칭되는 것 방지)
 *  - ko: 한국어 토큰 → 부분 문자열로 매칭
 *
 * 점수/임계값 로직은 scamImageScanner.js 에 있다. 여기는 데이터만.
 */
module.exports = {
  // 스캠 핵심 행동 (강한 신호)
  giveawayActions: {
    en: [
      'giveaway', 'give away', 'giving away', 'airdrop', 'air drop', 'claim now', 'claim your',
      'free crypto', 'free bitcoin', 'free eth', 'free token', 'double your',
      'first 100', 'first 500', 'first 1000', 'redeem', 'presale', 'pre-sale',
      'mint now', 'whitelist', 'bonus reward', 'exclusive reward',
      'claim your reward', 'receive your', 'register and', 'everyone who registers',
    ],
    ko: [
      '에어드랍', '에어드롭', '무료 코인', '코인 무료', '무료 지급', '지급 이벤트',
      '이벤트 지급', '코인 지급', '입금하면', '받으세요', '선착순',
      '무료 비트코인', '코인 받기', '코인 증정', '보상 지급', '무료 채굴',
    ],
  },

  // 배수 보상 단어 — MULTIPLIER 정규식(x2/10x)과 같은 취급. 거래 화면에선 레버리지라 무시한다.
  multiplierWords: { ko: ['두배', '2배'] },

  // 정상 거래소 거래 화면(화이트리스트) — 서로 다른 토큰 2개 이상이면 거래 화면으로 본다.
  // 선물/현물 체결·포지션·손익 UI에만 나오는 용어로 한정 (buy/sell/long 처럼 광고에도 흔한 단어 제외).
  tradingContext: {
    en: [
      'leverage', 'futures', 'perp', 'perpetual', 'position', 'positions', 'entry price',
      'mark price', 'liq. price', 'liq price', 'liquidation price', 'unrealized pnl',
      'realized pnl', 'pnl', 'roe', 'margin ratio', 'isolated', 'cross', 'order book',
      'open orders', 'order history', 'trade history', 'avg price', 'avg. price',
      'limit order', 'market order', 'take profit', 'stop loss', 'tp/sl', 'filled',
    ],
    ko: [
      '레버리지', '포지션', '선물', '진입가', '평균단가', '평단', '청산가', '미실현',
      '실현손익', '수익률', '손익', '증거금', '교차', '격리', '호가', '체결', '미체결',
      '매수', '매도', '지정가', '시장가', '주문내역', '거래내역',
    ],
  },

  // 정품 거래소 도메인 — 거래 공유카드의 QR(추천 링크)이 스캠 URL 힌트로 잡히지 않게 한다.
  // 호스트가 정확히 일치하거나 하위 도메인일 때만 (bitget-reward.com 같은 사칭 도메인은 해당 없음)
  exchangeDomains: [
    'bitget.com', 'binance.com', 'bybit.com', 'okx.com', 'upbit.com', 'bithumb.com',
    'coinone.co.kr', 'korbit.co.kr', 'gopax.co.kr', 'mexc.com', 'gate.io', 'kucoin.com',
    'htx.com', 'bingx.com', 'coinbase.com', 'kraken.com', 'tradingview.com',
  ],

  // 코인 카지노/도박 보너스 스캠 (사칭 + 가짜 출금 인증 장르 — 강한 신호)
  casinoBonus: {
    en: [
      'promo code', 'promocode', 'bonus code', 'activate code', 'activate bonus',
      'casino', 'rakeback', 'vip-club', 'vip club', 'free gift', 'deposit bonus',
      'no deposit', 'claim bonus', 'exclusive bonus', 'withdrawal success',
      'withdraw success', 'withdrawal was successfully', 'enter the promo code',
      'special promo code',
    ],
    ko: ['프로모 코드', '프로모코드', '보너스 코드', '카지노', '출금 성공', '입금 보너스', '무료 지급 코드', '보너스 받기'],
  },

  // 지갑 연결/검증 유도 (강한 신호 — 피싱)
  walletActions: {
    en: [
      'connect wallet', 'connect your wallet', 'verify wallet', 'validate wallet',
      'sync wallet', 'import wallet', 'restore wallet', 'seed phrase',
      'recovery phrase', 'private key', 'metamask', 'walletconnect', 'trust wallet',
    ],
    ko: ['지갑 연결', '지갑 연동', '지갑 인증', '시드 문구', '복구 문구', '개인키', '니모닉'],
  },

  // 암호화폐 용어 (중간 신호)
  cryptoTerms: {
    en: [
      'bitcoin', 'btc', 'ethereum', 'eth', 'usdt', 'usdc', 'tether', 'bnb', 'binance',
      'dogecoin', 'doge', 'shib', 'shiba', 'xrp', 'ripple', 'solana', 'sol',
      'crypto', 'cryptocurrency', 'token', 'blockchain', 'web3', 'defi', 'nft', 'satoshi',
      'trx', 'tron', 'trc20', 'erc20', 'block explorer',
    ],
    ko: ['비트코인', '이더리움', '코인', '암호화폐', '가상화폐', '가상자산', '블록체인', '토큰'],
  },

  // 긴급성 (약한 신호)
  urgency: {
    en: [
      'limited time', 'hurry', 'last chance', 'only today', 'ends soon', 'act now',
      'expires soon', 'offer is limited', 'will be deleted', "don't miss",
      'only the fastest', 'miss your chance', 'deleted an hour',
    ],
    ko: ['한정', '서두르', '오늘만', '마감 임박', '지금 바로', '곧 종료', '단 하루', '놓치지'],
  },

  // 자주 사칭되는 유명인/브랜드 (보조 신호)
  celebrities: {
    en: [
      'elon musk', 'elon', 'musk', 'tesla', 'spacex', 'vitalik', 'changpeng',
      'michael saylor', 'donald trump', 'cathie wood', 'cz binance',
      'mrbeast', 'mr beast', 'cristiano ronaldo', 'ronaldo', 'cz', 'pavel durov',
    ],
    ko: ['일론 머스크', '머스크', '비탈릭', '미스터비스트', '호날두'],
  },

  // 스캠 URL 힌트 (URL 문자열 안에 들어가면 강한 신호) — 부분 문자열 매칭
  scamUrlHints: [
    't.me/', 'telegram', 'whatsapp', 'bit.ly', 'cutt.ly', 'tinyurl', 'is.gd',
    'claim', 'airdrop', 'giveaway', 'bonus', 'reward', 'event', 'promo',
    '-eth', '-btc', '-crypto', 'elon', 'musk', 'wallet', 'mint', 'presale',
    'casino', 'rakeback', 'freespin', 'jackpot',
  ],
};
