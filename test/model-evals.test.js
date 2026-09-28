import test from 'node:test';
import assert from 'node:assert/strict';
import { compareModels, validateEval } from '../src/model-evals.js';

const run = (model, metrics = {}, extra = {}) => ({
  source: 'project', evalTaskId: 'task-login-form', conditionsKey: 'repo@a41c9e;criteria-v2;timeout-30m', isolated: true,
  executor: 'claude-code', executorVersion: '2.1.265', model, modelVersion: `${model}-2026-09`, reasoning: 'default',
  metrics: { criteriaPassRate: 1, testPassRate: 1, reworkCount: 0, durationMs: 600_000, usage: null, violations: 0, ...metrics },
  ...extra,
});

test('evaluation records must carry model, version, reasoning, tool version and eval task', () => {
  assert.doesNotThrow(() => validateEval(run('model-a')));
  for (const key of ['model', 'modelVersion', 'reasoning', 'executorVersion', 'evalTaskId', 'conditionsKey']) {
    assert.throws(() => validateEval({ ...run('model-a'), [key]: '' }), new RegExp(key));
  }
  assert.throws(() => validateEval(run('model-a', { criteriaPassRate: 1.2 })), /criteriaPassRate/);
  assert.throws(() => validateEval(run('model-a', { violations: -1 })), /violations/);
});

test('usage must be verified or null; estimates are rejected', () => {
  assert.doesNotThrow(() => validateEval(run('model-a', { usage: { value: 12, unit: 'percent_5h', verifiedSource: 'codex /status' } })));
  assert.throws(() => validateEval(run('model-a', { usage: { value: 12, unit: 'percent_5h', estimated: true, verifiedSource: 'guess' } })), /estimated/);
  assert.throws(() => validateEval(run('model-a', { usage: { value: 12, unit: 'percent_5h' } })), /verifiedSource/);
});

test('public benchmarks are kept apart from project evaluations', () => {
  const bench = { source: 'public_benchmark', model: 'model-b', modelVersion: 'v', benchmark: 'SWE-bench Verified', score: 0.7, url: 'https://example.org/leaderboard', recordedAt: '2026-09-28' };
  assert.doesNotThrow(() => validateEval(bench));
  const result = compareModels([run('model-a'), run('model-b'), bench],
    { evalTaskId: 'task-login-form', conditionsKey: run('x').conditionsKey, baseline: 'model-a', candidate: 'model-b' });
  assert.equal(result.candidate.runs, 1);
  assert.deepEqual(result.publicBenchmarks.map(b => b.benchmark), ['SWE-bench Verified']);
});

test('only same task and conditions are compared; unknown usage stays unknown', () => {
  const records = [
    run('model-a', { usage: { value: 20, unit: 'percent_5h', verifiedSource: 'claude /usage' } }),
    run('model-a', { usage: null, criteriaPassRate: 0.5 }),
    run('model-b', { durationMs: 300_000 }),
    run('model-b', {}, { conditionsKey: 'different' }),
    run('model-b', { criteriaPassRate: 0 }, { evalTaskId: 'other-task' }),
  ];
  const result = compareModels(records, { evalTaskId: 'task-login-form', conditionsKey: run('x').conditionsKey, baseline: 'model-a', candidate: 'model-b' });
  assert.equal(result.comparable, true);
  assert.equal(result.baseline.runs, 2);
  assert.equal(result.baseline.criteriaPassRate, 0.75);
  assert.equal(result.baseline.usage, null, 'one run without verified usage makes the aggregate unknown');
  assert.equal(result.candidate.runs, 1);
  assert.equal(result.candidate.usage, null);
  assert.equal(result.recommendation, 'candidate');
});

test('no same-condition runs means no comparison; violations block a recommendation', () => {
  const opts = { evalTaskId: 'task-login-form', conditionsKey: run('x').conditionsKey, baseline: 'model-a', candidate: 'model-b' };
  assert.deepEqual(compareModels([run('model-a')], opts).comparable, false);
  const risky = compareModels([run('model-a', { criteriaPassRate: 0.5 }), run('model-b', { violations: 1 })], opts);
  assert.equal(risky.recommendation, 'keep_baseline');
  assert.match(risky.reasons.join(' '), /violation/);
});
