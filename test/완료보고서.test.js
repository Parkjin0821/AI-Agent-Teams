import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildReport, officialDate } from '../src/완료보고서.js';
import { createApp } from '../src/앱.js';

const goal = { id: 'g1', projectId: 'p1', kind: 'team', title: 'Python 최신 버전 조사', objective: '최신 버전을 확인한다 — 공식 사이트 기준',
  completionCriteria: ['research.md에 버전이 있다', '페이지가 읽기 쉽다'],
  evidence: [{ criterion: 'research.md에 버전이 있다', proof: '엔진 확인 · research.md의 “3.14.7”이(가) 원문(https://www.python.org/downloads/, 2026-09-30 저장)에도 있음' },
    { criterion: '페이지가 읽기 쉽다', proof: '대장 확인 · 직접 봄' }],
  messages: [{ role: 'user', kind: 'control', text: '오늘만 5단계 더' }, { role: 'user', text: '시작' }], createdAt: '2026-09-30T05:00:00.000Z' };
const runs = [
  { team: 'plan', executor: 'claude-code', actualModel: 'claude-sonnet-5-5', status: 'finished', startedAt: '2026-09-30T05:10:00.000Z' },
  { team: 'research', executor: 'claude-code', actualModel: 'claude-sonnet-5-5', status: 'finished', startedAt: '2026-09-30T05:11:00.000Z',
    sources: [{ path: 'sources/www.python.org-downloads.txt', url: 'https://www.python.org/downloads/', fetchedAt: '2026-09-30T05:12:00.000Z' }] },
  { team: 'qa', executor: 'claude-code', requestedModel: 'claude-sonnet-5-5', switchedFrom: 'codex', sameAsWorker: true, status: 'finished', startedAt: '2026-09-30T05:13:00.000Z' },
  { team: 'dev', executor: 'claude-code', simulated: true, status: 'finished', startedAt: '2026-09-30T04:00:00.000Z' },
  { team: 'policy', executor: 'claude-code', status: 'interrupted', startedAt: '2026-09-30T05:12:30.000Z' },
];

test('완료 보고서: criteria with proofs, steps per team, models, switches, originals and 대장 confirmations, from records only', () => {
  const r = buildReport({ goal, runs, files: ['research.md', 'sources/www.python.org-downloads.txt', 'reports/old.md', 'x.hwpx.svg'], now: '2026-09-30T06:00:00.000Z' });
  const md = r.markdown;
  assert.match(md, /^# Python 최신 버전 조사 완료 보고/);
  assert.match(md, /완료 조건 2개를 모두 확인했다 \(엔진 확인 1개, 대장 확인 1개\)/);
  assert.match(md, /- research\.md에 버전이 있다: 엔진 확인, research\.md의 “3\.14\.7”/);
  assert.match(md, /실행 단계: 총 3단계 \(기획팀 1, 조사팀 1, 검증팀 1\)/, 'simulated and interrupted steps are not counted');
  assert.match(md, /사용한 AI: Claude Code claude-sonnet-5-5 3단계/);
  assert.match(md, /한도 자동 전환: 1단계를 다른 AI가 대신함 \(그중 작업팀과 같은 AI의 검토 1단계\)/);
  assert.match(md, /## 결과물\n\n- research\.md\n/, 'engine folders and previews are left out of the output list');
  assert.match(md, /https:\/\/www\.python\.org\/downloads\/ \(2026\. 9\. 30\. 저장/);
  assert.match(md, /## 대장이 직접 확인한 조건\n\n- 페이지가 읽기 쉽다/);
  assert.doesNotMatch(md, /[—–―]|\d{4}-\d{2}-\d{2}/, '공문서 표기: no dashes, no ISO dates');
  assert.match(md, /기간: .*∼/);
  assert.match(r.md, /^reports\/완료보고서-\d{8}-\d{4}\.md$/);
  assert.equal(r.hwpx, r.md.replace(/\.md$/, '.hwpx'));
  assert.match(officialDate('2026-09-30T05:07:00.000Z'), /^2026\. 9\. 30\. \d{2}:\d{2}$/);
});

test('a finished project with real runs gets a report and a 한글 document; simulation-only projects do not', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-report-app-'));
  const made = [];
  const docConverter = { available: true, make: async (cwd, input) => { made.push(input); return { ok: true, path: input.to, validated: true, previews: [] }; } };
  const app = createApp({ root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), docConverter });
  try {
    const g = app.scheduler.addGoal({ projectId: 'p1', kind: 'team', objective: '조사', completionCriteria: ['a'] });
    app.store.insertRun({ id: 'r1', goalId: g.id, round: 1, attempt: 0, team: 'qa', executor: 'claude-code', status: 'finished', startedAt: new Date().toISOString() });
    app.scheduler.update(app.store.getGoal(g.id), { status: 'verified', evidence: [{ criterion: 'a', proof: '엔진 확인 · a' }] });
    await app.store.emit({ type: 'goal.verified', goalId: g.id });
    for (let i = 0; i < 20 && !made.length; i++) await new Promise(r => setTimeout(r, 25));
    assert.equal(made.length, 1);
    assert.equal(made[0].preset, '보고서');
    const md = path.join(root, 'projects', 'p1', made[0].from);
    assert.ok(existsSync(md));
    assert.match(readFileSync(md, 'utf8'), /완료 보고/);
    const ev = app.store.recentEvents(10).find(e => e.type === 'report.made');
    assert.equal(ev.hwpx, made[0].to);

    const sim = app.scheduler.addGoal({ projectId: 'p2', kind: 'team', objective: '모의', completionCriteria: ['b'] });
    app.store.insertRun({ id: 'r2', goalId: sim.id, round: 1, attempt: 0, team: 'qa', executor: 'claude-code', status: 'finished', simulated: true, startedAt: new Date().toISOString() });
    assert.equal(await app.makeReport(sim.id), null);
    app.store.setSetting('reports.auto', false);
    assert.equal(await app.makeReport(g.id), null, 'turned off');
  } finally { await app.close(); }
});
