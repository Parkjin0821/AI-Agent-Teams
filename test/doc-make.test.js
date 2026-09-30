import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DocConverter } from '../src/doc-convert.js';
import { verifyReport } from '../src/evidence.js';

const ws = () => mkdtempSync(path.join(tmpdir(), 'hq-doc-'));
// A stand-in for the sandbox: records the kordoc commands and writes what kordoc would write.
function fakeMaker(root) {
  const calls = [];
  const sandbox = { available: true, run: async (cwd, argv) => {
    const args = argv.slice(2); calls.push(args);
    const out = args[args.indexOf('-o') + 1];
    if (args[0] === 'generate') writeFileSync(path.join(cwd, out), 'HWPX-BYTES');
    else if (args[0] === 'render') writeFileSync(path.join(cwd, out), '<svg/>');
    else if (args[0] === 'lint') return { status: 'pass', output: '[kordoc] 표기법 검수: 위반 1건 (error 0, warning 1)' };
    else if (args[0] === 'validate') return { status: 'pass', output: 'ok' };
    else writeFileSync(path.join(cwd, out), '# 보고\n최신 안정 버전: 3.14.0\n');
    return { status: 'pass', output: '' };
  } };
  const maker = new DocConverter({ root, sandbox });
  Object.defineProperty(maker, 'available', { get: () => true });
  return { maker, calls };
}

test('문서 만들기: Markdown → HWPX with a preset, then validate, lint, read-back and SVG/HTML previews', async () => {
  const cwd = ws();
  writeFileSync(path.join(cwd, '보고서.md'), '# 보고\n- 최신 안정 버전: 3.14.0\n');
  const { maker, calls } = fakeMaker(cwd);
  const r = await maker.make(cwd, { from: '보고서.md', to: '보고서.hwpx', preset: '보고서' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map(c => c[0]), ['generate', 'validate', 'lint', '보고서.hwpx', 'render', 'render']);
  assert.deepEqual(calls[0], ['generate', '보고서.md', '-o', '보고서.hwpx', '--preset', '보고서', '--silent']);
  assert.deepEqual([r.validated, r.lint, r.readback.path, r.previews], [true, { errors: 0, warnings: 1 }, '보고서.hwpx.md', ['보고서.hwpx.svg', '보고서.hwpx.html']]);
  assert.equal((await maker.make(cwd, { from: '보고서.md', preset: '아무거나' }, new Set(['보고서.hwpx']))).preset, '보고서', 'unknown preset falls back to 보고서; a file the engine made may be made again');
});

test('the maker refuses what it should not touch', async () => {
  const cwd = ws();
  mkdirSync(path.join(cwd, 'attachments'));
  writeFileSync(path.join(cwd, 'attachments', 'a.md'), 'x');
  writeFileSync(path.join(cwd, 'a.md'), '# a');
  writeFileSync(path.join(cwd, 'key.md'), 'token ghp_' + 'a'.repeat(36));
  writeFileSync(path.join(cwd, 'mine.hwpx'), 'someone else');
  const { maker, calls } = fakeMaker(cwd);
  const err = async input => (await maker.make(cwd, input)).error;
  assert.match(await err({ from: 'attachments/a.md' }), /원고는/);
  assert.match(await err({ from: '../a.md' }), /원고는/);
  assert.match(await err({ from: 'a.txt' }), /원고는/);
  assert.match(await err({ from: 'a.md', to: 'sources/a.hwpx' }), /결과는/);
  assert.match(await err({ from: 'a.md', to: 'a.docx' }), /결과는/);
  assert.match(await err({ from: 'none.md' }), /없음/);
  assert.match(await err({ from: 'key.md' }), /비밀정보/);
  assert.match(await err({ from: 'a.md', to: 'mine.hwpx' }), /이미 있음/);
  assert.equal(calls.length, 0, 'kordoc never ran for a refused request');
});

test('document_made proves only an engine-made, checked, unchanged document, and its content via the read-back', () => {
  const cwd = ws();
  writeFileSync(path.join(cwd, 'r.hwpx'), 'HWPX');
  writeFileSync(path.join(cwd, 'r.hwpx.md'), '최신 안정 버전: 3.14.0');
  const sha = t => createHash('sha256').update(t).digest('hex');
  const rec = { path: 'r.hwpx', from: 'r.md', preset: '보고서', sha: sha('HWPX'), validated: true, lint: { errors: 0, warnings: 0 }, readback: { path: 'r.hwpx.md', sha: sha('최신 안정 버전: 3.14.0') } };
  const C = ['r.hwpx 문서에 최신 안정 버전이 들어 있다'];
  const run = (c, documents = { 'r.hwpx': rec }) => verifyReport({ criteria: [{ index: 1, done: true, check: c }] }, C, cwd, { documents }).claims[0];
  const ok = run({ type: 'document_made', path: 'r.hwpx', text: '3.14.0' });
  assert.equal(ok.check, 'pass');
  assert.match(ok.detail, /보고서 서식, r\.md에서 엔진이 만듦\) 구조 검증 통과 · 문서에 “3\.14\.0” 있음/);
  assert.equal(run({ type: 'document_made', path: 'r.hwpx', text: '9.9.9' }).check, 'fail');
  assert.match(run({ type: 'document_made', path: 'r.hwpx' }, {}).detail, /엔진이 만든 문서가 아님/);
  assert.match(run({ type: 'document_made', path: 'r.hwpx' }, { 'r.hwpx': { ...rec, validated: false } }).detail, /구조 검증 실패/);
  writeFileSync(path.join(cwd, 'r.hwpx'), 'EDITED');
  assert.match(run({ type: 'document_made', path: 'r.hwpx' }).detail, /만든 뒤 바뀜/);
});
