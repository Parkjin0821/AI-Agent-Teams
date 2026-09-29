import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueRequests, normalizeRequests, requiredReviews, taskProfile } from '../src/team-governance.js';
import { projectRecord } from '../src/records.js';

test('engine reviews cannot be skipped by worker selection', () => {
  for (const team of ['dev','design','research']) assert.deepEqual(requiredReviews(team), ['security','policy']);
  assert.deepEqual(requiredReviews('plan'), []);
});
test('requests are bounded, deduplicated and effects never grant permission', () => {
  const raw = { team: 'design', task: '화면 점검', criteria: ['점검표 존재'], risk: 'low', effects: ['publish'] };
  const requests = normalizeRequests([raw], 'dev');
  assert.deepEqual(requests[0].effects, ['publish']);
  assert.equal(requests[0].status, 'proposed');
  assert.equal(enqueueRequests(requests, requests).length, 1);
  assert.deepEqual(normalizeRequests([{ ...raw, criteria: [] }], 'dev'), []);
  assert.equal(taskProfile({ risk: 'invalid' }).risk, 'normal');
});
test('records are deterministic, omit raw data and distinguish simulated work', () => {
  const store = { listGoals: () => [{ id: 'goal', projectId: 'p1', status: 'scheduled', objective: 'PRIVATE PROMPT', completionCriteria: ['PRIVATE CRITERION'], evidence: [] }],
    listRuns: () => [{ id: 'run', team: 'dev', status: 'finished', outcome: 'completed', simulated: true, answer: 'SECRET ANSWER' }] };
  const record = projectRecord(store, 'p1');
  assert.equal(record.digest, projectRecord(store, 'p1').digest);
  assert.match(record.markdown, /SIMULATED \/ not verified/);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE|SECRET ANSWER/);
  assert.equal(record.externalSync, 'not_connected');
  assert.throws(() => projectRecord(store, 'missing'), /not found/);
});
