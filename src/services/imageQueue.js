/**
 * 이미지 처리 안정장치 — 동시 처리 상한 + 대기열.
 *
 * 슬롯을 "다운로드 전에" 잡으므로, 대기 중인 메시지는 이미지 버퍼를 들지 않는다
 * → 메모리는 동시 처리 수(MAX_CONCURRENT)로 고정되고, 대기열은 거의 공짜로 쌓인다.
 * 대기열까지 가득 차면(MAX_QUEUE) 과부하로 보고 acquire 가 false 를 반환 → 호출부는 검사를 건너뛴다(fail-open).
 *
 * 단일 OCR 워커라 OCR 자체는 어차피 직렬이지만, 이 상한은 폭주(raid)성 동시 업로드로부터
 * 메모리/이벤트루프를 보호하는 게 목적.
 */
const config = require('../config');

const MAX_CONCURRENT = config.IMAGE_MAX_CONCURRENT;
const MAX_QUEUE = config.IMAGE_MAX_QUEUE;

let active = 0;
const queue = []; // 대기 중인 resolve 콜백들

/** 슬롯 획득. 즉시 또는 대기 후 true, 대기열까지 가득 차면 false(스킵). */
function acquire() {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve(true);
  }
  if (queue.length >= MAX_QUEUE) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => queue.push(resolve));
}

/** 슬롯 반환. 대기자가 있으면 슬롯을 그대로 인계한다. */
function release() {
  const next = queue.shift();
  if (next) {
    next(true); // active 유지(슬롯 인계)
  } else if (active > 0) {
    active--;
  }
}

function stats() {
  return { active, queued: queue.length, maxConcurrent: MAX_CONCURRENT, maxQueue: MAX_QUEUE };
}

module.exports = { acquire, release, stats };
