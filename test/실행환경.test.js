import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assessUsage } from '../src/정책.js';
import { PersistentStore } from '../src/영구저장소.js';
import { Orchestrator } from '../src/작업조율.js';
import { ProjectWorkspaces } from '../src/작업공간.js';

test('execution uses project directory and requires explicit completion criteria', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-boundary-'));
  const store = new PersistentStore({ dataDir: path.join(root, 'data') });
  const workspaces = new ProjectWorkspaces(path.join(root, 'projects'));
  let received;
  const runner = new Orchestrator({ store, workspaces, adapter: {
    enabled: true, run: async (...args) => { received = args[3]; return { outcome: 'completed', summary: 'done' }; }
  } });
  await assert.rejects(runner.submit({ title: 'missing', prompt: 'build' }), /completion criteria/);
  runner.usage.claude = usage(50, 50);
  const task = await runner.submit({ title: 'build', prompt: 'build', projectId: 'sample', completionCriteria: ['Tests pass'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.cwd, workspaces.resolve('sample'));
  assert.deepEqual(store.getTask(task.id).completionCriteria, ['Tests pass']);
  assert.equal(store.getTask(task.id).status, 'awaiting_verification');
  store.close();
});

function usage(five, week, metric = 'remaining') {
  return { windows: [{ period: 'five_hour', metric, percent: five, observedAt: new Date().toISOString() },
    { period: 'weekly', metric, percent: week, observedAt: new Date().toISOString() }] };
}
test('quota boundaries agree for opposite display metrics', () => {
  assert.equal(assessUsage(usage(20.1, 11)).state, 'available');
  assert.equal(assessUsage(usage(20, 11)).state, 'limited');
  assert.equal(assessUsage(usage(20, 10)).state, 'limited');
  assert.equal(assessUsage(usage(79.9, 89, 'used')).state, 'available');
  assert.equal(assessUsage(usage(80, 89, 'used')).state, 'limited');
  assert.equal(assessUsage(usage(40, 90, 'used')).state, 'limited');
  assert.equal(assessUsage({ windows: [] }).state, 'unknown');
});
test('tasks survive restart and interrupted work requires recovery', async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'agent-hq-'));
  let store = new PersistentStore({ dataDir });
  store.saveTask({ id: 'test', status: 'running', createdAt: new Date().toISOString(), checkpoint: {} });
  store.close(); store = new PersistentStore({ dataDir });
  new Orchestrator({ store, adapter: { enabled: false } });
  assert.equal(store.getTask('test').status, 'recovery_required'); store.close();
});
test('two independent projects run concurrently, same project waits', async () => {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'agent-hq-')) });
  const releases = [];
  const adapter = { enabled: false, run: async () => new Promise(resolve => releases.push(resolve)) };
  const runner = new Orchestrator({ store, adapter });
  const a = await runner.submit({ title: 'a', prompt: 'a', projectId: 'one' });
  await runner.submit({ title: 'b', prompt: 'b', projectId: 'one' });
  await runner.submit({ title: 'c', prompt: 'c', projectId: 'two' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runner.active.size, 2);
  assert.equal(new Set([...runner.active.values()].map(a => a.projectId)).size, 2);
  releases.splice(0).forEach(resolve => resolve({ outcome: 'simulated', summary: 'dry' }));
  await new Promise(resolve => setImmediate(resolve));
  releases.splice(0).forEach(resolve => resolve({ outcome: 'simulated', summary: 'dry' }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getTask(a.id).status, 'simulated'); store.close();
});
test('both providers limited terminate handoff without infinite retry', async () => {
  const store = new PersistentStore({ dataDir: mkdtempSync(path.join(tmpdir(), 'agent-hq-')) });
  let calls = 0;
  const runner = new Orchestrator({ store, adapter: { enabled: false, run: async () => { calls++; return { outcome: 'limited', summary: 'quota' }; } } });
  const task = await runner.submit({ title: 'limit', prompt: 'stop' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2); assert.equal(store.getTask(task.id).status, 'waiting_capacity');
  assert.equal(runner.active.size, 0); store.close();
});
