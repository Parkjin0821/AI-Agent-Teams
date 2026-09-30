import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseReport, reportInstructions, verifyReport, workspaceFingerprint } from '../src/evidence.js';

const criteria = ['README.md 파일이 있다', 'README에 소개 3줄', '팀 회의를 한다'];
const answerWith = (report) => `작업을 마쳤습니다.\n\nAGENT_HQ_REPORT\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``;
const ws = () => mkdtempSync(path.join(tmpdir(), 'hq-ev-'));

test('instructions list the criteria by number and the allowed check types', () => {
  const text = reportInstructions(criteria);
  assert.match(text, /1\. README\.md 파일이 있다/);
  assert.match(text, /AGENT_HQ_REPORT/);
  assert.match(text, /file_exists/);
  assert.match(text, /file_contains/);
});

test('the report is parsed from the answer; a missing or broken report is null', () => {
  const report = parseReport(answerWith({ criteria: [{ index: 1, done: true, check: { type: 'file_exists', path: 'README.md' } }] }));
  assert.equal(report.criteria[0].index, 1);
  assert.equal(parseReport('no report here'), null);
  assert.equal(parseReport('AGENT_HQ_REPORT {broken'), null);
});

test('checks run against the workspace; only passing checks become evidence', () => {
  const cwd = ws();
  writeFileSync(path.join(cwd, 'README.md'), '# 소개\n첫째 줄\n둘째 줄\n셋째 줄\n');
  const report = parseReport(answerWith({ criteria: [
    { index: 1, done: true, check: { type: 'file_exists', path: 'README.md' } },
    { index: 2, done: true, check: { type: 'file_contains', path: 'README.md', text: '넷째 줄' } },
    { index: 3, done: true, check: null, note: '회의는 사람이 해야 합니다' },
  ] }));
  const { evidence, claims } = verifyReport(report, criteria, cwd);
  assert.deepEqual(evidence.map(e => e.criterion), ['README.md 파일이 있다']);
  assert.match(evidence[0].proof, /엔진 확인/);
  assert.deepEqual(claims.map(c => [c.criterion, c.claimed, c.check]), [
    ['README.md 파일이 있다', true, 'pass'], ['README에 소개 3줄', true, 'fail'], ['팀 회의를 한다', true, 'none']]);
  assert.equal(claims[2].note, '회의는 사람이 해야 합니다');
});

test('a passing check never counts when the tool itself says the criterion is not done', () => {
  const cwd = ws();
  writeFileSync(path.join(cwd, 'TEAM-STATUS.md'), 'TASK_DONE: helloworld 팀');
  const report = { criteria: [{ index: 1, done: false, check: { type: 'file_contains', path: 'TEAM-STATUS.md', text: 'TASK_DONE' } }] };
  const { evidence, claims } = verifyReport(report, criteria, cwd);
  assert.equal(evidence.length, 0);
  assert.equal(claims[0].check, 'pass', 'the check result is still shown');
  assert.equal(claims[0].claimed, false);
});

test('instructions say a self-written status note is not proof', () => {
  assert.match(reportInstructions(criteria), /not proof/);
});

test('checks cannot look outside the workspace', () => {
  const cwd = ws();
  const outside = ws();
  writeFileSync(path.join(outside, 'secret.txt'), 'x');
  symlinkSync(outside, path.join(cwd, 'link'), 'junction');
  const report = { criteria: [
    { index: 1, done: true, check: { type: 'file_exists', path: '../secret.txt' } },
    { index: 2, done: true, check: { type: 'file_exists', path: path.join(outside, 'secret.txt') } },
    { index: 3, done: true, check: { type: 'file_exists', path: 'link/secret.txt' } },
  ] };
  const { evidence, claims } = verifyReport(report, criteria, cwd);
  assert.equal(evidence.length, 0);
  assert.deepEqual(claims.map(c => c.check), ['invalid', 'invalid', 'invalid']);
});

test('criteria without any report stay unclaimed; unknown indexes are ignored', () => {
  const { evidence, claims } = verifyReport({ criteria: [{ index: 9, done: true, check: null }] }, criteria, ws());
  assert.equal(evidence.length, 0);
  assert.deepEqual(claims.map(c => c.claimed), [false, false, false]);
  assert.deepEqual(verifyReport(null, criteria, ws()).claims.map(c => c.check), ['none', 'none', 'none']);
});

test('workspace fingerprint changes with content and is null for an empty folder', () => {
  const cwd = ws();
  assert.equal(workspaceFingerprint(cwd), null);
  writeFileSync(path.join(cwd, 'a.txt'), '1');
  const first = workspaceFingerprint(cwd);
  mkdirSync(path.join(cwd, 'node_modules'));
  writeFileSync(path.join(cwd, 'node_modules', 'ignored.js'), 'x');
  assert.equal(workspaceFingerprint(cwd), first, 'node_modules is ignored');
  writeFileSync(path.join(cwd, 'a.txt'), '2');
  assert.notEqual(workspaceFingerprint(cwd), first);
});

test('file_unchanged: attachments are proven unchanged against the fingerprint the engine recorded', async () => {
  const { createHash } = await import('node:crypto');
  const { mkdtempSync: mk, mkdirSync: md, writeFileSync: wf } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  const { attachmentOriginals } = await import('../src/goal-runner.js');
  const cwd = mk(path.join(td(), 'hq-unchanged-'));
  md(path.join(cwd, 'attachments'));
  wf(path.join(cwd, 'attachments', 'a.png'), 'A'); wf(path.join(cwd, 'attachments', 'b.hwpx'), 'B'); wf(path.join(cwd, 'attachments', 'b.hwpx.md'), 'B-md');
  const sha = t => createHash('sha256').update(t).digest('hex');
  // a.png: recorded at upload; b.hwpx(.md): only in an older run checkpoint (attachments sent before fingerprints existed)
  const goal = { messages: [{ role: 'user', attachments: [{ path: 'attachments/a.png', sha256: sha('A') }, { path: 'attachments/b.hwpx' }] }] };
  const records = [{ round: 3, checkpoint: { before: { signatures: { 'attachments/b.hwpx': sha('B'), 'attachments/b.hwpx.md': sha('B-md'), 'result.md': sha('x') } } } }];
  const originals = attachmentOriginals(goal, records);
  assert.deepEqual(Object.keys(originals).sort(), ['attachments/a.png', 'attachments/b.hwpx', 'attachments/b.hwpx.md'], 'only attachments, never other files');
  const C = ['첨부 파일은 바뀌지 않았다'];
  const check = paths => verifyReport({ criteria: [{ index: 1, done: true, check: { type: 'file_unchanged', paths } }] }, C, cwd, { originals });
  const ok = check(['attachments/a.png', 'attachments/b.hwpx', 'attachments/b.hwpx.md']);
  assert.equal(ok.evidence.length, 1);
  assert.match(ok.evidence[0].proof, /첨부할 때 기록한 지문.*3번째 단계 시작 전 기록/);
  wf(path.join(cwd, 'attachments', 'a.png'), 'changed');
  assert.match(check(['attachments/a.png']).claims[0].detail, /바뀜/);
  assert.match(check(['result.md']).claims[0].detail, /원래 지문 기록이 없음/, 'a file 대장 did not attach cannot be proven unchanged');
  assert.equal(check(['../outside']).claims[0].check, 'invalid');
});
