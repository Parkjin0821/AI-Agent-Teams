import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { VisualChecker } from '../src/visual-check.js';
import { SandboxRunner } from '../src/sandbox.js';
import { resolveBins } from '../src/adapters.js';
import { verifyReport, listWorkspaceFiles } from '../src/evidence.js';
import { runTeamTools, toolReport } from '../src/toolkit.js';
import { decide } from '../src/sentinel.js';

test('visual check never falls back outside sandbox', async () => {
  const checker = new VisualChecker({ sandbox: null, browserPath: 'edge' });
  assert.equal((await checker.check(process.cwd(), ['index.html'])).status, 'unavailable');
});

const report = () => ({ pages: [1440, 390].map(width => ({ file: 'index.html', width, issues: width === 390 ? ['가로 넘침 (520px > 390px · table.menu)'] : [],
  screenshot: `.hq-screens/index-${width}.png` })) });
const fakeSandbox = (r) => ({ available: true, run: async (cwd, command, opts) => {
  assert.equal(opts.network, undefined, 'never with network');
  assert.match(command[1], /visual-check\.cjs$/);
  return { status: 'pass', output: 'AGENT_HQ_VISUAL ' + JSON.stringify(r) };
} });

test('visual results need both widths; plain breakage blocks, small notes do not', async () => {
  const r = report();
  const checker = new VisualChecker({ sandbox: fakeSandbox(r), browserPath: 'edge' });
  const found = await checker.check(process.cwd(), ['index.html']);
  assert.equal(found.status, 'found');
  assert.deepEqual(found.screenshots.map(s => s.width), [1440, 390]);
  assert.match(found.blocking[0], /가로 넘침/);
  r.pages[1].issues = ['12px보다 작은 글자 2곳'];
  assert.deepEqual((await checker.check(process.cwd(), ['index.html'])).blocking, [], 'small text is a note, not a blocker');
  r.pages.pop();
  assert.equal((await checker.check(process.cwd(), ['index.html'])).status, 'unavailable', 'an incomplete report proves nothing');
});

test('the design team sees the captures before its step; teams are told to open them', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-vis-design-'));
  writeFileSync(path.join(cwd, 'index.html'), '<html lang="ko"><title>t</title><body>x</body></html>');
  const visualChecker = new VisualChecker({ sandbox: fakeSandbox(report()), browserPath: 'edge' });
  const tools = await runTeamTools('design', cwd, { visualChecker });
  assert.deepEqual(tools.map(t => t.id), ['visual']);
  assert.match(toolReport(tools), /\.hq-screens\/index-1440\.png.*반드시 직접 열어 본다/s);
  assert.deepEqual((await runTeamTools('dev', cwd, { visualChecker })).map(t => t.id), [], 'not for other work teams');
});

test('screen_ok is proven only by this verification step\'s own 화면 검사', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-vis-ok-'));
  writeFileSync(path.join(cwd, 'index.html'), '<html></html>');
  const criteria = ['엔진 화면 검사(PC 1440px·모바일 390px)에서 깨진 곳이 없다'];
  const rep = { criteria: [{ index: 1, done: true, check: { type: 'screen_ok', path: 'index.html' } }] };
  const clean = report(); clean.pages[1].issues = [];
  const visualOk = await new VisualChecker({ sandbox: fakeSandbox(clean), browserPath: 'edge' }).check(cwd, ['index.html']);
  assert.equal(verifyReport(rep, criteria, cwd, { visual: visualOk }).evidence.length, 1);
  const visualBad = await new VisualChecker({ sandbox: fakeSandbox(report()), browserPath: 'edge' }).check(cwd, ['index.html']);
  assert.match(verifyReport(rep, criteria, cwd, { visual: visualBad }).claims[0].detail, /가로 넘침/);
  assert.match(verifyReport(rep, criteria, cwd, {}).claims[0].detail, /실행되지 않음/);
});

test('.hq-screens is the engine\'s: teams cannot write there, and it is not part of the work', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-vis-own-'));
  const w = f => decide({ tool_name: 'Write', tool_input: { file_path: path.join(cwd, f), content: 'x' } }, { workspace: cwd });
  assert.equal(w('.hq-screens/index-1440.png').decision, 'deny');
  assert.equal(w('index.html').decision, 'allow');
  const { mkdirSync } = { mkdirSync: (p) => existsSync(p) || import('node:fs').then(fs => fs.mkdirSync(p)) };
  return import('node:fs').then(fs => {
    fs.mkdirSync(path.join(cwd, '.hq-screens'));
    fs.writeFileSync(path.join(cwd, '.hq-screens', 'a.png'), 'x');
    fs.writeFileSync(path.join(cwd, 'index.html'), 'x');
    assert.deepEqual(listWorkspaceFiles(cwd), ['index.html']);
  });
});

test('real sandbox captures PC and phone widths and finds overflow', { skip: process.env.RUN_VISUAL_INTEGRATION !== '1' }, async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'agent-hq-visual-'));
  writeFileSync(path.join(cwd, 'index.html'), '<html lang="ko"><meta name="viewport" content="width=device-width"><title>검사</title><body><div style="width:900px">검사 화면</div></body></html>');
  const checker = new VisualChecker({ sandbox: new SandboxRunner({ codex: resolveBins().codex }) });
  const result = await checker.check(cwd, ['index.html']);
  assert.equal(result.status, 'found', JSON.stringify(result));
  assert.ok(result.details.some(s => s.includes('390px') && s.includes('가로 넘침')));
  assert.ok(result.details.every(s => !s.includes('1440px') || !s.includes('가로 넘침')), 'no overflow at PC width');
  for (const s of result.screenshots) assert.ok(existsSync(path.join(cwd, s.path)), s.path);
});

test('the engine\'s own document previews are not screen-checked as the team\'s pages (seen in a real run)', async () => {
  const { mkdirSync } = await import('node:fs');
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-vis-engine-'));
  mkdirSync(path.join(cwd, 'reports'));
  writeFileSync(path.join(cwd, 'index.html'), '<html lang="ko"><title>t</title><body>x</body></html>');
  writeFileSync(path.join(cwd, 'reports', '완료보고서-1.hwpx.html'), '<html><body>preview</body></html>');
  let asked = null;
  const sandbox = { available: true, run: async (c, command) => { asked = JSON.parse(command[3]); return { status: 'pass', output: 'AGENT_HQ_VISUAL ' + JSON.stringify(report()) }; } };
  await runTeamTools('design', cwd, { visualChecker: new VisualChecker({ sandbox, browserPath: 'edge' }) });
  assert.deepEqual(asked, ['index.html']);
});
