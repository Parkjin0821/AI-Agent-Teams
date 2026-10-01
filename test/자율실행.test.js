import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel } from '../src/모델.js';
test('adaptive assignment escalates reasoning only on verified candidates', () => {
  const catalog = [
    { id: 'standard', label: 'Standard', executor: 'codex', tier: 1, efforts: ['low','medium','high'], supportEvidence: { url: 'https://learn.chatgpt.com/docs/models', checkedAt: '2026-09-29' }, accountCheckedAt: '2026-09-29' },
    { id: 'deep', label: 'Deep', executor: 'codex', tier: 2, efforts: ['medium','high'], supportEvidence: { url: 'https://learn.chatgpt.com/docs/models', checkedAt: '2026-09-29' }, accountCheckedAt: '2026-09-29' },
  ];
  const project = { mode: 'auto', strategy: 'adaptive' };
  assert.equal(resolveModel({ executor: 'codex', project, catalog, context: { failures: 0 } }).model, 'standard');
  const hard = resolveModel({ executor: 'codex', project, catalog, context: { failures: 2 } });
  assert.equal(hard.model, 'deep'); assert.equal(hard.effort, 'high');
  // Nothing registered: the tool's own default model runs (no --model flag), nothing is assumed.
  assert.deepEqual(resolveModel({ executor: 'codex', project, catalog: [] }), { state: 'ready', model: null, source: 'executor_default', reason: 'app_default_no_profiles' });
  // Registered, but none meets the risk tier: still waits rather than using a weaker model.
  assert.equal(resolveModel({ executor: 'codex', project, catalog: [catalog[0]], context: { critical: true } }).state, 'waiting');
});
