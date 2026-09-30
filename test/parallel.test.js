import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PersistentStore } from '../src/persistent-store.js';
import { GoalScheduler } from '../src/scheduler.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import { parallelOf, parsePlan } from '../src/teams.js';
import { decide } from '../src/sentinel.js';

const ws = () => mkdtempSync(path.join(tmpdir(), 'hq-par-'));
const lane = { team: 'research', task: '경쟁사 가격 조사', folder: 'research', criteria: ['research/prices.md에 3곳 가격이 있다'] };

test('the plan may name one independent lane; bad ones are dropped', () => {
  assert.deepEqual(parallelOf(lane), { team: 'research', task: '경쟁사 가격 조사', folder: 'research/', criteria: ['research/prices.md에 3곳 가격이 있다'] });
  assert.equal(parallelOf({ ...lane, team: 'qa' }), null, 'only work teams');
  assert.equal(parallelOf({ ...lane, folder: '../x' }), null);
  assert.equal(parallelOf({ ...lane, folder: 'a/b' }), null, 'one top-level folder');
  assert.equal(parallelOf({ ...lane, folder: 'attachments' }), null, 'never an engine folder');
  assert.equal(parallelOf({ ...lane, criteria: [] }), null, 'needs verifiable criteria');
  const plan = parsePlan('AGENT_HQ_PLAN ' + JSON.stringify({ next_task: '화면 만들기', team: 'design', parallel: lane }));
  assert.equal(plan.parallel.folder, 'research/');
});

function setup(respond, extra = {}) {
  const store = new PersistentStore({ dataDir: ws() });
  const calls = [];
  const scheduler = new GoalScheduler({ store, policy: DEFAULT_POLICY, ...extra,
    runner: { run: async (goal, run) => { calls.push({ goal: goal.id, team: run.team }); return respond(run.team, goal); } } });
  return { store, scheduler, calls };
}

