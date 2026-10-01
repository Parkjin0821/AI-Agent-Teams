import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAssignment, isUsable, resolveModel } from '../src/모델.js';

const verified = (id, label, executor = 'claude-code') => ({ executor, id, label,
  supportEvidence: { url: 'https://code.claude.com/docs/en/model-config', checkedAt: '2026-09-28T00:00:00Z' },
  accountCheckedAt: '2026-09-28T00:00:00Z', available: true });
const catalog = [verified('model-a', 'Model A'), verified('model-b', 'Model B'),
  { executor: 'claude-code', id: 'rumoured', label: 'Rumoured', supportEvidence: null, accountCheckedAt: null }];

test('assignment shows team, execution tool and model separately', () => {
  assert.equal(formatAssignment({ team: '개발팀', executor: 'claude-code', model: catalog[0] }), '개발팀 · Claude Code · Model A');
  assert.equal(formatAssignment({ team: '개발팀', executor: 'codex', model: null }), '개발팀 · Codex · 확인 필요');
  assert.equal(formatAssignment({ team: '개발팀', executor: 'claude-code', model: catalog[2] }), '개발팀 · Claude Code · 확인 필요');
  assert.throws(() => formatAssignment({ team: '개발팀', executor: 'gpt-cli', model: null }), /executor/);
});

test('a model needs official support evidence and an account check to be usable', () => {
  assert.equal(isUsable(catalog[0]), true);
  assert.equal(isUsable(catalog[2]), false);
  assert.equal(isUsable({ ...catalog[0], accountCheckedAt: null }), false);
  assert.equal(isUsable({ ...catalog[0], available: false }), false);
});

test('auto mode uses the approved default, else the tool default without inventing a model', () => {
  const base = { executor: 'claude-code', catalog };
  assert.deepEqual(resolveModel({ ...base, project: { mode: 'auto', autoDefaults: { 'claude-code': 'model-b' } } }),
    { state: 'ready', model: 'model-b', source: 'approved_default' });
  assert.deepEqual(resolveModel({ ...base, project: { mode: 'auto' } }), { state: 'ready', model: null, source: 'executor_default' });
  assert.deepEqual(resolveModel({ ...base, project: { mode: 'auto', autoDefaults: { 'claude-code': 'rumoured' } } }),
    { state: 'ready', model: null, source: 'executor_default' });
});

test('a pinned model that is unavailable waits unless fallback is explicitly allowed', () => {
  const base = { executor: 'claude-code', catalog };
  assert.deepEqual(resolveModel({ ...base, project: { mode: 'pinned', model: 'model-a' } }), { state: 'ready', model: 'model-a', source: 'project_pin' });
  assert.deepEqual(resolveModel({ ...base, project: { mode: 'pinned', model: 'rumoured' } }),
    { state: 'waiting', reason: 'pinned_model_unavailable', model: 'rumoured' });
  assert.deepEqual(resolveModel({ ...base, project: { mode: 'pinned', model: 'rumoured', allowFallback: true } }),
    { state: 'ready', model: null, source: 'executor_default', fallbackFrom: 'rumoured' });
});

test('task override beats project policy; inherit follows it', () => {
  const base = { executor: 'claude-code', catalog, project: { mode: 'pinned', model: 'model-a' } };
  assert.equal(resolveModel({ ...base, task: { mode: 'inherit' } }).model, 'model-a');
  assert.deepEqual(resolveModel({ ...base, task: { mode: 'pinned', model: 'model-b' } }), { state: 'ready', model: 'model-b', source: 'task_pin' });
  assert.equal(resolveModel({ ...base, task: { mode: 'pinned', model: 'rumoured' } }).state, 'waiting');
});
