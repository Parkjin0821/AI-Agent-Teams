import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DocConverter } from '../src/문서변환.js';
import { verifyReport } from '../src/완료근거.js';

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
  assert.deepEqual(calls[0], ['generate', '보고서.md', '-o', '보고서.hwpx', '--preset', '보고서', '--font', 'myeongjo', '--silent']);
  assert.deepEqual([r.validated, r.lint, r.readback.path, r.previews], [true, { errors: 0, warnings: 1 }, '보고서.hwpx.md', ['보고서.hwpx.svg', '보고서.hwpx.html']]);
  assert.equal((await maker.make(cwd, { from: '보고서.md', preset: '아무거나' }, new Set(['보고서.hwpx']))).preset, '보고서', 'unknown preset falls back to 보고서; a file the engine made may be made again');
});

test('한글 양식: 결재란 직위와 본문 글꼴을 받고, 이상한 값은 버린다', async () => {
  const cwd = ws();
  writeFileSync(path.join(cwd, '회의록.md'), '# 회의록\n- 결정\n');
  const { maker, calls } = fakeMaker(cwd);
  const r = await maker.make(cwd, { from: '회의록.md', preset: '회의록', approval: ['담당', '검토', '대장', 'x,y', '너무긴직위이름입니다'] });
  assert.deepEqual(calls[0], ['generate', '회의록.md', '-o', '회의록.hwpx', '--preset', '회의록', '--font', 'myeongjo', '--approval', '담당,검토,대장', '--silent']);
  assert.deepEqual([r.font, r.approval], ['myeongjo', ['담당', '검토', '대장']]);
  await maker.make(cwd, { from: '회의록.md', to: '고딕.hwpx', preset: '회의록', font: 'gothic' });
  assert.equal(calls.find(c => c[0] === 'generate' && c[3] === '고딕.hwpx')[calls[0].indexOf('--font') + 1], 'gothic');
  writeFileSync(path.join(cwd, '보도.md'), '# 보도\n');
  await maker.make(cwd, { from: '보도.md', preset: '보도자료' });
  assert.ok(!calls.find(c => c[0] === 'generate' && c[1] === '보도.md').includes('--font'), 'designed presets keep their own fonts');
});

test('짧은 업무보고는 간결한 보고서 서식, 정식 요청과 긴 원고는 업무보고 서식을 유지한다', async () => {
  const cwd = ws();
  writeFileSync(path.join(cwd, '짧은.md'), '# 업무보고\n## 요약\n완료율 80%\n');
  writeFileSync(path.join(cwd, '긴.md'), '# 업무보고\n' + '상세 추진 내용입니다.\n'.repeat(300));
  const { maker, calls } = fakeMaker(cwd);
  const compact = await maker.make(cwd, { from: '짧은.md', preset: '업무보고' });
  assert.equal(compact.preset, '보고서');
  assert.equal(compact.requestedPreset, '업무보고');
  assert.equal(compact.layout, 'compact');
  assert.equal(calls[0][calls[0].indexOf('--preset') + 1], '보고서');
  const full = await maker.make(cwd, { from: '짧은.md', to: '정식.hwpx', preset: '업무보고', layout: 'full' });
  assert.equal(full.preset, '업무보고');
  const long = await maker.make(cwd, { from: '긴.md', preset: '업무보고' });
  assert.equal(long.preset, '업무보고');
});

test('구조 검증 실패는 성공으로 보고하지 않고 단계와 종료 코드를 남긴다', async () => {
  const cwd = ws();
  writeFileSync(path.join(cwd, '보고서.md'), '# 보고');
  const { maker } = fakeMaker(cwd);
  const original = maker.sandbox.run;
  maker.sandbox.run = async (dir, argv) => argv[2] === 'validate'
    ? { status: 'fail', code: 1, output: 'invalid document structure' } : original(dir, argv);
  const result = await maker.make(cwd, { from: '보고서.md' });
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'validate');
  assert.equal(result.code, 1);
  assert.equal(result.output, 'invalid document structure');
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
  // The verifier cannot see the engine's records and sent "not done" for a document the engine had made: the engine's
  // own check decides then — but not for a check the verifier can run itself.
  const notDone = checks => verifyReport({ criteria: [{ index: 1, done: false, checks }] }, ['엔진이 회의록 서식으로 r.hwpx를 만들었다'], cwd, { documents: { 'r.hwpx': rec } });
  const engine = notDone([{ type: 'file_exists', path: 'r.hwpx' }, { type: 'document_made', path: 'r.hwpx' }]);
  assert.deepEqual([engine.claims[0].check, engine.evidence.length], ['pass', 1]);
  assert.equal(notDone([{ type: 'file_contains', path: 'r.hwpx.md', text: '3.14.0' }, { type: 'document_made', path: 'r.hwpx' }]).evidence.length, 0);
  writeFileSync(path.join(cwd, 'r.hwpx'), 'EDITED');
  assert.match(run({ type: 'document_made', path: 'r.hwpx' }).detail, /만든 뒤 바뀜/);
  assert.equal(notDone([{ type: 'document_made', path: 'r.hwpx' }]).evidence.length, 0, 'a failing engine check stays unmet');
});

