import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/persistent-store.js';
import { ModelRegistry } from '../src/model-policy.js';
import { ModelChangePipeline } from '../src/model-changes.js';

const T0 = Date.parse('2026-09-28T00:00:00Z');
const SCOPE = 'project:sample';
const COND = { evalTaskId: 'task-login-form', conditionsKey: 'repo@a41c9e;criteria-v2' };
const evalRun = (model, metrics = {}, extra = {}) => ({ source: 'project', ...COND, isolated: true, executor: 'claude-code',
  executorVersion: '2.1.265', model, modelVersion: `${model}-v1`, reasoning: 'default',
  metrics: { criteriaPassRate: 1, testPassRate: 1, reworkCount: 0, durationMs: 1000, usage: null, violations: 0, ...metrics }, ...extra });

function setup() {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'hq-change-')) });
  const clock = { now: () => T0 };
  const registry = new ModelRegistry({ store, clock });
  const pipeline = new ModelChangePipeline({ store, registry, clock });
  pipeline.recordEval(evalRun('model-a', { criteriaPassRate: 0.6 }));
  const candidate = pipeline.discover({ executor: 'claude-code', model: 'model-b', label: 'Model B', source: 'release notes' });
  return { store, registry, pipeline, candidate };
}
const support = { url: 'https://code.claude.com/docs/en/model-config', checkedAt: '2026-09-28T00:00:00Z' };

test('stages cannot be skipped', () => {
  const { pipeline, candidate, store } = setup();
  assert.throws(() => pipeline.approve(candidate.id, { by: '대장' }), /stage/);
  assert.throws(() => pipeline.markEvaluated(candidate.id), /stage/);
  assert.throws(() => pipeline.confirmSupport(candidate.id, { url: 'not a url', checkedAt: support.checkedAt }), /https/);
  pipeline.confirmSupport(candidate.id, support);
  assert.throws(() => pipeline.markEvaluated(candidate.id), /isolated/);
  store.close();
});

test('discovered models stay unusable until support is confirmed and an isolated run succeeds', () => {
  const { pipeline, registry, candidate, store } = setup();
  const usable = () => registry.catalog().find(m => m.id === 'model-b').usable;
  assert.equal(usable(), false);
  pipeline.confirmSupport(candidate.id, support);
  assert.equal(usable(), false);
  pipeline.recordEval(evalRun('model-b'));
  pipeline.markEvaluated(candidate.id);
  assert.equal(usable(), true);
  store.close();
});

test('comparison only recommends; the default changes after approval and can be reverted', () => {
  const { pipeline, registry, candidate, store } = setup();
  pipeline.confirmSupport(candidate.id, support);
  pipeline.recordEval(evalRun('model-b'));
  pipeline.markEvaluated(candidate.id);
  const compared = pipeline.compare(candidate.id, { baseline: 'model-a', ...COND });
  assert.equal(compared.recommendation, 'candidate');
  assert.equal(registry.getPolicy(SCOPE).version, 0, 'a recommendation must not change the policy');
  assert.throws(() => pipeline.apply(candidate.id, { scope: SCOPE, by: '대장' }), /stage/);

  pipeline.approve(candidate.id, { by: '대장' });
  const applied = pipeline.apply(candidate.id, { scope: SCOPE, by: '대장' });
  assert.equal(applied.stage, 'applied');
  assert.equal(registry.getPolicy(SCOPE).autoDefaults['claude-code'], 'model-b');

  const reverted = pipeline.revert(candidate.id, { by: '대장', reason: 'regression in project' });
  assert.equal(reverted.stage, 'rolled_back');
  assert.equal(registry.getPolicy(SCOPE).autoDefaults['claude-code'], undefined);
  assert.equal(registry.history(SCOPE).length, 2);
  assert.deepEqual(pipeline.get(candidate.id).history.map(h => h.stage),
    ['discovered', 'support_confirmed', 'evaluated', 'compared', 'approved', 'applied', 'rolled_back']);
  store.close();
});

test('a candidate that is not better cannot be approved', () => {
  const { pipeline, candidate, store } = setup();
  pipeline.confirmSupport(candidate.id, support);
  pipeline.recordEval(evalRun('model-b', { criteriaPassRate: 0.2 }));
  pipeline.markEvaluated(candidate.id);
  assert.equal(pipeline.compare(candidate.id, { baseline: 'model-a', ...COND }).recommendation, 'keep_baseline');
  assert.throws(() => pipeline.approve(candidate.id, { by: '대장' }), /recommend/);
  store.close();
});
