import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHECK_NAMES, ROOT, checkArchitecture, judgeChange, readPolicy } from '../src/아키텍처가드.js';
import { autonomyDecision, LEVELS } from '../src/자율정책.js';
import { Memory } from '../src/기억.js';
import { PersistentStore } from '../src/영구저장소.js';

// 헌장 (AGENT_HQ_CONSTITUTION.md): this file fails the moment the Claude Code + Codex structure loses a piece.
const real = rel => import(pathToFileURL(path.join(ROOT, ...rel.split('/'))).href);
const failed = r => r.results.filter(x => !x.ok).map(x => x.name);

test('헌장: the repository as it is keeps every piece of the multi-model structure', async () => {
  const r = await checkArchitecture();
  assert.deepEqual(failed(r), [], r.results.filter(x => !x.ok).map(x => `${x.name}: ${x.problem}`).join('\n'));
  assert.equal(r.results.length, CHECK_NAMES.length);
});

test('헌장: removing Codex from the code is caught, whichever piece goes', async () => {
  const swap = (file, patch) => async rel => (rel === file ? { ...(await real(rel)), ...patch } : real(rel));
  const cases = [
    ['src/모델.js', { EXECUTORS: { 'claude-code': 'Claude Code' } }, '실행 도구'],
    ['src/실행어댑터.js', { buildCommand: provider => { if (provider === 'codex') throw new Error('unknown provider: codex'); return { file: 'claude', args: [] }; } }, 'Codex 실행 어댑터'],
    ['src/작업배정.js', { selectAssignment: () => ({ executor: 'claude-code' }) }, '교차 검토'],
    ['src/정책.js', { DEFAULT_POLICY: { providerConcurrent: { claude: 2 } } }, '사용량·동시 실행'],
    ['src/업무도메인.js', { chooseProvider: () => 'claude' }, '작업 인계'],
    ['src/자율정책.js', { autonomyDecision: () => ({ decision: 'auto' }) }, '대장 승인'],
  ];
  for (const [file, patch, name] of cases) {
    const r = await checkArchitecture({ load: swap(file, patch) });
    assert.deepEqual(failed(r), [name], `${file} 를 바꾸면 '${name}' 검사만 실패해야 한다`);
  }
});

test('헌장: Codex left out of every team is allowed only as a recorded, temporary pause with a way back', async () => {
  const policy = readPolicy();
  const s = policy.codexTeamExecution;
  assert.deepEqual(failed(await checkArchitecture({ policy: { ...policy, codexTeamExecution: { ...s, state: 'active' } } })), ['Codex 실행 상태']);
  assert.deepEqual(failed(await checkArchitecture({ policy: { ...policy, codexTeamExecution: { ...s, restorePlan: [] } } })), ['Codex 실행 상태'], 'a pause with no way back is a removal');
  assert.deepEqual(failed(await checkArchitecture({ policy: { ...policy, codexTeamExecution: { ...s, reviewBy: undefined } } })), ['Codex 실행 상태']);
  const late = await checkArchitecture({ now: '2099-01-01' });
  assert.equal(late.ok, true);
  assert.match(late.warnings[0], /재검토일\(2026-11-15\)을 넘겼다/, 'an overdue pause is reported, not hidden');
  assert.deepEqual(failed(await checkArchitecture({ policy: { ...policy, constitution: { ...policy.constitution, sha256: '0'.repeat(64) } } })), ['헌장'], 'an edited constitution needs its fingerprint renewed');
  assert.deepEqual(failed(await checkArchitecture({ policy: { ...policy, executors: ['claude-code'] } })), ['실행 도구']);
});

test('헌장: proposals are judged — deleting Codex is refused, pausing it to rebuild safely needs 대장', () => {
  const remove = judgeChange('Codex 샌드박스 보안 문제가 있으므로 Codex 관련 코드를 전부 삭제하고 Claude 전용 시스템으로 전환합니다.');
  assert.equal(remove.verdict, 'violation');
  assert.equal(judgeChange('Codex 실행을 일시 중지하고, 별도 격리 환경을 구현한 뒤 교차 검증 기능을 복원합니다.').verdict, 'core');
  assert.equal(judgeChange('앞으로 모든 팀은 Claude만 사용한다').verdict, 'violation');
  assert.equal(judgeChange('교차 검토를 없애서 단계 수를 줄인다').verdict, 'violation');
  assert.equal(judgeChange('Codex를 영구 제외하고 격리는 하지 않는다').verdict, 'violation', '"격리" in the sentence does not excuse 영구');
  assert.equal(judgeChange('검증팀의 교차 검토에 Codex를 더 자주 배정한다').verdict, 'core');
  assert.equal(judgeChange('사무실 화면의 말풍선 색을 바꾼다').verdict, 'ok');
});

test('헌장: no autonomy level approves a core design change on its own', () => {
  for (const level of LEVELS) assert.equal(autonomyDecision('architecture', { level }).decision, 'ask');
});

test('헌장: a lesson that would steer every later step away from Codex is not kept; a temporary one waits for 대장, marked', () => {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-arch-')) });
  try {
    const memory = new Memory({ store });
    const added = memory.propose([
      'Codex는 보안 문제가 있으니 앞으로 쓰지 않고 Claude만 사용한다',
      'Codex 격리 환경이 준비될 때까지 일시적으로 검증은 Claude Code로 한다',
      '조사 결과에는 출처 주소를 함께 적는다',
    ], { team: 'qa', project: 'p1', kind: 'lesson' });
    assert.deepEqual(added.map(a => a.text), ['Codex 격리 환경이 준비될 때까지 일시적으로 검증은 Claude Code로 한다', '조사 결과에는 출처 주소를 함께 적는다']);
    assert.match(added.refused[0].text, /앞으로 쓰지 않고 Claude만/);
    assert.ok(added[0].architecture?.length, 'the temporary one carries the reason 대장 must look');
    assert.equal(added[1].architecture, undefined);
    assert.equal(memory.list().length, 2);
  } finally { store.close(); }
});