test('양식 채우기: the form is filled in place, its headings and tables are checked, and document_made says so', async () => {
  const { formShape } = await import('../src/문서변환.js');
  const cwd = ws();
  mkdirSync(path.join(cwd, 'attachments'));
  const form = '# 사업계획서\n\n1. 사업 개요\n\n가. 추진배경\n\n<table><tr><td>과제명</td><td></td></tr></table>\n\n| 구분 | 내용 |\n| --- | --- |\n| 목표 |  |\n';
  writeFileSync(path.join(cwd, 'attachments', '양식.hwp'), 'HWP-FORM');
  writeFileSync(path.join(cwd, 'attachments', '양식.hwp.md'), form);
  const filled = form.replace('<td></td>', '<td>스마트 용접 품질 개선</td>').replace('| 목표 |  |', '| 목표 | 불량률 30% 감소 |');
  writeFileSync(path.join(cwd, '계획서.md'), filled);
  let readback = filled;
  const calls = [];
  const sandbox = { available: true, run: async (dir, argv) => {
    const args = argv.slice(2); calls.push(args);
    const out = args[args.indexOf('-o') + 1];
    if (args[0] === 'patch') writeFileSync(path.join(dir, out), 'HWP-FILLED');
    else if (args[0] === 'render') writeFileSync(path.join(dir, out), '<svg/>');
    else if (args[0] === 'lint') return { status: 'pass', output: '(error 0, warning 0)' };
    else writeFileSync(path.join(dir, out), readback);
    return { status: 'pass', output: '' };
  } };
  const maker = new DocConverter({ root: cwd, sandbox });
  Object.defineProperty(maker, 'available', { get: () => true });
  const r = await maker.fill(cwd, { template: 'attachments/양식.hwp', from: '계획서.md' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(calls[0].slice(0, 4), ['patch', 'attachments/양식.hwp', '계획서.md', '-o']);
  assert.match(calls[0][4], /^\.hq-tmp-[0-9a-f-]{36}\.hwp$/, 'kordoc writes to a temporary name; the target appears only on success');
  assert.ok(!calls.some(c => c[0] === 'validate'), 'HWP has no HWPX structure check; the read-back stands in');
  // an HWP of several pages renders one SVG only page by page: its preview is the first page
  assert.deepEqual(calls.find(c => c[0] === 'render' && c.includes('계획서.hwp.svg')), ['render', '계획서.hwp', '--pages', '1', '-o', '계획서.hwp.svg', '--silent']);
  assert.deepEqual(r.previews, ['계획서.hwp.svg', '계획서.hwp.html']);
  assert.deepEqual([r.path, r.kind, r.structure.same, r.empties], ['계획서.hwp', 'form', true, [2, 0]]);
  const run = (rec) => verifyReport({ criteria: [{ index: 1, done: true, check: { type: 'document_made', path: '계획서.hwp', text: '불량률 30% 감소' } }] },
    ['양식에 맞춘 사업계획서 계획서.hwp 에 목표가 들어 있다'], cwd, { documents: { '계획서.hwp': rec } }).claims[0];
  const ok = run(r);
  assert.equal(ok.check, 'pass');
  assert.match(ok.detail, /양식 양식\.hwp에 계획서\.md 내용을 채움, 원본 서식 그대로\) · 목차 3개·표 2개 양식과 같음 · 빈칸 0개 \(양식 2개\)/);
  // a heading of the form dropped while filling: the engine says so and the proof fails
  readback = filled.replace('가. 추진배경\n', '');
  const lost = await maker.fill(cwd, { template: 'attachments/양식.hwp', from: '계획서.md' }, new Set(['계획서.hwp']));
  assert.deepEqual([lost.structure.same, lost.structure.missing], [false, ['가. 추진배경']]);
  assert.match(run(lost).detail, /목차·표가 양식과 다름 .*빠진 목차: 가\. 추진배경/);
  // refused: the result in another format, the draft inside attachments/, edits kordoc could not place
  assert.match((await maker.fill(cwd, { template: 'attachments/양식.hwp', from: '계획서.md', to: '계획서.hwpx' })).error, /양식과 같은 형식/);
  assert.match((await maker.fill(cwd, { template: 'attachments/양식.hwp', from: 'attachments/양식.hwp.md' })).error, /작성본/);
  // kordoc names each skipped edit; the team is told which (a real form, 2026-10-02: 19 skips and only "일부" said)
  sandbox.run = async () => ({ status: 'fail', code: 2, output: [
    '[kordoc] 127개 변경 적용 (원본 서식 보존) → 계획서.hwp',
    '[kordoc] ⚠️ SKIP: 블록 추가는 미지원 (v1)',
    '[kordoc] ⚠️ SKIP: 표 캡션 수정은 미지원 (v1) | **[표. 공정 이상 유형]**',
    '[kordoc] ⚠️ SKIP: 블록 추가는 미지원 (v1)',
    '[kordoc] ⚠️ 검증 잔차: 수정 5, 추가 2, 삭제 0'].join('\n') });
  const skip = await maker.fill(cwd, { template: 'attachments/양식.hwp', from: '계획서.md' }, new Set(['계획서.hwp']));
  assert.ok(skip.error.endsWith(' · 건너뛴 곳 2개: 블록 추가는 미지원 (v1) / 표 캡션 수정은 미지원 (v1) | **[표. 공정 이상 유형]**'), skip.error);
  assert.deepEqual(skip.skipped, ['블록 추가는 미지원 (v1)', '표 캡션 수정은 미지원 (v1) | **[표. 공정 이상 유형]**']);
  sandbox.run = async () => ({ status: 'fail', code: 2, output: 'skip 3' });
  assert.match((await maker.fill(cwd, { template: 'attachments/양식.hwp', from: '계획서.md' }, new Set(['계획서.hwp']))).error, /일부 수정이 양식에 들어가지 않음 \(표·목차 구조를 바꾼 곳을 확인\)$/);
  assert.deepEqual(formShape('1. 개요\n\n(1) 세부\n\n| a | b |\n| --- | --- |\n| x |  |').headings, ['1. 개요']);
});

test('양식 채우기: a patch that skipped edits leaves no file behind, so the corrected draft can be filled next time', async () => {
  const cwd = ws();
  mkdirSync(path.join(cwd, 'attachments'));
  const form = '1. 사업 개요\n\n| 구분 | 내용 |\n| --- | --- |\n| 목표 |  |\n';
  writeFileSync(path.join(cwd, 'attachments', '양식.hwp'), 'HWP-FORM');
  writeFileSync(path.join(cwd, 'attachments', '양식.hwp.md'), form);
  writeFileSync(path.join(cwd, '계획서.md'), form.replace('| 목표 |  |', '| 목표 | 불량률 30% 감소 |'));
  let skipEdits = true;
  // kordoc writes its -o file even when it exits 2 (seen 2026-10-02), so the fake does too
  const sandbox = { available: true, run: async (dir, argv) => {
    const args = argv.slice(2), out = args[args.indexOf('-o') + 1];
    if (args[0] === 'patch') { writeFileSync(path.join(dir, out), 'HWP-PARTLY-FILLED');
      if (skipEdits) return { status: 'fail', code: 2, output: `[kordoc] 1개 변경 적용 → ${out}\n[kordoc] ⚠️ SKIP: 블록 추가는 미지원 (v1)` }; }
    else if (args[0] === 'render') writeFileSync(path.join(dir, out), '<svg/>');
    else if (args[0] === 'lint') return { status: 'pass', output: '(error 0, warning 0)' };
    else writeFileSync(path.join(dir, out), form.replace('| 목표 |  |', '| 목표 | 불량률 30% 감소 |'));
    return { status: 'pass', output: '' };
  } };
  const maker = new DocConverter({ root: cwd, sandbox });
  Object.defineProperty(maker, 'available', { get: () => true });
  const failed = await maker.fill(cwd, { template: 'attachments/양식.hwp', from: '계획서.md' });
  assert.equal(failed.ok, false);
  assert.match(failed.output, /→ 계획서\.hwp$/m,'the team reads the target name, not the temporary one');
  assert.equal(existsSync(path.join(cwd, '계획서.hwp')), false, 'no unrecorded document is left at the target');
  assert.deepEqual(readdirSync(cwd).filter(n => n.startsWith('.hq-tmp-')), [], 'the temporary file is removed');
  skipEdits = false;
  const fixed = await maker.fill(cwd, { template: 'attachments/양식.hwp', from: '계획서.md' }); // nothing known: a first try again
  assert.equal(fixed.ok, true, fixed.error);
  assert.equal(readFileSync(path.join(cwd, '계획서.hwp'), 'utf8'), 'HWP-PARTLY-FILLED');
  assert.deepEqual(readdirSync(cwd).filter(n => n.startsWith('.hq-tmp-')), []);
});
