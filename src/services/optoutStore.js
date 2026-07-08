const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const OPTOUT_PATH = path.join(__dirname, '..', '..', 'optout.json');

// 파일에서 거부 목록 로드
let optedOutUsers = new Set();
try {
  if (fs.existsSync(OPTOUT_PATH)) {
    const data = JSON.parse(fs.readFileSync(OPTOUT_PATH, 'utf-8'));
    optedOutUsers = new Set(data);
  }
} catch (e) {
  logger.warn('optout.json 로드 실패', { error: e.message });
}

function save() {
  fs.writeFileSync(OPTOUT_PATH, JSON.stringify([...optedOutUsers], null, 2));
}

function optout(userId) {
  optedOutUsers.add(userId);
  save();
}

function optin(userId) {
  optedOutUsers.delete(userId);
  save();
}

function isOptedOut(userId) {
  return optedOutUsers.has(userId);
}

module.exports = { optout, optin, isOptedOut };
