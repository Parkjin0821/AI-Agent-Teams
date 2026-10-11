// 브라우저 읽기 (trusted runner): opens ONE public web page in the installed Edge/Chrome, headless, with a fresh empty
// profile, lets its scripts render, then saves a full-page capture and prints the visible text. Reading only:
//   - no input of any kind (no click, no typing, no form), and a fresh profile, so no login session exists;
//   - every request goes through the DevTools Fetch hook: only GET/HEAD/OPTIONS to public https hosts pass (a form
//     submission, a payment call or any other POST is refused); names that resolve to this computer or an internal
//     network are refused; WebSockets are blocked; downloads are denied; dialogs are dismissed; pop-up windows closed.
// The DevTools connection is the --remote-debugging-pipe (nothing listens on a port). Edge keeps its own sandbox on.
// Usage: node 브라우저읽기.cjs <browser.exe> <https url> <capture.png path inside the current folder>
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns').promises;
const net = require('node:net');
const { spawn } = require('node:child_process');

const WIDTH = 1280, MAX_HEIGHT = 10000, MAX_TEXT = 400_000, LOAD_MS = 20_000;
const METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function privateIp(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = String(ip).toLowerCase();
  if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}
const privateName = h => { const n = h.replace(/^\[|\]$/g, '').toLowerCase(); return !n.includes('.') || net.isIP(n) > 0 || /(^|\.)(localhost|local|internal|lan|home|corp)$/.test(n); };

// What may load: the page's own data: and blob: parts, and GET/HEAD/OPTIONS to public https names. Pure, for tests.
function requestAllowed(method, url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return true;
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (!METHODS.has(String(method).toUpperCase())) return false;
  return !privateName(u.hostname);
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

async function main() {
  const [browserPath, startUrl, captureArg] = process.argv.slice(2);
  if (!requestAllowed('GET', startUrl)) throw new Error('not a public https address');
  const root = fs.realpathSync(process.cwd());
  const capture = path.resolve(root, String(captureArg ?? ''));
  if (!capture.startsWith(root + path.sep) || !capture.endsWith('.png')) throw new Error('capture path outside the folder');
  const resolved = new Map(); // host → allowed (true/false), resolved once
  const hostOk = async host => {
    if (!resolved.has(host)) {
      resolved.set(host, dns.lookup(host, { all: true }).then(list => list.length > 0 && !list.some(a => privateIp(a.address))).catch(() => false));
    }
    return resolved.get(host);
  };
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-read-'));
  const child = spawn(browserPath, ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-sync', '--disable-background-networking', '--disable-component-update', '--mute-audio', '--hide-scrollbars',
    `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true });
  const cdp = connect(child);
  const blocked = { method: 0, address: 0 };
  try {
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    // A page that opens another window gets it closed at once (it would load outside the request hook).
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    cdp.on(msg => { if (msg.method === 'Target.targetCreated' && msg.params.targetInfo.type === 'page' && msg.params.targetInfo.targetId !== targetId)
      cdp.send('Target.closeTarget', { targetId: msg.params.targetInfo.targetId }).catch(() => {}); });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (m, p) => cdp.send(m, p, sessionId);
    let loaded = false, inflight = 0, lastNet = Date.now();
    // Every request of the page, its cross-site frames and its workers (each its own target) passes the same hook.
    const hook = async sid => {
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sid);
      await cdp.send('Network.enable', {}, sid).catch(() => {});
      await cdp.send('Network.setBlockedURLs', { urls: ['ws://*', 'wss://*'] }, sid).catch(() => {});
      await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid).catch(() => {});
    };
    cdp.on(async msg => {
      if (msg.method === 'Target.attachedToTarget' && msg.sessionId) {
        const sid = msg.params.sessionId;
        try { await hook(sid); } catch { /* a target that cannot be hooked never runs */ cdp.send('Target.detachFromTarget', { sessionId: sid }, msg.sessionId).catch(() => {}); return; }
        cdp.send('Runtime.runIfWaitingForDebugger', {}, sid).catch(() => {});
        return;
      }
      if (msg.method === 'Fetch.requestPaused' && msg.sessionId) {
        const { requestId, request } = msg.params;
        let ok = requestAllowed(request.method, request.url);
        if (!ok) blocked.method++;
        else if (/^https:/.test(request.url) && !(await hostOk(new URL(request.url).hostname))) { ok = false; blocked.address++; }
        cdp.send(ok ? 'Fetch.continueRequest' : 'Fetch.failRequest', ok ? { requestId } : { requestId, errorReason: 'BlockedByClient' }, msg.sessionId).catch(() => {});
        return;
      }
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Page.loadEventFired') loaded = true;
      if (msg.method === 'Page.javascriptDialogOpening') s('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
      if (msg.method === 'Network.requestWillBeSent') { inflight++; lastNet = Date.now(); }
      if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') { inflight = Math.max(0, inflight - 1); lastNet = Date.now(); }
    });
    await hook(sessionId);
    await s('Page.enable');
    await s('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: false });
    await s('Page.navigate', { url: startUrl });
    const t0 = Date.now();
    while (Date.now() - t0 < LOAD_MS && !(loaded && inflight === 0 && Date.now() - lastNet > 800)) await wait(150);
    // Scroll through once so content that appears on scroll is there; no click, no key.
    await s('Runtime.evaluate', { awaitPromise: true, expression: `(async () => {
      const go = y => window.scrollTo({ top: y, left: 0, behavior: 'instant' });
      const end = Math.min(document.documentElement.scrollHeight, ${MAX_HEIGHT});
      for (let y = 0; y < end; y += Math.max(300, innerHeight * 0.8)) { go(y); await new Promise(r => setTimeout(r, 120)); }
      go(0); await new Promise(r => setTimeout(r, 300));
      return true; })()` });
    const { result } = await s('Runtime.evaluate', { returnByValue: true, expression: `(() => ({ title: document.title, url: location.href,
      text: (document.body ? document.body.innerText : '').slice(0, ${MAX_TEXT}),
      height: Math.min(document.documentElement.scrollHeight, ${MAX_HEIGHT}) }))()` });
    const page = result.value ?? { title: '', url: startUrl, text: '', height: 900 };
    const shot = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: WIDTH, height: Math.max(200, page.height), scale: 1 } });
    fs.mkdirSync(path.dirname(capture), { recursive: true });
    fs.writeFileSync(capture, Buffer.from(shot.data, 'base64'));
    console.log('AGENT_HQ_BROWSER ' + JSON.stringify({ title: String(page.title).slice(0, 300), url: page.url, text: page.text, blocked, loaded }));
  } finally {
    try { await cdp.send('Browser.close'); } catch { child.kill(); }
    await wait(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Edge may still hold it */ }
  }
}

module.exports = { requestAllowed, privateIp };
if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('browser read failed: ' + String(e && e.message || e).slice(0, 200)); process.exit(1); });
}
