import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/영구저장소.js';
import { ProjectWorkspaces } from '../src/작업공간.js';
import { AutoSave } from '../src/자동저장.js';

function setup({ simulated = false, failure = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-autosave-'));
  const store = new PersistentStore({ dataDir: path.join(root, 'data') });
  const workspaces = new ProjectWorkspaces(path.join(root, 'projects'));
  const cwd = workspaces.resolve('sample');
  writeFileSync(path.join(cwd, '앱.js'), 'export const value = 1;');
  store.saveGoal({ id: 'g', projectId: 'sample', title: 'Demo', status: 'verified', completionCriteria: ['file exists'], evidence: [] });
  store.insertRun({ id: 'r', goalId: 'g', round: 1, attempt: 0, status: 'finished', outcome: 'completed', simulated, team: 'dev', executor: 'claude-code' });
  const calls = [];
  const clock = { t: 1000, now() { return this.t; } };
  const transport = { status: () => ({ github: 'test', notion: 'test' }), save: async (provider, payload, policy) => {
    calls.push({ provider, payload, policy });
    if (failure) throw new Error('a secret remote error that must not be logged');
    return { url: 'https://example.org/saved' };
  } };
  const worker = new AutoSave({ store, workspaces, transport, clock });
  return { root, store, cwd, calls, clock, worker };
}
test('auto-save requires opt-in, exports code only to GitHub payload and deduplicates ticks', async () => {
  const { store, worker, calls } = setup();
  try {
    await worker.tick(); assert.equal(calls.length, 0);
    worker.configure('sample', { github: true, notion: true });
    await Promise.all([worker.tick(), worker.tick()]);
    await worker.tick();
    assert.deepEqual(calls.map(c => c.provider), ['github','notion']);
    assert.equal(calls[0].payload.files[0].path, '앱.js');
    assert.equal(calls[1].payload.files, undefined, 'Notion receives metadata, not source code');
    assert.equal(worker.view('sample').jobs.every(j => j.status === 'saved'), true);
    assert.equal(worker.view('sample').jobs.some(j => j.payload), false);
  } finally { store.close(); }
});
test('simulated runs never produce external save jobs', async () => {
  const { store, worker, calls } = setup({ simulated: true });
  try { worker.configure('sample', { github: true, notion: true }); await worker.tick(); assert.equal(calls.length, 0); }
  finally { store.close(); }
});
test('frozen export scan blocks secrets and unsupported policy cannot request public repositories', async () => {
  const { store, worker, calls, cwd } = setup();
  try {
    worker.configure('sample', { github: true, notion: true });
    writeFileSync(path.join(cwd, '앱.js'), '-----BEGIN PRIVATE KEY-----');
    await worker.tick(); assert.equal(calls.length, 0);
    assert.equal(worker.view('sample').warning, 'security_review_required');
    assert.throws(() => worker.configure('sample', { public: true }), /unsupported/);
  } finally { store.close(); }
});
test('bounded retries and restart preserve jobs without storing remote error text', async () => {
  const { store, worker, calls, clock } = setup({ failure: true });
  try {
    worker.configure('sample', { github: true });
    await worker.tick(); await worker.tick(); assert.equal(calls.length, 1);
    clock.t += 60000; await worker.tick();
    clock.t += 300000; await worker.tick();
    assert.equal(calls.length, 3);
    assert.equal(worker.view('sample').jobs[0].status, 'blocked');
    assert.doesNotMatch(JSON.stringify(worker.view('sample')), /secret remote/);
    await worker.tick(); assert.equal(calls.length, 3);
  } finally { store.close(); }
});
test('unconnected production adapter never reports a successful external save', async () => {
  const { store, worker } = setup();
  try {
    const disconnected = new AutoSave({ store, workspaces: worker.workspaces });
    disconnected.configure('sample', { notion: true });
    await disconnected.tick();
    assert.equal(disconnected.view('sample').jobs[0].status, 'blocked');
    assert.equal(disconnected.view('sample').jobs[0].reason, 'authentication_required');
    assert.equal(disconnected.view('sample').authentication.notion, 'external_adapter_not_connected');
  } finally { store.close(); }
});
