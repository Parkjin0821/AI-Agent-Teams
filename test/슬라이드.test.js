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

test('slides_ok: proven only by this verification step\'s own build, with the page count; overflow or no build fails', async () => {
  const { verifyReport } = await import('../src/완료근거.js');
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-slide-ok-'));
  const crit = ['엔진이 슬라이드를 빌드해 PDF 를 만들고, PDF 쪽 수가 슬라이드 수와 같다'];
  const report = { criteria: [{ index: 1, done: true, check: { type: 'slides_ok', path: 'slides/market/index.tsx' } }] };
  const deck = { id: 'market', pages: 6, pdf: '발표자료/market.pdf', screenshots: [], overflowPages: [], scriptErrors: 0, error: null };
  const ok = verifyReport(report, crit, cwd, { verifying: true, slides: slideTool({ ok: true, decks: [deck] }) });
  assert.equal(ok.evidence.length, 1, JSON.stringify(ok.claims));
  assert.match(ok.evidence[0].proof, /발표자료\/market\.pdf 6쪽 \(슬라이드 6장/);
  assert.equal(verifyReport(report, crit, cwd, { verifying: true }).claims[0].check, 'fail', 'no build in this step');
  const over = verifyReport(report, crit, cwd, { verifying: true, slides: slideTool({ ok: false, decks: [{ ...deck, overflowPages: [4] }] }) });
  assert.match(over.claims[0].detail, /4쪽 내용이 1920×1080 밖으로 넘침/);
});

// 자율 시험 4차 (2026-10-02): the verifier could not check "the PDF has 일정·신청 방법·문의처" and planning sent the deck back.
test('PDF text: the build records 발표자료/<id>.pdf.md with its sha, and file_contains on it counts only while it matches', async () => {
  const { verifyReport } = await import('../src/완료근거.js');
  const { slideTextRecords } = await import('../src/슬라이드.js');
  const root = mkdtempSync(path.join(tmpdir(), 'hq-slide-text-'));
  mkdirSync(path.join(root, 'tools', 'open-slide', 'node_modules', '@open-slide', 'core'), { recursive: true });
  writeFileSync(path.join(root, 'tools', 'open-slide', 'node_modules', '@open-slide', 'core', 'bin.js'), '');
  mkdirSync(path.join(root, '발표자료'));
  const text = '## 1쪽\n\n여름 독서 교실\n\n## 2쪽\n\n일정 7월 21일~8월 1일\n신청 방법 도서관 안내 데스크\n문의처 02-000-0000 (예시)\n';
  const sandbox = { available: true, async run(cwd) {
    writeFileSync(path.join(cwd, '발표자료', '안내.pdf.md'), text);
    return { status: 'pass', output: 'AGENT_HQ_SLIDES ' + JSON.stringify({ decks: [{ id: '안내', pages: 2, pdf: '발표자료/안내.pdf', text: '발표자료/안내.pdf.md', screenshots: [], overflowPages: [] },
      { id: 'evil', pages: 1, pdf: '발표자료/evil.pdf', text: '../outside.md', screenshots: [] }] }) };
  } };
  const maker = new SlideMaker({ root, sandbox, browserPath: 'C:/edge.exe' });
  const made = await maker.make(root, ['안내', 'evil']);
  assert.equal(made.decks[0].readback.path, '발표자료/안내.pdf.md');
  assert.match(made.decks[0].readback.sha, /^[a-f0-9]{64}$/);
  assert.equal(made.decks[1].readback, null, 'a text path outside 발표자료/<id>.pdf.md is not recorded');
  const slideTexts = slideTextRecords([{ slides: made.decks }]);
  const crit = ['PDF 에 일정·신청 방법·문의처가 들어 있다'];
  const checks = ['일정', '신청 방법', '문의처'].map(t => ({ type: 'file_contains', path: '발표자료/안내.pdf.md', text: t }));
  const report = { criteria: [{ index: 1, done: true, checks }] };
  const ok = verifyReport(report, crit, root, { verifying: true, slideTexts });
  assert.equal(ok.evidence.length, 1, JSON.stringify(ok.claims));
  assert.match(ok.evidence[0].proof, /엔진이 PDF 로 인쇄한 화면에서 읽은 글/);
  // a value the criterion does not name still relates: the criterion is about the PDF
  const dated = verifyReport({ criteria: [{ index: 1, done: true, check: { type: 'file_contains', path: '발표자료/안내.pdf.md', text: '7월 21일' } }] },
    ['발표 PDF 에 행사 날짜가 적혀 있다'], root, { verifying: true, slideTexts });
  assert.equal(dated.evidence.length, 1, JSON.stringify(dated.claims));
  // no engine record, or a team's edit since: not proof
  assert.equal(verifyReport(report, crit, root, { verifying: true }).claims[0].check, 'invalid');
  writeFileSync(path.join(root, '발표자료', '안내.pdf.md'), text + '팀이 덧붙임\n');
  const edited = verifyReport(report, crit, root, { verifying: true, slideTexts });
  assert.deepEqual([edited.evidence.length, edited.claims[0].check], [0, 'invalid']);
  assert.match(edited.claims[0].detail, /엔진이 읽은 뒤 바뀜/);
  assert.match(slidesPrompt(), /발표자료\/<id>\.pdf\.md/);
});