test('a lane starts as its own goal with its folder, and runs beside its parent in the same project', async () => {
  let planned = false;
  const { store, scheduler } = setup((team) => team === 'plan' && !planned
    ? (planned = true, { outcome: 'completed', plan: { nextTask: '화면 만들기', team: 'design', reviews: [], parallel: parallelOf(lane) } })
    : { outcome: 'completed', plan: { nextTask: 'x', team: 'dev', reviews: [] }, evidence: [] });
  try {
    const parent = scheduler.addGoal({ projectId: 'p1', kind: 'team', autoRun: true, title: '가게 홈페이지', objective: '홈페이지', completionCriteria: ['index.html이 있다'] });
    await scheduler.runGoal(parent.id);
    const [child] = store.listGoals().filter(g => g.parentGoalId === parent.id);
    assert.deepEqual([child.lane, child.team.step, child.team.worker, child.completionCriteria], ['research/', 'research', 'research', lane.criteria]);
    assert.match(child.title, /가게 홈페이지 · 병렬 조사팀/);
    assert.match(child.messages.at(-1).text, /병렬 작업 시작 · 조사팀 · research\//);
    // both due now: one tick claims the parent's design step and the lane's research step together
    const now = Date.now();
    for (const g of [store.getGoal(parent.id), store.getGoal(child.id)]) scheduler.update(g, { nextRunAt: new Date(now - 1000).toISOString() });
    const a = scheduler.claim(parent.id, now), b = scheduler.claim(child.id, now);
    assert.ok(a && b, 'a lane and its parent may run at the same time');
    // no second lane while one is open
    assert.equal(scheduler.spawnLane(store.getGoal(parent.id), parallelOf(lane)), null);
  } finally { store.close(); }
});

test('two unrelated goals of one project still never run at once; parallel.enabled=false starts no lane', async () => {
  const { store, scheduler } = setup(() => ({ outcome: 'completed' }), { parallelOn: () => false });
  try {
    const a = scheduler.addGoal({ projectId: 'p1', kind: 'team', objective: 'a', completionCriteria: ['a'] });
    const b = scheduler.addGoal({ projectId: 'p1', kind: 'team', objective: 'b', completionCriteria: ['b'] });
    const now = Date.now();
    assert.ok(scheduler.claim(a.id, now));
    assert.equal(scheduler.claim(b.id, now), null);
    assert.equal(scheduler.spawnLane(store.getGoal(a.id), parallelOf(lane)), null);
  } finally { store.close(); }
});

test('folders are kept apart: a lane writes only in its folder, the parent stays out of it', () => {
  const cwd = ws();
  const write = (file, opts) => decide({ tool_name: 'Write', tool_input: { file_path: path.join(cwd, file), content: 'x' } }, { workspace: cwd, ...opts });
  assert.equal(write('research/prices.md', { lane: 'research/' }).decision, 'allow');
  assert.match(write('index.html', { lane: 'research/' }).reason, /자기 폴더\(research\/\)에만/);
  assert.match(write('research/prices.md', { laneDeny: ['research/'] }).reason, /병렬 작업의 폴더/);
  assert.equal(write('index.html', { laneDeny: ['research/'] }).decision, 'allow');
});

test('the main work waits for its lane: never finished while it runs, and plans again with the result when it is done', async () => {
  const { store, scheduler } = setup(() => ({ outcome: 'completed' }));
  try {
    const parent = scheduler.addGoal({ projectId: 'p1', kind: 'team', autoRun: true, title: '가게 홈페이지', objective: '홈페이지', completionCriteria: ['index.html이 있다'] });
    scheduler.update(store.getGoal(parent.id), { team: { ...store.getGoal(parent.id).team, step: 'qa', worker: 'design' } });
    const child = scheduler.spawnLane(store.getGoal(parent.id), parallelOf(lane));
    // every parent criterion proven at verification, but the lane still runs → wait, not finish
    const waiting = scheduler.decideTeam(store.getGoal(parent.id), { outcome: 'completed', findings: { feedback: '', improvements: [], blocking: [] } },
      [{ criterion: 'index.html이 있다', proof: 'ok' }], Date.now());
    assert.deepEqual([waiting.status, waiting.reason, waiting.team.step, waiting.team.waitingLane], ['scheduled', 'lane_wait', 'plan', child.id]);
    scheduler.update(store.getGoal(parent.id), waiting);
    assert.equal(scheduler.claim(parent.id, Date.now()), null, 'no step is spent while waiting');
    // planning can also ask to wait when its next task needs the lane's result
    const planWait = scheduler.decideTeam({ ...store.getGoal(parent.id), team: { ...store.getGoal(parent.id).team, step: 'plan' } },
      { outcome: 'completed', plan: { nextTask: '가격표 넣기', team: 'design', reviews: [], waitParallel: true } }, [], Date.now());
    assert.equal(planWait.reason, 'lane_wait');
    // the lane finishes → the parent learns where the result is and plans again right away
    scheduler.update(store.getGoal(child.id), { status: 'verified' });
    scheduler.laneFinished(store.getGoal(child.id));
    const after = store.getGoal(parent.id);
    assert.deepEqual([after.reason, after.team.step, after.team.waitingLane, after.team.laneResult.folder], [null, 'plan', null, 'research/']);
    assert.match(after.messages.at(-1).text, /병렬 작업 끝남 · 조사팀 · research\//);
    assert.ok(scheduler.claim(parent.id, Date.now() + 1000));
  } finally { store.close(); }
});

test('the plan prompt tells planning about a finished lane, and wait_parallel is read from the plan', async () => {
  const { teamPrompt } = await import('../src/teams.js');
  const text = teamPrompt('plan', { goal: { objective: 'x', completionCriteria: ['a'] }, team: { laneResult: { team: 'research', folder: 'research/', criteria: ['가격 3곳'] } }, files: [] });
  assert.match(text, /병렬 작업 끝남: 조사팀이 research\/ 에서 마침/);
  assert.equal(parsePlan('AGENT_HQ_PLAN ' + JSON.stringify({ next_task: 't', team: 'design', wait_parallel: true })).waitParallel, true);
});
