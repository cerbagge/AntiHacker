/**
 * 알림 저장소 — 알림 ID별 데이터를 메모리에 보관
 */
const statsStore = require('./statsStore');

const alerts = new Map();
let nextId = 1;

function createAlert(data) {
  const id = nextId++;
  statsStore.incrementDetections(); // 탐지 완료 1건 (봇 상태 누적 카운터)
  const alert = {
    id,
    createdAt: new Date().toISOString(),
    ...data,
    resolved: false,
    assignedDangerPercent: null,
  };
  alerts.set(id, alert);
  return alert;
}

function getAlert(id) {
  return alerts.get(id) || null;
}

function resolveAlert(id, dangerPercent) {
  const alert = alerts.get(id);
  if (!alert) return null;
  alert.assignedDangerPercent = dangerPercent;
  alert.resolved = true;
  alert.resolvedAt = new Date().toISOString();
  return alert;
}

function getAllAlerts() {
  return [...alerts.values()];
}

module.exports = { createAlert, getAlert, resolveAlert, getAllAlerts };
