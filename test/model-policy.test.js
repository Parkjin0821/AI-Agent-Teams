import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/persistent-store.js';
import { ModelRegistry } from '../src/model-policy.js';

const T0 = Date.parse('2026-09-28T00:00:00Z');
const setup = (dataDir = mkdtempSync(path.join(tmpdir(), 'hq-policy-'))) => {
  const store = new PersistentStore({ dataDir });
  return { store, dataDir, registry: new ModelRegistry({ store, clock: { now: () => T0 } }) };
};

test('unset project policy is auto with fallback off at version 0', () => {
  const { registry, store } = setup();
  assert.deepEqual(registry.getPolicy('project:sample'), { mode: 'auto', allowFallback: false, autoDefaults: {}, version: 0 });
  store.close();
});

test('policy changes create versions, keep history and survive restart', () => {
  const { registry, store, dataDir } = setup();
  registry.setPolicy('project:sample', { mode: 'pinned', model: 'model-a' }, { by: '대장', reason: 'stable model' });
  registry.setPolicy('project:sample', { allowFallback: true }, { by: '대장', reason: 'allow fallback' });
  store.close();
  const again = setup(dataDir);
  const policy = again.registry.getPolicy('project:sample');
  assert.equal(policy.version, 2);
  assert.equal(policy.mode, 'pinned');
  assert.equal(policy.allowFallback, true);
  assert.deepEqual(again.registry.history('project:sample').map(h => [h.version, h.reason]), [[1, 'stable model'], [2, 'allow fallback']]);
  again.store.close();
});

test('invalid policy is rejected', () => {
  const { registry, store } = setup();
  assert.throws(() => registry.setPolicy('project:sample', { mode: 'always-best' }, { by: '대장' }), /mode/);
  assert.throws(() => registry.setPolicy('project:sample', { mode: 'pinned' }, { by: '대장' }), /model/);
  assert.throws(() => registry.setPolicy('project:sample', { mode: 'auto' }, {}), /by/);
  store.close();
});

test('rollback restores an earlier policy as a new version without erasing history', () => {
  const { registry, store } = setup();
  registry.setPolicy('project:sample', { mode: 'pinned', model: 'model-a' }, { by: '대장' });
  registry.setPolicy('project:sample', { model: 'model-b' }, { by: '대장' });
  const rolled = registry.rollback('project:sample', 1, { by: '대장', reason: 'model-b regressed' });
  assert.equal(rolled.version, 3);
  assert.equal(rolled.model, 'model-a');
  assert.equal(registry.history('project:sample').length, 3);
  assert.equal(registry.history('project:sample')[2].rolledBackTo, 1);
  assert.throws(() => registry.rollback('project:sample', 9, { by: '대장' }), /version/);
  store.close();
});

test('catalog stores models per execution tool; unverified entries stay unusable', () => {
  const { registry, store } = setup();
  registry.upsertModel({ executor: 'claude-code', id: 'model-a', label: 'Model A' });
  registry.upsertModel({ executor: 'codex', id: 'model-a', label: 'Other tool model A',
    supportEvidence: { url: 'https://developers.openai.com/codex', checkedAt: '2026-09-28T00:00:00Z' }, accountCheckedAt: '2026-09-28T00:00:00Z' });
  assert.equal(registry.catalog().length, 2);
  assert.deepEqual(registry.catalog().filter(m => m.usable).map(m => m.executor), ['codex']);
  assert.throws(() => registry.upsertModel({ executor: 'other', id: 'x', label: 'X' }), /executor/);
  store.close();
});
