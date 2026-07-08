# AntiHacker (antihacker+)

Discord 코인 스캠/스팸 이미지·초대 링크를 **온디바이스(로컬) AI** 로 판별해 자동 삭제하는 봇.
외부 API 없이 봇이 도는 서버에서 직접 추론하며, 로컬 도구가 없으면 해당 단계는 자동으로 건너뜁니다.

## 사용한 로컬 AI / 도구

| 단계 | 도구 | 용도 |
|------|------|------|
| 비전 판정(VLM) | **Ollama + Qwen2.5-VL 3B** (`qwen2.5vl:3b`) | OCR·패턴 점수가 애매할 때 이미지를 눈으로 보고 스캠 여부 최종 판정 |
| 문자 인식(OCR) | **Tesseract.js** (한국어+영어, `kor+eng`) | 이미지 속 글자 추출 (traineddata 동봉) |
| 바이러스 검사 | **ClamAV** (`clamdscan` 데몬) | 모든 첨부를 시그니처 기반으로 검사, 감염 시 삭제 |

탐지 파이프라인(싼 것 → 비싼 것): **이미지 해시(dHash) → QR 해독 → OCR → 패턴 점수 → 로컬 VLM**.
점수 임계값 이상 + 서로 다른 신호 2종류 이상일 때만 자동 삭제해 오삭제를 막습니다.

> 세 가지 로컬 도구는 모두 **선택**입니다. Ollama/ClamAV가 없으면 그 단계는 조용히 스킵되고,
> 해시·OCR·패턴 점수만으로도 동작합니다. VLM은 CPU 추론이라 느리므로 애매한 이미지에만 호출됩니다.

## 요구 사항

- **Node.js 18 이상** (전역 `fetch` / `AbortSignal.timeout` 사용)
- Discord 봇 토큰
- (선택) **Ollama** — 이미지 비전 판정을 쓰려면
- (선택) **ClamAV** — 첨부 바이러스 검사를 쓰려면

## 설치

### 1) 코드 받기 & 의존성 설치

```bash
git clone git@github.com:cerbagge/AntiHacker.git
cd AntiHacker
npm install
```

### 2) 로컬 AI(VLM) 설치 — Ollama + Qwen2.5-VL 3B  *(선택)*

```bash
# Ollama 설치 (Linux/macOS)
curl -fsSL https://ollama.com/install.sh | sh

# 사용하는 비전 모델 내려받기
ollama pull qwen2.5vl:3b

# Ollama 데몬이 http://127.0.0.1:11434 에서 떠 있으면 봇이 자동으로 연결
```

> 온디바이스 CPU 추론이라 RAM 여유가 필요합니다(32GB 권장). RAM이 부족하면
> `.env` 에서 `SCAM_VLM_ENABLED=false` 로 끄고 해시/OCR/패턴만 써도 됩니다.

### 3) 바이러스 검사 설치 — ClamAV  *(선택)*

```bash
# Debian/Ubuntu
sudo apt install clamav-daemon
sudo systemctl enable --now clamav-daemon
# clamdscan 바이너리가 PATH 에 있으면 봇이 자동 사용 (없으면 스킵)
```

### 4) 환경 변수 설정

```bash
cp .env.example .env
# .env 를 열어 DISCORD_BOT_TOKEN 등을 채운다
```

주요 항목(자세한 설명은 `.env.example` 참고):

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `DISCORD_BOT_TOKEN` | — | (필수) 디스코드 봇 토큰 |
| `SCAM_IMAGE_GUARD_ENABLED` | `false` | 로컬 스캠 이미지 감지 전체 스위치 (`true` 권장) |
| `SCAM_AUTODELETE_THRESHOLD` | `70` | 자동삭제 점수 임계값 |
| `SCAM_VLM_ENABLED` | `true` | 로컬 VLM(Ollama) 사용 여부 (없으면 자동 스킵) |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama 주소 |
| `OLLAMA_VLM_MODEL` | `qwen2.5vl:3b` | 사용할 비전 모델 |
| `VIRUS_SCAN_ENABLED` | `true` | ClamAV 첨부 검사 사용 여부 |

서버 잠금(허용목록)은 루트의 `allowedGuilds.json` 에 서버 ID를 넣어 설정합니다.
(빈 배열 `[]` = 모든 서버 허용)

### 5) 실행

```bash
npm start        # node src/index.js
# 개발 중 자동 재시작
npm run dev      # nodemon
```

## 라이선스

`LICENSE.txt` 참고.
