import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SlideMaker, slideTool, slidesPrompt } from '../src/슬라이드.js';
import { slideDecks } from '../src/검사도구.js';

const fakeSandbox = (output, status = 'pass') => ({ available: true, calls: [], async run(cwd, cmd, opts) { this.calls.push({ cwd, cmd, opts }); return { status, output }; } });

test('slides: only safe deck ids reach the sandbox runner, and a missing install or browser says so', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-slide-root-'));
  const sandbox = fakeSandbox('');
  const maker = new SlideMaker({ root, sandbox, browserPath: 'C:/edge.exe' });
  assert.equal(maker.installed, false);
  assert.match((await maker.make(root, ['report'])).error, /open-slide 미설치/);
  assert.match((await maker.make(root, ['../x', 'A B'])).error, /슬라이드 id 없음/);
  mkdirSync(path.join(root, 'tools', 'open-slide', 'node_modules', '@open-slide', 'core'), { recursive: true });
  writeFileSync(path.join(root, 'tools', 'open-slide', 'node_modules', '@open-slide', 'core', 'bin.js'), '');
  sandbox.run = async (cwd, cmd) => { sandbox.calls.push(cmd); return { status: 'pass', output: 'x\nAGENT_HQ_SLIDES ' + JSON.stringify({ decks: [
    { id: 'report', pages: 2, pdf: '발표자료/report.pdf', screenshots: ['.hq-screens/슬라이드-report-01.png', '../evil.png'], overflowPages: [2], scriptErrors: 0 },
    { id: 'other', pages: 1, pdf: '발표자료/other.pdf', screenshots: [] }] }) }; };
  const r = await maker.make(root, ['report', 'report', '../x']);
  assert.deepEqual(JSON.parse(sandbox.calls.at(-1).at(-1)), ['report'], 'deduplicated, unsafe id dropped');
  assert.deepEqual(r.decks.map(d => d.id), ['report'], 'a deck that was not asked for is ignored');
  assert.deepEqual(r.decks[0].screenshots, ['.hq-screens/슬라이드-report-01.png'], 'paths outside the engine folders are dropped');
  const t = slideTool(r);
  assert.equal(t.status, 'found');
  assert.match(t.blocking[0], /report: 2쪽 내용이 1920×1080 밖으로 넘침/);
});

test('slides: a build failure blocks with its reason; a clean deck passes with its PDF', () => {
  const failed = slideTool({ ok: false, decks: [{ id: 'deck', pages: 0, error: '빌드 실패', detail: 'line1\nSyntaxError: x', pdf: null, screenshots: [], overflowPages: [] }] });
  assert.equal(failed.status, 'found');
  assert.match(failed.blocking[0], /deck: 빌드 실패 · line1 \/ SyntaxError: x/);
  const ok = slideTool({ ok: true, decks: [{ id: 'deck', pages: 3, pdf: '발표자료/deck.pdf', screenshots: ['.hq-screens/슬라이드-deck-01.png'], overflowPages: [], scriptErrors: 0 }] });
  assert.deepEqual([ok.status, ok.summary, ok.blocking.length], ['pass', '발표자료/deck.pdf (3쪽)', 0]);
  assert.match(slidesPrompt(), /"slides":\["<id>"\]/);
  assert.match(slidesPrompt(), /PPTX 는 만들지 않는다/);
});

test('slides: verification finds the decks a team wrote under slides/<id>/index.tsx', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-slide-decks-'));
  assert.deepEqual(slideDecks(cwd), []);
  for (const id of ['weekly-report', 'Bad Name', 'empty']) mkdirSync(path.join(cwd, 'slides', id), { recursive: true });
  writeFileSync(path.join(cwd, 'slides', 'weekly-report', 'index.tsx'), 'export default []');
  writeFileSync(path.join(cwd, 'slides', 'Bad Name', 'index.tsx'), 'export default []');
  assert.deepEqual(slideDecks(cwd), ['weekly-report']);
});
