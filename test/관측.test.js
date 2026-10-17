import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { observe } from '../src/관측.js';

test('9차 6번: the 관측 page counts the last days from the engine\'s own records only', () => {
  const now = Date.parse('2026-10-18T12:00:00Z');
  const at = m => new Date(now - m * 60000).toISOString();
  const log = path.join(mkdtempSync(path.join(tmpdir(), 'hq-obs-')), 's.jsonl');
  writeFileSync(log, [{ at: at(5), decision: 'allow' }, { at: at(6), decision: 'deny' }, { at: at(7), decision: 'ask' }, { at: at(60 * 24 * 30), decision: 'deny' }].map(e => JSON.stringify(e)).join('\n'));
  const runs = {
    g1: [{ team: 'dev', status: 'finished', startedAt: at(30), finishedAt: at(28), actualModel: 'claude-sonnet-5-5' },
      { team: 'qa', status: 'finished', startedAt: at(20), finishedAt: at(20), actualModel: null, answer: '엔진 단독 검증 · 완료 조건 2개', claims: [] },
      { team: 'dev', status: 'interrupted', startedAt: at(10) },
      { team: 'qa', status: 'finished', startedAt: at(9), actualModel: 'x', tools: [{ id: 'tests', status: 'fail' }], claims: [] },
      { team: 'dev', status: 'finished', startedAt: at(60 * 24 * 30), actualModel: 'x' }],
    g2: [{ team: 'plan', status: 'finished', startedAt: at(3), simulated: true }],
  };
  const r = observe({ goals: [{ id: 'g1', projectId: 'p1', status: 'verified' }, { id: 'g2', projectId: 'p2', status: 'review_required' }],
    runsOf: id => runs[id], events: [{ type: 'goal.resumed_after_restart', at: at(9) }, { type: 'goal.evidence_stale', at: at(8) }, { type: 'workbench.used', at: at(28), calls: 3 },
      { type: 'publish.sent', at: at(2) }], sentinelLog: log, now });
  assert.deepEqual([r.steps, r.modelCalls, r.engineOnly], [4, 2, 1], 'old and simulated steps are left out');
  assert.deepEqual(r.teams.map(t => [t.name, t.steps, t.interrupted]), [['개발팀', 2, 1], ['검증팀', 2, 0]]);
  assert.equal(r.teams[0].avgMinutes, 2);
  assert.deepEqual(r.causes, [{ id: 'defect', label: '구현 결함', n: 1 }]);
  assert.deepEqual(r.recovery, { interrupted: 1, resumed: 1, heldForDaejang: 0 });
  assert.deepEqual([r.evidence.stale, r.workbench.calls, r.publish.sent], [1, 3, 1]);
  assert.deepEqual(r.sentinel, { allow: 1, deny: 1, ask: 1 }, 'a month-old line is outside the window');
  assert.deepEqual(r.projects, { total: 2, verified: 1, waitingForDaejang: 1, running: 0 });
});
