import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueueRequests, normalizeRequests, requiredReviews, taskProfile } from '../src/팀검토.js';
import { projectRecord } from '../src/작업기록.js';

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
  assert.doesNotMatch(JSON.stringify({ snapshot: record.snapshot, markdown: record.markdown, github: record.github }), /PRIVATE|SECRET ANSWER/);
  assert.doesNotMatch(record.notionMarkdown, /SECRET ANSWER/);
  assert.match(record.notionMarkdown, /PRIVATE PROMPT/);
  assert.equal(record.externalSync, 'not_connected');
  assert.throws(() => projectRecord(store, 'missing'), /not found/);
});

test('Notion details redact sensitive sentences and include engine summaries', () => {
  const goal = { id: 'g', projectId: 'p', title: '화면 개선', objective: '카드 정리\napi_key="supersecret123"', completionCriteria: ['검사 통과'], evidence: [] };
  const runs = [{ id: 'r', team: 'dev', status: 'finished', model: 'model', tools: [{ name: 'test', status: 'pass', summary: '3개 통과' }], answer: 'raw answer', plan: { nextTask: '화면 확인' } }];
  const store = { listGoals: () => [goal], listRuns: () => runs };
  const record = projectRecord(store, 'p');
  assert.match(record.notionMarkdown, /카드 정리/);
  assert.match(record.notionMarkdown, /3개 통과/);
  assert.match(record.notionMarkdown, /화면 확인/);
  assert.doesNotMatch(record.notionMarkdown, /supersecret123|raw answer/);
  runs[0].tools[0].summary = '4개 통과';
  assert.notEqual(record.notionDigest, projectRecord(store, 'p').notionDigest);
  assert.doesNotMatch(record.markdown, /카드 정리/);
});
