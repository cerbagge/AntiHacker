# AntiHacker (antihacker+)

Discord 코인 스캠/스팸 이미지·초대 링크를 **온디바이스(로컬) AI** 중심으로 판별해 자동 삭제하는 봇.
봇이 도는 서버에서 직접 추론하며, 로컬 도구가 없으면 해당 단계는 자동으로 건너뜁니다.
애매한 이미지의 최종 판정만 **선택적으로 Claude API**(Haiku 5.5 → Sonnet 5.5)를 쓰고,
API 키가 없거나 오류·한도 소진이면 로컬 VLM이 대신 판정합니다.

## 사용한 AI / 도구

| 단계 | 도구 | 용도 |
|------|------|------|
| 최종 검수 *(선택, 클라우드)* | **Claude API** — Haiku 5.5 → Sonnet 5.5 | OCR·패턴 점수가 애매한 이미지를 먼저 Claude가 판정. [아래 설명](#claude-최종-검수-선택) |
| 비전 판정(VLM) | **Ollama + Qwen2.5-VL 7B** (`qwen2.5vl:7b`) | Claude 미설정·오류 시 이미지를 눈으로 보고 스캠 여부 최종 판정 |
| 문자 인식(OCR) | **Tesseract.js** (한국어+영어, `kor+eng`) | 이미지 속 글자 추출 (traineddata 동봉) |
| 바이러스 검사 | **ClamAV** (`clamdscan` 데몬) | 모든 첨부를 시그니처 기반으로 검사, 감염 시 삭제 |
| PDF 렌더링 | **Poppler** (`poppler-utils`) | PDF 앞 3페이지를 이미지로 바꿔 스캠 검사, 텍스트·숨은 링크 추출 |
| 채팅 판정(실험) | **Ollama + EXAONE 3.5 7.8B** (`exaone3.5:7.8b`) | 실험 서버에서 최근 6줄 대화를 보고 유해 메시지 판정 + 로그용 요약 |

탐지 파이프라인(싼 것 → 비싼 것): **이미지 해시(dHash) → QR 해독 → OCR → 패턴 점수 → 최종 검수(Claude → 실패 시 로컬 VLM)**.
점수 임계값 이상 + 서로 다른 신호 2종류 이상일 때만 자동 삭제해 오삭제를 막습니다.

**해시 즉시삭제**: 봇이 스팸으로 삭제 처리한 메시지(스캠 이미지·허니팟·NSFW 초대·바이러스)의 글 내용(SHA-256)과
이미지(dHash)를 `scamHashes.json` 에 학습합니다. 똑같은 글/이미지가 다시 올라오면 대기열·바이러스 검사·OCR/AI 없이 바로 삭제합니다.
(글은 대소문자·공백만 무시한 완전 일치, 15자 미만은 학습 안 함. 채팅 모더레이터 삭제는 문맥 판정이라 학습하지 않음)

> 로컬 도구와 Claude API는 모두 **선택**입니다. Ollama/ClamAV/Poppler/API 키가 없으면 그 단계는 조용히 스킵되고,
> 해시·OCR·패턴 점수만으로도 동작합니다. 최종 검수(Claude·VLM)는 애매한 이미지에만 호출됩니다.

## Claude 최종 검수 (선택)

`.env` 에 `ANTHROPIC_API_KEY` 가 있으면 VLM 단계에서 로컬 VLM보다 Claude를 먼저 씁니다.

```
로컬 OCR·패턴 → (애매한 후보만) Haiku 5.5
   ├ 확신도 0.8 이상 → 그대로 사용
   ├ 판단 못 함 (거부 / 형식 오류 / 확신도 0.8 미만) → Sonnet 5.5 에 다시 물음
   │     ├ Sonnet 판정은 확신도와 관계없이 최종으로 사용
   │     └ Sonnet 이 거부·형식 오류·API 오류면 → Haiku 의 애매한 판정, 그것도 없으면 로컬 VLM
   └ API 오류 (한도 소진·429·402·인증 / 타임아웃 30초 / 키 없음) → 로컬 VLM(Ollama)
```

- **출력**: Claude는 이유 없이 `{"scam": true, "confidence": 0.93}` 만 출력합니다(JSON 스키마로 강제). 로컬 VLM은 성능 보완용으로 이유(`reason`)까지 출력합니다.
- **오류 시 쉬기**: 오류 난 모델은 `retry-after` 동안(없으면 5분) 호출하지 않고 바로 다음 단계로 넘어갑니다.
  400 은 요청 문제일 수도, Workspace 지출 한도 도달일 수도 있어 1분만 쉽니다.
- **안전장치는 그대로**: 로컬 근거(서로 다른 신호 2종 + 점수 45 이상) 없이 AI 단독 판정이면 삭제하지 않습니다.
  관리자 알림(로그 채널 카드)은 로컬 위험도가 26% 이상일 때만 나가고, 그 미만(예: 유명인·QR 신호 하나뿐)은 서버 로그에만 기록됩니다.
- **로그**: 자동 삭제·의심(알림 대상) 로그의 신호에 판정 모델이 남습니다 — `claude-haiku-5-5(scam=true,conf=0.93)`. 디스코드 로그 채널에는 근거를 노출하지 않습니다.
- **속도**: 이미지당 약 2~4초 (로컬 7B CPU 추론은 1.5~2분).
- **비용(실측)**: 이미지 1장 ≈ 입력 2,300토큰 + 출력 19토큰 → Haiku 5.5 약 **$0.00024**, Sonnet 5.5 약 $0.0048.
  Haiku만으로 월 $100 ≈ 41만 장이며, Sonnet 재검수 비율이 늘면 줄어듭니다(5% ≈ 21만 장, 10% ≈ 14만 장).
  평범한 이미지와 로컬 패턴으로 확정된 스캠은 Claude까지 가지 않습니다.
- **개인정보**: 키를 넣으면 애매한 후보 이미지가 Anthropic API로 전송됩니다. 완전 로컬로 쓰려면 키를 비워 두세요.

## 요구 사항

- **Node.js 20.9 이상** (이미지 변환용 `sharp` 요구사항)
- Discord 봇 토큰
- (선택) **Anthropic API 키** — Claude 최종 검수를 쓰려면
- (선택) **Ollama** — 이미지 비전 판정(또는 Claude 오류 시 대체)을 쓰려면
- (선택) **ClamAV** — 첨부 바이러스 검사를 쓰려면
- (선택) **Poppler** — PDF 첨부 스캠 검사를 쓰려면

## 설치

### 1) 코드 받기 & 의존성 설치

```bash
git clone git@github.com:cerbagge/AntiHacker.git
cd AntiHacker
npm install
```

### 2) 로컬 AI(VLM) 설치 — Ollama + Qwen2.5-VL 7B  *(선택)*

```bash
# Ollama 설치 (Linux/macOS)
curl -fsSL https://ollama.com/install.sh | sh

# 사용하는 비전 모델 내려받기
ollama pull qwen2.5vl:7b

# Ollama 데몬이 http://127.0.0.1:11434 에서 떠 있으면 봇이 자동으로 연결
```

> 7B 모델은 약 6GB이고, GPU 없는 CPU 추론에서는 이미지당 1.5~2분 걸립니다(i7-8700 실측).
> 더 가볍게 쓰려면 `ollama pull qwen2.5vl:3b` 후 `.env` 에서 `OLLAMA_VLM_MODEL=qwen2.5vl:3b`,
> 아예 끄려면 `SCAM_VLM_ENABLED=false` 로 해시/OCR/패턴만 써도 됩니다.

### 2-1) Claude 최종 검수 — Anthropic API 키  *(선택)*

1. [Claude Console](https://platform.claude.com)에서 봇 전용 Workspace를 만들고 **월 지출 한도**를 겁니다
   (한도를 넘으면 봇이 자동으로 로컬 VLM으로 전환).
2. 그 Workspace 안에서 API 키를 발급해 두고, **4) 환경 변수 설정**에서 `.env` 를 만든 뒤 `ANTHROPIC_API_KEY=sk-ant-...` 로 넣습니다.
   (`cp .env.example .env` 가 기존 `.env` 를 덮어쓰므로 그 전에 넣지 마세요. **`.env.example` 에는 넣지 마세요.**)

> 키를 붙여 넣을 때 Console 목록에 가려 표시되는 앞부분(`sk-ant-...`)이 같이 들어가지 않게 주의하세요 (`401 invalid x-api-key`).
> `.env` 는 `chmod 600` 으로 본인만 읽게 두는 것을 권장합니다.

### 3) 바이러스 검사 설치 — ClamAV  *(선택)*

```bash
# Debian/Ubuntu
sudo apt install clamav-daemon
sudo systemctl enable --now clamav-daemon
# clamdscan 바이너리가 PATH 에 있으면 봇이 자동 사용 (없으면 스킵)
```

### 3-1) PDF 검사 설치 — Poppler  *(선택)*

```bash
# Debian/Ubuntu
sudo apt install poppler-utils
# macOS
brew install poppler
# pdftoppm / pdftotext / pdfinfo 가 PATH 에 있으면 봇이 자동 사용 (없으면 PDF 스캠 검사 스킵)
```

### 4) 환경 변수 설정

```bash
cp .env.example .env
# .env 를 열어 DISCORD_BOT_TOKEN 등을 채운다 (Claude 최종 검수를 쓰면 ANTHROPIC_API_KEY 도)
```

주요 항목(자세한 설명은 `.env.example` 참고):

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DISCORD_BOT_TOKEN` | — | (필수) 디스코드 봇 토큰 |
| `SCAM_IMAGE_GUARD_ENABLED` | `false` | 로컬 스캠 이미지 감지 전체 스위치 (`true` 권장) |
| `SCAM_AUTODELETE_THRESHOLD` | `70` | 자동삭제 점수 임계값 |
| `SCAM_VLM_ENABLED` | `true` | 로컬 VLM(Ollama) 사용 여부 (없으면 자동 스킵) |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama 주소 |
| `OLLAMA_VLM_MODEL` | `qwen2.5vl:7b` | 사용할 비전 모델 |
| `OLLAMA_TIMEOUT_MS` | `180000` | VLM 응답 대기 한도 (CPU 7B 기준) |
| `ANTHROPIC_API_KEY` | — | (선택) 있으면 Claude 최종 검수 사용, 비우면 로컬만 |
| `CLAUDE_MODEL` | `claude-haiku-5-5` | Claude 1차 판정 모델 |
| `CLAUDE_ESCALATION_MODEL` | `claude-sonnet-5-5` | 1차가 판단을 못 할 때 다시 묻는 모델 |
| `CLAUDE_TIMEOUT_MS` | `30000` | Claude 응답 대기 한도 (넘으면 로컬 VLM으로) |
| `VIRUS_SCAN_ENABLED` | `true` | ClamAV 첨부 검사 사용 여부 |

서버 잠금(허용목록)은 루트의 `allowedGuilds.json` 에 서버 ID를 넣어 설정합니다.
(빈 배열 `[]` = 모든 서버 허용)

### 5) 실행

```bash
npm start        # node src/index.js
# 개발 중 자동 재시작
npm run dev      # nodemon
```

## 채팅 모더레이터 (실험 기능)

루트의 `experimentalGuilds.json` 에 적힌 서버에서만 동작합니다. (`["서버ID1", "서버ID2"]`, 비어 있으면 꺼짐, 실행 중 수정 즉시 반영)

- 채널마다 최근 6줄 대화를 기억하고, 새 메시지가 오면 그 흐름을 로컬 LLM(`CHAT_MOD_MODEL`, 기본 `exaone3.5:7.8b`)이 판정합니다.
- 분류: 성적/NSFW · 자살·자해 · 폭력 위협 · 혐오·심한 모욕. "배고파 죽겠다", 게임 속 "죽인다", 친구끼리 가벼운 욕설은 위반이 아닙니다.
- 확신도 90% 이상 → 메시지 삭제 + **10분 타임아웃**.
- 자살·자해는 확신도 70% 이상이면 타임아웃 대신 삭제 + **109 상담전화 안내 DM** + 관리자에게 안부 확인 요청 (처벌이 아니라 안내라서 놓치지 않는 쪽을 택함).
- 그 외 확신도 70~90% → 조치 없이 로그에 '의심'으로만 남깁니다.
- `.env` 에 `CHAT_MOD_LOG_ONLY=true` 면 **관찰 모드** — 삭제·타임아웃·DM 없이 "조치했을 판정"을 로그로만 남깁니다 (재시작 필요).
- `.env` 에 `CHAT_MOD_LOG_USER_ID=<유저ID>` 면 로그를 서버 로그 채널 대신 그 유저 **DM으로만** 한국어로 보냅니다. 어느 서버인지 "서버" 항목이 붙습니다. (봇과 같은 서버에 있어야 DM 가능, 재시작 필요)
- `/spamlog` 로그 채널에는 **원문 대신** LLM 요약 + 대화 참여자 + 처벌 결과만 출력합니다. 로그 채널이 없으면 요약도 만들지 않습니다.
- 이미 더 긴 타임아웃이 걸려 있는 유저는 10분으로 줄이지 않습니다. 전달(forward)된 메시지의 원문도 판정합니다.
- 속도: i7-8700 CPU에서 판정 약 4초, 요약 10초 이상. 메시지는 순서대로 처리되며 밀린 검사가 30건을 넘으면 새 메시지 검사는 건너뜁니다.
- 봇 역할에 **메시지 관리** + **멤버 타임아웃** 권한이 필요합니다. 모델 설치: `ollama pull exaone3.5:7.8b`
- EXAONE 3.5 는 LG AI연구원의 연구·비상업 라이선스 모델입니다.

## 명령어 (슬래시 커맨드)

모두 **관리자 전용**(Administrator)이며 DM에서는 쓸 수 없습니다. 설정은 서버별로 저장됩니다.
평상시 탐지·삭제는 명령 없이 자동으로 동작하고, 아래 명령은 그 동작을 서버에 맞게 설정하는 용도입니다.

| 명령어 | 옵션 | 설명 |
|--------|------|------|
| `/spamlog` | `channel` (선택) | 스팸/스캠 탐지·허니팟 적발 로그를 보낼 채널 지정. 비우면 **명령을 친 채널**로 설정, 같은 채널에서 다시 실행하면 **해제**(토글). 로그 채널을 안 정하면 삭제는 되지만 디스코드 알림은 안 뜸 |
| `/spamchannel` | `channel` (선택) | **허니팟(스팸 함정) 채널** 토글. 지정한 채널에 올라오는 모든 메시지를 스팸으로 간주해 즉시 삭제(스팸 매크로가 전 채널에 뿌리는 특성 이용). 비우면 현재 채널, 재실행 시 해제 |
| `/language` | `lang` (필수) | 이 서버의 로그/알림 **출력 언어** 설정 (`한국어` / `English`) |
| `/spamping` | `roll` (선택) | 로그 메시지마다 **핑(멘션)할 역할/유저** 지정. 비우거나 같은 대상 지정 시 핑 끔(토글) |
| `/spamsanction` | `type` (필수), `time` (선택) | 봇이 적발한 유저 **제재 방식**: `timeout` / `kick` / `ban` / `none`. `time`은 기간(예: `4h3m13s`, 단위 `Y M h m s`) — timeout·ban에 적용(ban은 임시밴) |

> 슬래시 명령은 **전역 등록**이라 봇 추가 직후 디스코드 UI에 뜨기까지 몇 분 걸릴 수 있습니다.

## 라이선스

`LICENSE.txt` 참고.
