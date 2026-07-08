/**
 * ClamAV 바이러스 검사 (로컬). 같은 머신의 clamd 데몬을 사용한다.
 *
 * unlockzip(`/home/mnt/Web/unlockzip`)과 동일 패턴:
 *   clamdscan --no-summary --infected --fdpass <파일>
 *   종료코드  0=clean · 1=infected(시그니처 파싱) · 2=error
 *
 * ClamAV가 없거나 데몬이 죽어 있으면 조용히 건너뜀(available=false, clean=true).
 * AI가 아니라 시그니처 기반이라 가볍다(데몬 상주, ~10ms/scan) — RAM 업그레이드와 무관하게 동작.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const config = require('../config');
const logger = require('../utils/logger');

const execFileP = promisify(execFile);

// 가용성 캐시 (데몬/바이너리 없을 때 매번 확인 안 하도록)
let availability = { ok: null, checkedAt: 0 };
const AVAIL_TTL_MS = 60 * 1000;

async function isAvailable() {
  if (!config.VIRUS_SCAN_ENABLED) return false;
  const now = Date.now();
  if (availability.ok !== null && now - availability.checkedAt < AVAIL_TTL_MS) {
    return availability.ok;
  }
  let ok = false;
  try {
    await execFileP(config.CLAMAV_BINARY, ['--version'], { timeout: 5000 });
    ok = true;
  } catch {
    ok = false;
  }
  availability = { ok, checkedAt: now };
  if (!ok) logger.info('ClamAV 미사용 — 바이러스 검사 건너뜀', { binary: config.CLAMAV_BINARY });
  return ok;
}

function parseSignatures(stdout) {
  const sigs = [];
  for (let line of String(stdout || '').split('\n')) {
    line = line.trim();
    if (line.endsWith('FOUND')) {
      // "<path>: <SIGNATURE> FOUND"
      const idx = line.lastIndexOf(':');
      if (idx !== -1) {
        const sig = line.slice(idx + 1).replace(/FOUND$/, '').trim();
        if (sig) sigs.push(sig);
      }
    }
  }
  return sigs;
}

/**
 * 버퍼를 ClamAV로 검사.
 * @returns {Promise<{clean:boolean, available:boolean, signatures:string[], error?:string}>}
 *   - available=false : ClamAV 미사용(검사 안 함) → clean=true 로 간주
 *   - clean=false     : 감염(signatures)
 *   - 스캐너 자체 오류(종료코드 2/타임아웃)는 오삭제 방지를 위해 clean=true 로 통과시키되 로그
 */
async function scanBuffer(buffer, hintName = 'file') {
  if (!buffer || !(await isAvailable())) {
    return { clean: true, available: false, signatures: [] };
  }

  const tmp = path.join(os.tmpdir(), `ah-scan-${crypto.randomUUID()}`);
  try {
    await fs.promises.writeFile(tmp, buffer, { mode: 0o600 });

    const args = ['--no-summary', '--infected'];
    if (config.CLAMAV_BINARY.endsWith('clamdscan')) args.push('--fdpass');
    else args.push('-r');
    args.push(tmp);

    try {
      await execFileP(config.CLAMAV_BINARY, args, { timeout: config.CLAMAV_TIMEOUT_MS });
      return { clean: true, available: true, signatures: [] }; // 종료코드 0
    } catch (e) {
      if (e.code === 1) {
        return { clean: false, available: true, signatures: parseSignatures(e.stdout) };
      }
      if (e.killed || e.signal === 'SIGTERM') {
        logger.warn('ClamAV 스캔 타임아웃', { file: hintName });
        return { clean: true, available: true, signatures: [], error: 'clamav_timeout' };
      }
      logger.warn('ClamAV 스캔 오류(통과 처리)', { code: e.code, err: String(e.stderr || '').slice(0, 200) });
      return { clean: true, available: true, signatures: [], error: `clamav_exit_${e.code}` };
    }
  } catch (e) {
    logger.warn('ClamAV 임시파일 처리 실패', { error: e.message });
    return { clean: true, available: false, signatures: [] };
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

module.exports = { scanBuffer, isAvailable };
