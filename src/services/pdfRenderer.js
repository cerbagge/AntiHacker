/**
 * PDF → 스캠 스캔 입력 변환 (poppler-utils: pdfinfo / pdftotext / pdftoppm)
 *
 * 스캠 PDF는 글자보다 이미지·QR로 된 경우가 많아, 앞쪽 몇 페이지를 PNG로 렌더링해
 * 기존 이미지 파이프라인(해시·OCR·QR·VLM)에 넣는다. 텍스트 레이어와 링크 주석
 * ("여기를 클릭" 뒤에 숨은 URL)은 따로 뽑아 패턴 점수용 동봉 텍스트로 붙인다.
 *
 * poppler 가 없거나 PDF가 깨졌거나 암호가 걸려 있으면 null → 스캔 스킵(ClamAV 검사는 별도로 이미 수행).
 *   설치: sudo apt-get install -y poppler-utils
 */
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const logger = require('../utils/logger');

const execFileP = promisify(execFile);

const MAX_PAGES = 3; // 앞 페이지만 (스캠 유도 문구는 거의 첫 장)
const RENDER_DPI = 110; // A4 ≈ 900x1300px — OCR 에 충분하고 빠름
const TIMEOUT_MS = 20000;

function isPdfAttachment(att) {
  return att.contentType === 'application/pdf' || /\.pdf$/i.test(att.name || '');
}

/**
 * 텍스트·링크는 페이지별로 나눈다 — 문서 전체 텍스트를 모든 페이지에 붙이면 정상 표지가
 * 뒤 페이지의 스캠 문구로 삭제 판정을 받고 그 표지 해시가 블록리스트에 학습된다.
 * @param {Buffer} buffer PDF 원본
 * @returns {Promise<Array<{image: Buffer, text: string}>|null>} 페이지별 PNG + 그 페이지 텍스트/링크. 실패 시 null
 */
async function renderPdf(buffer) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ahpdf-'));
  const file = path.join(dir, 'in.pdf');
  try {
    await fs.promises.writeFile(file, buffer);
    const run = (cmd, args) => execFileP(cmd, args, { timeout: TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });

    const last = String(MAX_PAGES);
    const [{ stdout: text }, urls] = await Promise.all([
      run('pdftotext', ['-l', last, '-q', file, '-']),
      run('pdfinfo', ['-url', file]).then((r) => r.stdout).catch(() => ''),
    ]);

    await run('pdftoppm', ['-png', '-r', String(RENDER_DPI), '-l', last, '-q', file, path.join(dir, 'p')]);
    const names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.png')).sort();
    if (names.length === 0) return null;

    // pdftotext 는 페이지 사이를 \f(form feed)로 구분한다
    const pageTexts = text.split('\f');
    // pdfinfo -url 출력: "Page  Type  URL" 표 — 페이지 번호별로 URL 을 모은다
    const pageUrls = {};
    for (const line of urls.split('\n')) {
      const [page, , url] = line.trim().split(/\s+/);
      if (/^\d+$/.test(page) && /^https?:\/\//i.test(url || '')) (pageUrls[page] = pageUrls[page] || []).push(url);
    }

    // await 필수 — finally 의 임시 디렉터리 삭제가 파일 읽기보다 먼저 돌지 않게
    return await Promise.all(names.map(async (n) => {
      const page = Number(/-(\d+)\.png$/.exec(n)[1]); // pdftoppm 출력: p-1.png / p-01.png
      return {
        image: await fs.promises.readFile(path.join(dir, n)),
        text: `${pageTexts[page - 1] || ''}\n${(pageUrls[page] || []).join('\n')}`,
      };
    }));
  } catch (e) {
    logger.warn('PDF 렌더링 실패(스캠 스캔 스킵)', { error: e.message.split('\n')[0] });
    return null;
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { isPdfAttachment, renderPdf };
