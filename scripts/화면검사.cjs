// 화면 검사 (trusted runner): runs only inside the engine's Codex sandbox (no network, writes only in the project
// folder and temp). It drives the installed Edge/Chrome directly over the DevTools pipe (--remote-debugging-pipe),
// so no package is needed and nothing listens on a port. For each page and width it saves a full-page capture under
// .hq-screens/ and reports layout problems a program can see.
// Usage: node 화면검사.cjs <browser.exe> '<["index.html"]>'
// Seen on this PC (Edge 1xx, codex-cli 0.158 sandbox): the GPU process dies inside the sandbox and Edge's own
// sandbox cannot start there, so the GPU runs in-process and Edge's sandbox is off; the outer sandbox still holds it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const [browserPath, pagesArg] = process.argv.slice(2);
const root = fs.realpathSync(process.cwd());
const WIDTHS = [1440, 390];
const MAX_HEIGHT = 10000;

function safePage(rel) {
  if (typeof rel !== 'string' || !/\.html?$/i.test(rel)) throw new Error('invalid page');
  const full = fs.realpathSync(path.resolve(root, rel));
  if (!full.startsWith(root + path.sep) || !fs.statSync(full).isFile()) throw new Error('outside workspace');
  return full;
}
function screensDir() {
  const dir = path.join(root, '.hq-screens');
  if (fs.existsSync(dir) && (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory())) throw new Error('unsafe output');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// One DevTools connection over the pipe: messages are JSON separated by a NUL byte.
function connect(child) {
  const out = child.stdio[3], inp = child.stdio[4];
  let id = 0, buf = '';
  const waiting = new Map(), listeners = [];
  inp.setEncoding('utf8');
  inp.on('data', chunk => {
    buf += chunk;
    let at;
    while ((at = buf.indexOf('\0')) >= 0) {
      const msg = JSON.parse(buf.slice(0, at)); buf = buf.slice(at + 1);
      if (msg.id && waiting.has(msg.id)) { const w = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result); }
      else for (const l of listeners) l(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const n = ++id; waiting.set(n, { resolve, reject });
    out.write(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  return { send, on: l => listeners.push(l) };
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const pages = JSON.parse(pagesArg);
  if (!Array.isArray(pages) || !pages.length || pages.length > 5) throw new Error('invalid pages');
  const files = pages.map(p => [p, safePage(p)]);
  const outDir = screensDir();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-visual-'));
  const child = spawn(browserPath, ['--headless=new', '--remote-debugging-pipe', '--no-sandbox', '--in-process-gpu', '--disable-gpu',
    '--disable-gpu-compositing', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--mute-audio', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
  const cdp = connect(child);
  const results = [];
  try {
    for (const [rel, full] of files) for (const width of WIDTHS) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const s = (m, p) => cdp.send(m, p, sessionId);
      let errors = 0, failed = 0, loaded = false;
      cdp.on(msg => {
        if (msg.sessionId !== sessionId) return;
        if (msg.method === 'Runtime.exceptionThrown') errors++;
        if (msg.method === 'Network.loadingFailed' && !msg.params.canceled) failed++;
        if (msg.method === 'Page.loadEventFired') loaded = true;
      });
      await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable');
      await s('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
      await s('Page.navigate', { url: pathToFileURL(full).href });
      for (let t = 0; t < 100 && !loaded; t++) await wait(100);
      await wait(400); // fonts and late layout
      // Seen in a design comparison: sections that appear on scroll (IntersectionObserver) never appeared in a one-shot
      // full-page capture, and a page-load fade was caught halfway, so lively pages looked washed out. Scroll through
      // the page as a person would, then finish every animation and transition, so the capture shows the end state.
      await s('Runtime.evaluate', { awaitPromise: true, expression: `(async () => {
        const step = Math.max(300, innerHeight * 0.6), end = Math.min(document.documentElement.scrollHeight, ${MAX_HEIGHT});
        for (let y = 0; y < end; y += step) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
        window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 200));
        for (const a of document.getAnimations()) { try { a.finish(); } catch { /* infinite: leave it */ } }
        return true;
      })()` });
      await wait(150);
      // The device width, not innerWidth: in phone mode the browser widens the layout to fit content that overflows.
      const { result } = await s('Runtime.evaluate', { returnByValue: true, expression: `(() => {
        const out = [], vw = ${width};
        if (document.documentElement.scrollWidth > vw + 1) {
          const wide = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > vw + 1; })
            .slice(0, 3).map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : e.classList[0] ? '.' + e.classList[0] : ''));
          out.push('가로 넘침 (' + document.documentElement.scrollWidth + 'px > ' + vw + 'px' + (wide.length ? ' · ' + wide.join(', ') : '') + ')');
        }
        if (!document.body || !document.body.innerText.trim()) out.push('화면에 보이는 글이 없음');
        const broken = [...document.images].filter(i => !i.complete || !i.naturalWidth).length;
        if (broken) out.push('깨진 이미지 ' + broken + '개');
        if ([...document.querySelectorAll('button, a')].some(b => b.getClientRects().length && !b.textContent.trim() && !b.getAttribute('aria-label') && !b.querySelector('img[alt]')))
          out.push('이름 없는 버튼·링크');
        const tiny = [...document.querySelectorAll('p, li, td, a, button, span')].filter(e => e.getClientRects().length && e.textContent.trim()
          && parseFloat(getComputedStyle(e).fontSize) < 12).length;
        if (tiny) out.push('12px보다 작은 글자 ' + tiny + '곳');
        // Text that stays almost transparent after the whole page was scrolled and every animation finished cannot be
        // read (seen: a scroll-reveal threshold a tall phone-width table never reached, so the menu never appeared).
        // Short decorative text (a big faded "01") is left alone.
        const opacityOf = e => { let o = 1; for (let n = e; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
        const faded = [...document.querySelectorAll('p, li, td, th, h1, h2, h3, h4, dd, figcaption, blockquote')]
          .filter(e => e.getClientRects().length && e.textContent.trim().length >= 12 && getComputedStyle(e).visibility !== 'hidden' && opacityOf(e) < 0.35);
        if (faded.length) out.push('거의 보이지 않는 글 ' + faded.length + '곳 (스크롤해도 나타나지 않음 · ' + faded.slice(0, 2).map(e => e.tagName.toLowerCase() + (e.closest('[id]') ? '#' + e.closest('[id]').id : '')).join(', ') + ')');
        return { issues: out, height: Math.min(document.documentElement.scrollHeight, ${MAX_HEIGHT}) };
      })()` });
      const found = result.value ?? { issues: ['검사 스크립트 실행 실패'], height: 900 };
      if (errors) found.issues.push('JavaScript 실행 오류 ' + errors + '건');
      if (failed) found.issues.push('불러오지 못한 파일·외부 자원 ' + failed + '건 (인터넷은 막혀 있음)');
      const shot = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height: Math.max(found.height, 200), scale: 1 } });
      const name = '화면-' + rel.replace(/[\\/]/g, '__').replace(/\.html?$/i, '') + `-${width}.png`;
      fs.writeFileSync(path.join(outDir, name), Buffer.from(shot.data, 'base64'));
      results.push({ file: rel, width, issues: found.issues, screenshot: `.hq-screens/${name}` });
      await cdp.send('Target.closeTarget', { targetId });
    }
  } finally {
    try { await cdp.send('Browser.close'); } catch { child.kill(); }
    await wait(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Edge may still hold it; temp is cleaned later */ }
  }
  console.log('AGENT_HQ_VISUAL ' + JSON.stringify({ pages: results }));
  process.exit(0);
})().catch(e => { console.error('visual check failed: ' + String(e && e.message || e).slice(0, 200)); process.exit(1); });
