import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { htmlToText, saveSources, sourceRecords, SOURCE_HEADER } from '../src/web-sources.js';
import { verifyReport } from '../src/evidence.js';
import { decide } from '../src/sentinel.js';

const ws = () => mkdtempSync(path.join(tmpdir(), 'hq-src-'));
const page = '<html><head><style>.x{}</style><script>alert("x")</script></head><body><h1>Download Node.js</h1>'
  + '<p>Get Node.js&reg; v24.21.0 (LTS)</p><table><tr><td>v26</td><td>Current</td></tr></table></body></html>';
const reply = (body, { status = 200, type = 'text/html; charset=utf-8', location } = {}) => ({
  ok: status >= 200 && status < 300, status, text: async () => body,
  headers: { get: k => ({ 'content-type': type, location: location ?? null, 'content-length': String(body.length) })[k.toLowerCase()] ?? null } });
const publicDns = async () => [{ address: '104.20.22.46', family: 4 }];
const grants = [{ kind: 'web', target: 'nodejs.org', project: 'p1' }];

test('html becomes readable text: no scripts or styles, table cells split, entities decoded', () => {
  const text = htmlToText(page);
  assert.match(text, /Download Node\.js\nGet Node\.js® v24\.21\.0 \(LTS\)\nv26 \| Current \|/);
  assert.doesNotMatch(text, /alert|\.x\{/);
});

test('an allowed page is saved under sources/ with a header and a fingerprint the engine keeps', async () => {
  const cwd = ws();
  const r = await saveSources({ urls: [{ url: 'https://nodejs.org/en/download' }], cwd, project: 'p1', grants, fetcher: async () => reply(page), resolve: publicDns,
    now: () => new Date('2026-09-30T05:00:00Z') });
  assert.deepEqual(r.skipped, []);
  assert.equal(r.saved[0].path, 'sources/nodejs.org-en-download.txt');
  const saved = readFileSync(path.join(cwd, r.saved[0].path), 'utf8');
  assert.ok(saved.startsWith(SOURCE_HEADER + '\n주소: https://nodejs.org/en/download\n받은 시각: 2026-09-30T05:00:00.000Z'));
  assert.match(saved, /v24\.21\.0/);
  assert.deepEqual(Object.keys(sourceRecords([{ sources: r.saved }])), ['sources/nodejs.org-en-download.txt']);
});

test('nothing is fetched from a site 대장 has not allowed, a private address, or a redirect that leaves the rules', async () => {
  const cwd = ws();
  let calls = 0;
  const fetcher = async (url) => { calls++; return url.includes('go-internal') ? reply('', { status: 302, location: 'http://10.0.0.5/admin' }) : reply(page); };
  const r = await saveSources({ urls: ['https://example.com/a', 'https://nodejs.org/go-internal', 'http://nodejs.org/x', 'https://nodejs.org/rebind'],
    cwd, project: 'p1', grants, fetcher, resolve: async (host) => [{ address: host === 'nodejs.org' ? '104.20.22.46' : '93.184.216.34', family: 4 }] });
  assert.equal(r.skipped[0].reason, '대장이 아직 허용하지 않은 사이트');
  assert.equal(r.skipped[1].reason, 'https 가 아닌 주소', 'the redirect to http://10.0.0.5 is checked like a new read');
  assert.equal(r.skipped[2].reason, 'https 가 아닌 주소');
  assert.equal(r.saved.length, 1, 'only the plain allowed page');
  assert.equal(calls, 2, 'the unallowed site and the http address were never fetched');
  const rebound = await saveSources({ urls: ['https://nodejs.org/en'], cwd, project: 'p1', grants, fetcher: async () => reply(page), resolve: async () => [{ address: '127.0.0.1', family: 4 }] });
  assert.equal(rebound.skipped[0].reason, '내부·로컬 주소로 연결되는 이름');
  const pdf = await saveSources({ urls: ['https://nodejs.org/a.pdf'], cwd, project: 'p1', grants, fetcher: async () => reply('%PDF', { type: 'application/pdf' }), resolve: publicDns });
  assert.match(pdf.skipped[0].reason, /글 문서가 아님/);
  const secret = await saveSources({ urls: ['https://nodejs.org/s'], cwd, project: 'p1', grants, fetcher: async () => reply('key ghp_' + 'a'.repeat(36), { type: 'text/plain' }), resolve: publicDns });
  assert.match(secret.skipped[0].reason, /비밀정보/);
});

test('source_contains proves a value against the saved original, unchanged since, and optionally in a work file', async () => {
  const cwd = ws();
  const r = await saveSources({ urls: ['https://nodejs.org/en/download'], cwd, project: 'p1', grants, fetcher: async () => reply(page), resolve: publicDns });
  writeFileSync(path.join(cwd, 'research.md'), '- 현재 LTS: v24.21.0\n');
  const sources = sourceRecords([{ sources: r.saved }]);
  const C = ['research.md의 LTS 버전이 공식 출처 원문과 같다'];
  const check = (c, ctx = { sources }) => verifyReport({ criteria: [{ index: 1, done: true, check: c }] }, C, cwd, ctx).claims[0];
  const ok = check({ type: 'source_contains', source: r.saved[0].path, text: 'v24.21.0', path: 'research.md' });
  assert.equal(ok.check, 'pass');
  assert.match(ok.detail, /research\.md의 “v24\.21\.0”이\(가\) 원문\(https:\/\/nodejs\.org\/en\/download/);
  assert.equal(check({ type: 'source_contains', source: r.saved[0].path, text: 'v99.0.0', path: 'research.md' }).check, 'fail');
  writeFileSync(path.join(cwd, 'sources', 'fake.txt'), 'v24.21.0');
  assert.match(check({ type: 'source_contains', source: 'sources/fake.txt', text: 'v24.21.0' }).detail, /엔진이 저장한 원문이 아님/);
  writeFileSync(path.join(cwd, r.saved[0].path), readFileSync(path.join(cwd, r.saved[0].path), 'utf8') + '\n추가');
  assert.match(check({ type: 'source_contains', source: r.saved[0].path, text: 'v24.21.0' }).detail, /저장 뒤 바뀜/);
});

test('teams cannot write into sources/ (the Sentinel keeps it for the engine)', () => {
  const cwd = ws();
  const d = decide({ tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'sources', 'x.txt'), content: 'v1' } }, { workspace: cwd });
  assert.deepEqual([d.decision, d.reason], ['deny', '웹 원문 폴더(sources/)는 엔진만 씀']);
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'sources-notes.md'), content: 'v1' } }, { workspace: cwd }).decision, 'allow');
});
