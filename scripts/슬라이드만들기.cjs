// 슬라이드 만들기 (trusted runner): runs only inside the engine's Codex sandbox (no network, writes only in the project
// folder and temp). A team writes slides/<id>/index.tsx (open-slide, MIT, installed by 대장's approval into
// tools/open-slide, version pinned). This builds the deck in a temporary workspace, opens it in the installed Edge over
// the DevTools pipe, serves the built files itself (Fetch interception: no server, no port, no network), triggers
// open-slide's own PDF export and prints it to 발표자료/<id>.pdf, saves a capture of every page under .hq-screens/ and
// reports pages whose content runs past the 1920×1080 canvas.
// Usage: node 슬라이드만들기.cjs <tools/open-slide> <browser.exe> '<["deck-id"]>'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const [toolsArg, browserPath, idsArg] = process.argv.slice(2);
const root = fs.realpathSync(process.cwd());
const tools = fs.realpathSync(toolsArg);
const ID = /^[a-z0-9가-힣][a-z0-9가-힣-]{0,40}$/;
const HOST = 'http://slides.local';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm' };

function inside(full) { return full === root || full.startsWith(root + path.sep); }
function outDir(name) {
  const dir = path.join(root, name);
  if (fs.existsSync(dir) && (fs.lstatSync(dir).isSymbolicLink() || !fs.statSync(dir).isDirectory())) throw new Error('unsafe output');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// Copies a folder of the project into the build workspace: regular files only (no links), at most 200 files / 50 MB.
function copyTree(from, to, budget) {
  if (!fs.existsSync(from)) return;
  const real = fs.realpathSync(from);
  if (!inside(real) || fs.lstatSync(from).isSymbolicLink()) throw new Error('unsafe source folder');
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name), st = fs.lstatSync(src);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) copyTree(src, path.join(to, name), budget);
    else if (st.isFile()) {
      budget.files++; budget.bytes += st.size;
      if (budget.files > 200 || budget.bytes > 50 * 1024 * 1024) throw new Error('deck too large (200 files / 50 MB)');
      fs.copyFileSync(src, path.join(to, name));
    }
  }
}

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
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const ids = JSON.parse(idsArg);
  if (!Array.isArray(ids) || !ids.length || ids.length > 3 || !ids.every(i => typeof i === 'string' && ID.test(i))) throw new Error('invalid deck ids');
  for (const id of ids) {
    const file = path.join(root, 'slides', id, 'index.tsx');
    if (!fs.existsSync(file) || !inside(fs.realpathSync(file)) || !fs.statSync(file).isFile()) throw new Error(`slides/${id}/index.tsx 없음`);
  }
  // Build workspace: the pinned tools config and node_modules (a junction, read-only use) plus only the decks asked for.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-slides-'));
  for (const f of ['package.json', 'open-slide.config.ts', 'tsconfig.json']) fs.copyFileSync(path.join(tools, f), path.join(work, f));
  // node_modules is a real folder here (Vite writes its .vite-temp into it, and tools/ is read-only in the sandbox);
  // each package inside is a junction to the pinned install.
  const mods = path.join(work, 'node_modules');
  fs.mkdirSync(mods);
  for (const name of fs.readdirSync(path.join(tools, 'node_modules'))) {
    if (name.startsWith('.')) continue;
    fs.symlinkSync(path.join(tools, 'node_modules', name), path.join(mods, name), 'junction');
  }
  const budget = { files: 0, bytes: 0 };
  // A Korean deck name is built under an English alias (open-slide routes are URL paths); outputs keep the name.
  const alias = new Map(ids.map((id, i) => [id, /^[a-z0-9-]+$/.test(id) ? id : `hq-deck-${i + 1}`]));
  if (new Set(alias.values()).size !== ids.length) throw new Error('deck names collide');
  for (const id of ids) copyTree(path.join(root, 'slides', id), path.join(work, 'slides', alias.get(id)), budget);
  copyTree(path.join(root, 'assets'), path.join(work, 'assets'), budget);
  const built = spawnSync(process.execPath, [path.join(tools, 'node_modules', '@open-slide', 'core', 'bin.js'), 'build'],
    { cwd: work, encoding: 'utf8', timeout: 180_000, windowsHide: true, env: { ...process.env, NO_COLOR: '1', CI: '1' } });
  const dist = path.join(work, 'dist');
  if (built.status !== 0 || !fs.existsSync(path.join(dist, 'index.html'))) {
    const tail = String((built.stderr || '') + (built.stdout || '')).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
    console.log('AGENT_HQ_SLIDES ' + JSON.stringify({ decks: ids.map(id => ({ id, error: '빌드 실패', detail: tail.slice(-1500) })) }));
    return;
  }

  const pdfDir = outDir('발표자료'), screens = outDir('.hq-screens');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-slides-edge-'));
  const child = spawn(browserPath, ['--headless=new', '--remote-debugging-pipe', '--no-sandbox', '--in-process-gpu', '--disable-gpu',
    '--disable-gpu-compositing', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--mute-audio', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
  const cdp = connect(child);
  const decks = [];
  try {
    for (const id of ids) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const s = (m, p) => cdp.send(m, p, sessionId);
      let errors = 0;
      // Every request is answered from dist/ (unknown paths get index.html, the app's own router); anything else fails.
      cdp.on(msg => {
        if (msg.sessionId !== sessionId) return;
        if (msg.method === 'Runtime.exceptionThrown') errors++;
        if (msg.method !== 'Fetch.requestPaused') return;
        const { requestId, request } = msg.params;
        let body = null, type = 'text/html';
        if (request.url.startsWith(HOST + '/')) {
          const rel = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, '');
          let file = path.resolve(dist, rel || 'index.html');
          if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(dist, 'index.html');
          body = fs.readFileSync(file); type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
        }
        if (body) s('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }], body: body.toString('base64') }).catch(() => {});
        else s('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      });
      await s('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      await s('Page.enable'); await s('Runtime.enable');
      await s('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
      await s('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__hqPrinted = 0; window.print = () => { window.__hqPrinted++; };' });
      await s('Page.navigate', { url: `${HOST}/s/${alias.get(id)}` });
      const ev = async expression => (await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
      for (let i = 0; i < 80 && !(await ev("document.readyState === 'complete' && !!document.querySelector('[aria-label=\"Download\"]')")); i++) await wait(250);
      // open-slide's own export: Download → PDF lays every page out in a print root, then calls print().
      const clicked = await ev(`(async () => {
        const find = re => [...document.querySelectorAll('button,[role=menuitem]')].find(b => re.test((b.getAttribute('aria-label') || '') + ' ' + b.textContent));
        const menu = find(/^download/i); if (!menu) return 'no download menu';
        menu.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); menu.click();
        await new Promise(r => setTimeout(r, 600));
        const pdf = find(/pdf/i); if (!pdf) return 'no pdf item'; pdf.click(); return 'ok';
      })()`);
      if (clicked !== 'ok') { decks.push({ id, error: 'PDF 내보내기를 찾지 못함 (' + clicked + ')' }); continue; }
      for (let i = 0; i < 120 && !(await ev('window.__hqPrinted')); i++) await wait(250);
      const pages = await ev("document.querySelectorAll('#os-print-root .os-print-frame').length");
      if (!pages) { decks.push({ id, error: '페이지를 하나도 그리지 못함', scriptErrors: errors }); continue; }
      // Content past the canvas: an element whose box leaves its 1920×1080 frame (the frame clips it on paper).
      const overflow = await ev(`[...document.querySelectorAll('#os-print-root .os-print-frame')].map((f, i) => {
        const r = f.getBoundingClientRect(); let n = 0;
        for (const e of f.querySelectorAll('*')) { const b = e.getBoundingClientRect(); if (!b.width || !b.height) continue;
          if (b.right > r.right + 2 || b.bottom > r.bottom + 2 || b.left < r.left - 2 || b.top < r.top - 2) n++; }
        return n ? (i + 1) : 0; }).filter(Boolean)`);
      // Notes for the team, not failures (대장 found the first deck's pages top-heavy with small captions, 2026-10-01):
      // where the content ends on each page (a full-page background does not count) and the smallest text on it.
      const layout = await ev(`[...document.querySelectorAll('#os-print-root .os-print-frame')].map((f, i) => {
        const r = f.getBoundingClientRect(); let bottom = r.top, min = Infinity;
        for (const e of f.querySelectorAll('*')) {
          const b = e.getBoundingClientRect(), cs = getComputedStyle(e);
          if (!b.width || !b.height || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
          if (b.width >= r.width * 0.95 && b.height >= r.height * 0.95) continue;
          const own = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
          const isMedia = /^(IMG|SVG|CANVAS|VIDEO)$/i.test(e.tagName);
          // A page number ("3 / 6", "03") sits at the bottom of every page and says nothing about how full it is.
          const pageNo = /^\\d{1,3}(\\s*\\/\\s*\\d{1,3})?$/.test(own);
          if ((own && !pageNo) || isMedia) bottom = Math.max(bottom, b.bottom);
          if (own.length >= 4 && !pageNo) min = Math.min(min, parseFloat(cs.fontSize));
        }
        return { page: i + 1, filled: Math.round((bottom - r.top) / r.height * 100), minFont: Number.isFinite(min) ? Math.round(min) : null };
      })`);
      const sparsePages = layout.filter(p => p.filled < 70).map(p => p.page);
      const smallText = layout.filter(p => p.minFont !== null && p.minFont < 24).map(p => ({ page: p.page, px: p.minFont }));
      // One capture per page first (open-slide clears its print root once printing is over): the print root shown on
      // screen, each frame clipped out.
      await ev(`(() => { const st = document.createElement('style'); st.id = 'hq-shot'; st.textContent = '@media screen{#os-print-root{position:static!important;left:0!important}body>*:not(#os-print-root){display:none!important}}'; document.head.appendChild(st); return true; })()`);
      await wait(300);
      const rects = await ev("[...document.querySelectorAll('#os-print-root .os-print-frame')].map(f => { const r = f.getBoundingClientRect(); return [r.left + scrollX, r.top + scrollY, r.width, r.height]; })");
      const shots = [];
      for (let i = 0; i < Math.min(rects.length, 40); i++) {
        const [x, y, w, h] = rects[i];
        const { data: png } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x, y, width: w, height: h, scale: 0.5 } });
        const name = `슬라이드-${id}-${String(i + 1).padStart(2, '0')}.png`;
        fs.writeFileSync(path.join(screens, name), Buffer.from(png, 'base64'));
        shots.push('.hq-screens/' + name);
      }
      // The text of every page, read from the same print root that becomes the PDF (자율 시험 4차, 2026-10-02: the verifier
      // could not check "the PDF has 일정·신청 방법·문의처" from the source and captures). kordoc cannot read a PDF here:
      // its pdfjs-dist is an optional part 대장's install left out.
      const texts = await ev("[...document.querySelectorAll('#os-print-root .os-print-frame')].map(f => f.innerText.replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim())");
      const textFile = path.join(pdfDir, `${id}.pdf.md`);
      fs.writeFileSync(textFile, texts.map((t, i) => `## ${i + 1}쪽\n\n${t}\n`).join('\n'));
      await ev("document.getElementById('hq-shot').remove(), true");
      await s('Emulation.setEmulatedMedia', { media: 'print' });
      const { data } = await s('Page.printToPDF', { preferCSSPageSize: true, printBackground: true });
      const pdfFile = path.join(pdfDir, `${id}.pdf`);
      fs.writeFileSync(pdfFile, Buffer.from(data, 'base64'));
      decks.push({ id, pages, pdf: path.relative(root, pdfFile).replace(/\\/g, '/'), text: path.relative(root, textFile).replace(/\\/g, '/'), screenshots: shots, overflowPages: overflow, scriptErrors: errors, sparsePages, smallText });
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    }
  } finally { child.kill(); }
  console.log('AGENT_HQ_SLIDES ' + JSON.stringify({ decks }));
})().catch(e => { console.log('slide make failed: ' + e.message); process.exit(1); });
