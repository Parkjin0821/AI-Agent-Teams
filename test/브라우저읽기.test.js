import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readRendered, RENDER_HEADER } from '../src/브라우저읽기.js';

const require = createRequire(import.meta.url);
const { requestAllowed } = require('../scripts/브라우저읽기.cjs');

test('the browser only reads: GET/HEAD/OPTIONS to public https names; forms, payments, local and plain http are refused', () => {
  assert.equal(requestAllowed('GET', 'https://nodejs.org/en/about/previous-releases'), true);
  assert.equal(requestAllowed('HEAD', 'https://cdn.example.com/app.js'), true);
  assert.equal(requestAllowed('GET', 'data:image/png;base64,AAAA'), true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(requestAllowed(method, 'https://shop.example.com/checkout'), false, `${method} (form submission, payment)`);
  for (const url of ['http://example.com/', 'https://localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://192.168.0.1/', 'https://printer.local/',
    'https://intranet/', 'https://u:p@example.com/', 'file:///C:/Windows/win.ini', 'ftp://example.com/', 'not a url']) assert.equal(requestAllowed('GET', url), false, url);
});

const ws = () => mkdtempSync(path.join(tmpdir(), 'hq-render-'));
const publicDns = async () => [{ address: '104.20.22.46' }];
// A run that answers like the real runner did on nodejs.org (2026-10-11), writing the capture where it was told.
const fakeRun = (page) => async (browser, url, capture, cwd) => {
  mkdirSync(path.join(cwd, 'sources'), { recursive: true });
  writeFileSync(path.join(cwd, capture), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return { code: 0, out: 'AGENT_HQ_BROWSER ' + JSON.stringify({ title: 'Node.js Releases', url, text: 'v24  Krypton  LTS\n\n v22  Jod  LTS', blocked: { method: 1, address: 0 }, loaded: true, ...page }), err: '' };
};

test('a rendered page is saved as text with the engine header and a capture, recorded like a saved original', async () => {
  const cwd = ws();
  const { saved, skipped } = await readRendered({ urls: [{ url: 'https://nodejs.org/en/about/previous-releases' }], cwd, project: 'p', webMode: 'open',
    browser: 'edge.exe', run: fakeRun({}), resolve: publicDns, now: () => new Date('2026-10-11T05:00:00Z') });
  assert.deepEqual(skipped, []);
  assert.equal(saved.length, 1);
  assert.match(saved[0].path, /^sources\/렌더-[0-9a-f]{16}\.md$/);
  assert.match(saved[0].capture, /^sources\/렌더-[0-9a-f]{16}\.png$/);
  const text = readFileSync(path.join(cwd, saved[0].path), 'utf8');
  assert.ok(text.startsWith(RENDER_HEADER));
  assert.match(text, /제목: Node.js Releases[\s\S]*읽기 전용 규칙으로 막은 요청 1건[\s\S]*v24 Krypton LTS\nv22 Jod LTS/);
  assert.equal(saved[0].rendered, true);
});

test('the same rules as the team reads: no grant, local names, a redirect elsewhere, secrets or an empty page are not saved', async () => {
  const cwd = ws();
  const go = (url, opts = {}) => readRendered({ urls: [url], cwd, project: 'p', webMode: 'open', browser: 'edge.exe', run: fakeRun({}), resolve: publicDns, ...opts });
  assert.match((await go('https://nodejs.org/', { webMode: 'ask' })).skipped[0].reason, /허용하지 않은 사이트/);
  assert.match((await go('https://nodejs.org/', { resolve: async () => [{ address: '10.0.0.5' }] })).skipped[0].reason, /내부·로컬/);
  assert.match((await go('https://localhost/')).skipped[0].reason, /내부·로컬 주소/);
  assert.match((await go('https://nodejs.org/', { run: fakeRun({ url: 'https://127.0.0.1/admin' }) })).skipped[0].reason, /다른 주소로 넘어감/);
  assert.match((await go('https://nodejs.org/', { run: fakeRun({ text: `key ${'sk-ant-' + 'a'.repeat(30)}` }) })).skipped[0].reason, /비밀정보/);
  assert.match((await go('https://nodejs.org/', { run: fakeRun({ text: '   ' }) })).skipped[0].reason, /보이는 글이 없음/);
  assert.match((await go('https://nodejs.org/', { browser: null })).skipped[0].reason, /Edge·Chrome 이 없음/);
  const rules = [{ kind: 'site', target: 'nodejs.org', action: 'deny', project: null }];
  assert.match((await go('https://nodejs.org/', { rules })).skipped[0].reason, /대장 규칙으로 금지된 사이트/);
});
