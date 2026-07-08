/**
 * 누적 탐지 통계 — 재시작해도 유지되도록 루트 JSON에 저장한다.
 * 현재는 "탐지 완료(삭제·제재가 실행된) 총 건수" 하나만 집계한다. (봇 상태 표시용)
 * 저장 방식은 기존 optoutStore/scamHashStore 컨벤션을 따름 (루트에 JSON 파일).
 */
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const STORE_PATH = path.join(__dirname, '..', '..', 'stats.json');

let stats = { detections: 0 };
try {
  if (fs.existsSync(STORE_PATH)) {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    if (data && Number.isFinite(data.detections)) stats = { detections: data.detections };
  }
} catch (e) {
  logger.warn('stats.json 로드 실패', { error: e.message });
}

function save() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(stats, null, 0));
  } catch (e) {
    logger.warn('stats.json 저장 실패', { error: e.message });
  }
}

/** 탐지 완료 1건 가산 후 누적값 반환 */
function incrementDetections() {
  stats.detections += 1;
  save();
  return stats.detections;
}

function getDetections() {
  return stats.detections;
}

module.exports = { incrementDetections, getDetections, STORE_PATH };
