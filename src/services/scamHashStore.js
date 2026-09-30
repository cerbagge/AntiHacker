/**
 * 스캠 이미지 pHash 블록리스트
 *
 * 한 번 "고신뢰 스캠"으로 판정되어 삭제된 이미지의 perceptual hash(64bit 이진 문자열)를
 * 저장해 둔다. 같은(혹은 거의 같은) 이미지가 다시 올라오면 OCR/AI 없이 즉시 차단한다.
 * 이 스캠은 동일 이미지가 서버마다 반복 게시되므로 가장 싸고 효과적인 1차 필터.
 *
 * 저장 방식은 기존 optoutStore.js 컨벤션을 따름 (루트에 JSON 파일).
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const HASH_PATH = path.join(__dirname, '..', '..', 'scamHashes.json');

// 두 해시가 이 해밍거리 이하이면 "같은 이미지"로 본다 (256bit dHash 기준).
// 자동삭제 fast-path이므로 정밀도 우선: 재압축/리사이즈된 "동일 이미지"만 잡고,
// 변형이 큰 변종은 OCR 계층에 맡긴다. (서로 다른 이미지의 오매칭 방지)
const DEFAULT_MAX_DISTANCE = 10;
const MAX_ENTRIES = 5000; // 과도한 증가 방지

// 학습 규칙이 바뀌면 올린다. 이전 버전 해시는 새 규칙이라면 학습되지 않았을 오탐
// (예: v1 은 AI 확정·거래 화면 스크린샷도 학습)을 담고 있을 수 있고, fast-path 가 새 화이트리스트보다
// 먼저 돌아 영구 삭제로 굳는다 → 버리고 다시 학습한다. 원본은 .legacy 파일로 보관.
const STORE_VERSION = 2;

let hashes = [];
try {
  if (fs.existsSync(HASH_PATH)) {
    const data = JSON.parse(fs.readFileSync(HASH_PATH, 'utf-8'));
    if (data && data.version === STORE_VERSION && Array.isArray(data.hashes)) {
      hashes = data.hashes;
    } else {
      const legacyPath = `${HASH_PATH}.legacy-v${(data && data.version) || 1}`;
      fs.renameSync(HASH_PATH, legacyPath);
      logger.info('이전 규칙으로 학습된 스캠 해시 폐기 — 새로 학습', {
        dropped: Array.isArray(data) ? data.length : (data && data.hashes ? data.hashes.length : 0),
        backup: path.basename(legacyPath),
      });
    }
  }
} catch (e) {
  logger.warn('scamHashes.json 로드 실패', { error: e.message });
  hashes = [];
}

function save() {
  try {
    const data = { version: STORE_VERSION, hashes: hashes.slice(-MAX_ENTRIES) };
    fs.writeFileSync(HASH_PATH, JSON.stringify(data, null, 0));
  } catch (e) {
    logger.warn('scamHashes.json 저장 실패', { error: e.message });
  }
}

/** 같은 길이 이진 문자열 간 해밍거리 */
function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) dist++;
  }
  return dist;
}

/** 알려진 스캠 해시와 일치(근접)하는지 → 일치 시 { hash, distance }, 없으면 null */
function matchKnownScam(hash, maxDistance = DEFAULT_MAX_DISTANCE) {
  if (!hash) return null;
  for (const known of hashes) {
    const d = hammingDistance(hash, known);
    if (d <= maxDistance) return { hash: known, distance: d };
  }
  return null;
}

/** 새 스캠 해시 추가 (이미 근접한 게 있으면 중복 저장 안 함) */
function addScamHash(hash) {
  if (!hash || typeof hash !== 'string') return false;
  if (matchKnownScam(hash, 8)) return false; // 거의 동일한 게 이미 있음
  hashes.push(hash);
  save();
  return true;
}

function count() {
  return hashes.length;
}

module.exports = { matchKnownScam, addScamHash, hammingDistance, count, DEFAULT_MAX_DISTANCE };
