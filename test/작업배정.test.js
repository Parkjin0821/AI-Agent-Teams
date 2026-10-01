import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAssignment } from '../src/작업배정.js';
const catalog = ['claude-code','codex'].map((executor,i) => ({ id: `model-${i}`, executor, tier: 2,
  capabilities: ['text','code'], efforts: ['low','medium','high'], available: true,
  supportEvidence: { url: 'https://example.org/official', checkedAt: '2026-09-29' }, accountCheckedAt: '2026-09-29' }));
test('a validated team proposal may assign UI to either provider without a brand rule', () => {
  for (const e of catalog) {
    const result = selectAssignment({ catalog, team: 'design', profile: { proposedModel: e.id, proposalReason: 'task-specific fit' } });
    assert.equal(result.model, e.id);
    assert.equal(result.reason, 'validated_team_proposal');
  }
});
test('proposal cannot override missing image capability, quota, pin or independent review', () => {
  assert.equal(selectAssignment({ catalog, team: 'design', profile: { taskType: 'image', proposedModel: 'model-1' } }).state, 'waiting');
  assert.equal(selectAssignment({ catalog, team: 'dev', capacity: () => false }).state, 'waiting');
  const connectorCatalog = catalog.map(e => ({ ...e, capabilities: [...e.capabilities, 'connectors'] }));
  assert.equal(selectAssignment({ catalog: connectorCatalog, team: 'design', profile: { taskType: 'connector' },
    runtimeCapabilities: { 'claude-code': ['text','code'], codex: ['text','code'] } }).state, 'waiting');
  assert.equal(selectAssignment({ catalog, team: 'dev', project: { mode: 'pinned', model: 'missing' } }).state, 'waiting');
  assert.equal(selectAssignment({ catalog, team: 'qa', excludeExecutor: 'codex', profile: { proposedModel: 'model-1' } }).executor, 'claude-code');
});
test('only matching measured evaluations rank above a model suggestion', () => {
  const measured = { source: 'project', model: 'model-1', executor: 'codex', evalTaskId: 'ui-eval', conditionsKey: 'v1', reasoning: 'medium',
    metrics: { violations: 0, criteriaPassRate: .9 } };
  const args = { catalog, team: 'design', profile: { proposedModel: 'model-0', evalTaskId: 'ui-eval', conditionsKey: 'v1' }, evaluations: [measured] };
  assert.equal(selectAssignment(args).model, 'model-1');
  assert.equal(selectAssignment({ ...args, evaluations: [{ ...measured, source: 'public_benchmark' }] }).model, 'model-0');
  assert.equal(selectAssignment({ ...args, evaluations: [{ ...measured, conditionsKey: 'different' }] }).model, 'model-0');
});
