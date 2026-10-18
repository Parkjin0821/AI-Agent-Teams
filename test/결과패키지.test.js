import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPackage, kindsOf, statusOf, writePackage, PACKAGE_DIR } from '../src/결과패키지.js';
import { isEngineFile } from '../src/완료근거.js';

const C = ['가계부집계.js 가 있다', '엔진이 돌린 테스트가 통과한다', '읽기 편하다 (대장이 화면에서 확인) — 자동 검증 불가: 취향'];
const goal = (extra = {}) => ({ id: 'g1', projectId: 'p1', kind: 'team', title: '가계부 모듈', objective: 'CSV 가계부를 집계한다', completionCriteria: C,
  status: 'review_required', reason: 'owner_approval', question: '[엔진] 자율 작업은 끝났고 …',
  evidence: [{ criterion: C[0], by: 'engine', proof: '엔진 확인 · 파일 가계부집계.js 있음', at: 't' }, { criterion: C[1], by: 'engine', proof: '엔진 확인 · 샌드박스에서 npm test 통과', test: { label: 'npm test' } }],
  messages: [{ role: 'user', kind: 'answer', text: '수입은 양수로 해 줘', at: '2026-10-18T09:00' }],
  taskPlan: { tasks: [
    { id: 'T1', title: '집계 모듈', team: 'dev', outputs: ['가계부집계.js'], criteria: [1, 2], dependsOn: [], status: 'done', attempts: 1,
      handoff: { made: [{ path: '가계부집계.js', ok: true }], decisions: ['상위3은 전체 기간'], openIssues: ['따옴표 필드 미지원'], forNext: '' } },
    { id: 'T2', title: '사용 설명', team: 'dev', outputs: ['README.md'], criteria: [], dependsOn: ['T1'], status: 'pending', attempts: 0 } ] },
  ...extra });

test('결과 패키지: the status is what the engine verified — never 완료 before it', () => {
  assert.equal(statusOf({ status: 'verified' }).label, '완료 · 엔진 검증 통과');
  assert.equal(statusOf({ status: 'review_required', reason: 'owner_approval' }).label, '자율 작업 완료 · 대장 최종 확인 대기');
  assert.equal(statusOf({ status: 'running' }).label, '진행 중 · 아직 완료 아님');
  assert.equal(statusOf({ status: 'blocked' }).label, '멈춤');
  const pkg = buildPackage({ goal: goal(), files: ['가계부집계.js', '가계부집계.test.js', 'package.json'], packageJson: { scripts: { test: 'node --test' } },
    runs: [{ team: 'dev' }, { team: 'qa', tools: [{ id: 'tests', status: 'pass' }] }], events: [{ type: 'policy.auto', kind: 'criteria', level: 'L2', rule: 'L2 · 사전 점검 통과', at: '2026-10-18T08:00' }], now: '2026-10-18T10:00:00Z' });
  assert.deepEqual(Object.keys(pkg), ['PROJECT_SUMMARY.md', 'TASK_MANIFEST.json', 'DECISIONS.md', 'OPEN_ISSUES.md', 'HANDOFF.md', 'evidence/evidence.json']);
  const s = pkg['PROJECT_SUMMARY.md'];
  assert.match(s, /\*\*상태:\*\* 자율 작업 완료 · 대장 최종 확인 대기/);
  assert.doesNotMatch(s, /상태:\*\* 완료/);
  assert.match(s, /\| 가계부집계.js \| T1 집계 모듈 \| ✓ \|/);
  assert.match(s, /\| README.md \| T2 사용 설명 \| 없음 \|/, 'a planned output that is missing says so');
  assert.match(s, /\| 3 \| · \| 읽기 편하다[^|]*\| 대장 확인 대기 \|/);
  assert.match(s, /테스트: 작업 폴더에서 `npm test`/);
  const open = pkg['OPEN_ISSUES.md'];
  for (const want of ['완료 조건 미충족: 읽기 편하다', '작업 T2 사용 설명 · 대기', 'T1 남은 문제: 따옴표 필드 미지원', '계획된 산출물이 없음: README.md', '대장에게 묻는 중']) assert.ok(open.includes(want), want);
  assert.match(pkg['DECISIONS.md'], /대장: 수입은 양수로 해 줘[\s\S]*엔진 자동 승인 \(L2\): criteria · L2 · 사전 점검 통과[\s\S]*T1 개발팀: 상위3은 전체 기간/);
  const manifest = JSON.parse(pkg['TASK_MANIFEST.json']);
  assert.deepEqual([manifest.status, manifest.tasks[1].outputs[0].exists, manifest.criteria[2].ownerJudged], ['owner', false, true]);
  assert.equal(JSON.parse(pkg['evidence/evidence.json']).criteria[1].test.label, 'npm test');
  assert.match(pkg['HANDOFF.md'], /## 다음에 할 일[\s\S]*완료 조건 미충족/);
});

test('결과 패키지: what it stresses follows what the project made; it is written as the engine\'s own files', () => {
  assert.deepEqual(kindsOf(['index.html', 'sources/a.html', '보고서.hwpx', '발표자료/x.pdf', '표.xlsx']), { code: false, web: true, document: true, slides: true, research: true, sheet: true });
  const web = buildPackage({ goal: goal({ status: 'verified', reason: null, evidence: C.map(c => ({ criterion: c, by: '대장' })), taskPlan: null }), files: ['index.html', 'sources/원문.html'] });
  assert.match(web['PROJECT_SUMMARY.md'], /화면: 브라우저로 index.html 를 연다[\s\S]*출처: sources\//);
  assert.match(web['OPEN_ISSUES.md'], /없음 · 모든 완료 조건이 증명됨/);
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-pkg-'));
  const written = writePackage(cwd, web);
  assert.ok(written.every(f => f.startsWith(PACKAGE_DIR + '/') && isEngineFile(f)));
  assert.ok(existsSync(path.join(cwd, 'reports', '결과패키지', 'evidence', 'evidence.json')));
  assert.match(readFileSync(path.join(cwd, 'reports', '결과패키지', 'PROJECT_SUMMARY.md'), 'utf8'), /완료 · 엔진 검증 통과/);
});
