import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTING_POLICY, routeStep } from '../src/모델라우팅.js';
import { TEAMS } from '../src/팀.js';

// 모델 라우팅: 팀은 역할, 도구는 업무 적합성·격리·권한·사용량으로 고른다. 실전 배정에는 연결되지 않은 정책 시험.
const both = { 'claude-code': 'available', codex: 'available' };
const ready = { state: 'suspended', isolation: 'ready', trust: 'unsigned' };

test('every team has a kind, and team and tool stay separate', () => {
  for (const id of Object.keys(TEAMS)) assert.ok(ROUTING_POLICY.prefer[ROUTING_POLICY.teamKind[id]], id);
  // The same team can land on different tools depending on the work.
  assert.equal(routeStep({ team: 'qa', usage: both, codex: ready, mode: 'harness' }).executor, 'codex');
  assert.equal(routeStep({ team: 'qa', usage: { ...both, codex: 'limited' }, codex: ready, mode: 'harness' }).executor, 'claude-code');
});

test('initial policy: Claude plans, researches, designs and builds; Codex reviews and verifies (in the harness)', () => {
  for (const kind of ['plan', 'research', 'design', 'dev']) assert.equal(routeStep({ kind, usage: both, codex: ready, mode: 'harness' }).executor, 'claude-code', kind);
  for (const kind of ['code-review', 'verify']) {
    const r = routeStep({ kind, usage: both, codex: ready, mode: 'harness', workerExecutor: 'claude-code' });
    assert.equal(r.executor, 'codex', kind);
    assert.equal(r.backend, 'codex-wsl-isolated');
    assert.ok(r.reasons.some(x => x.includes('교차 검토')));
  }
});

test('complex development goes to Codex only after its own isolation trial is approved', () => {
  assert.equal(routeStep({ kind: 'dev-complex', usage: both, codex: ready, mode: 'harness' }).executor, 'claude-code');
  assert.equal(routeStep({ kind: 'dev-complex', usage: both, codex: ready, mode: 'harness', approvals: { complexDev: true } }).executor, 'codex');
});

test('cross-check: a review prefers the tool that did NOT do the work', () => {
  assert.equal(routeStep({ kind: 'code-review', usage: both, codex: ready, mode: 'harness', workerExecutor: 'codex' }).executor, 'claude-code');
  assert.equal(routeStep({ kind: 'security-review', usage: both, codex: ready, mode: 'harness', workerExecutor: 'claude-code' }).executor, 'codex');
});

test('Codex is never assigned in production while suspended, unsigned or not isolated', () => {
  const prod = routeStep({ kind: 'code-review', usage: both, codex: ready, mode: 'production', workerExecutor: 'claude-code' });
  assert.equal(prod.executor, 'claude-code');
  assert.ok(prod.considered.some(c => c.executor === 'codex' && /일시 중지/.test(c.why)));
  const unsigned = routeStep({ kind: 'code-review', usage: both, codex: { state: 'active', isolation: 'ready', trust: 'unsigned' }, workerExecutor: 'claude-code' });
  assert.ok(unsigned.considered.some(c => c.executor === 'codex' && /서명/.test(c.why)));
  const broken = routeStep({ kind: 'verify', usage: both, codex: { ...ready, isolation: 'blocked' }, mode: 'harness' });
  assert.ok(broken.considered.some(c => c.executor === 'codex' && /격리 실행 준비 안 됨/.test(c.why)));
  assert.equal(routeStep({ kind: 'code-review', usage: both, codex: { state: 'active', isolation: 'ready', trust: 'signed' }, workerExecutor: 'claude-code' }).executor, 'codex', 'only when all three hold');
});

test('capabilities: web and connector work never goes to Codex', () => {
  const r = routeStep({ kind: 'verify', needs: ['web'], usage: both, codex: ready, mode: 'harness' });
  assert.equal(r.executor, 'claude-code');
});

test('usage: a limit holds the step safely instead of failing it; no usable tool for other reasons blocks it', () => {
  const held = routeStep({ kind: 'dev', usage: { 'claude-code': 'limited', codex: 'available' }, codex: ready, mode: 'harness' });
  assert.equal(held.state, 'hold');
  assert.equal(held.executor, null);
  const unknown = routeStep({ kind: 'plan', usage: {}, codex: ready });
  assert.equal(unknown.state, 'hold');
  const blocked = routeStep({ kind: 'verify', needs: ['connectors'], usage: { 'claude-code': 'available' }, codex: { isolation: 'blocked' } });
  assert.equal(blocked.state, 'ready');
  assert.equal(routeStep({ kind: 'verify', needs: ['connectors'], usage: { 'claude-code': 'limited' }, codex: { isolation: 'blocked' } }).state, 'hold');
  assert.equal(routeStep({ kind: 'nonsense' }).state, 'blocked');
});
