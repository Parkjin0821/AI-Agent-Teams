import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/앱.js';
import { lastDue } from '../src/요약.js';

const local = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('scheduled times: daily at HH:MM, weekly on the chosen weekday (local time)', () => {
  // 2026-09-29 is a Tuesday
  assert.equal(lastDue('daily', { time: '09:00' }, local(2026, 9, 29, 10)), local(2026, 9, 29, 9));
  assert.equal(lastDue('daily', { time: '09:00' }, local(2026, 9, 29, 8)), local(2026, 9, 28, 9), 'before 9 the due one is yesterday');
  assert.equal(lastDue('weekly', { time: '09:00', weekday: 'mon' }, local(2026, 9, 29, 10)), local(2026, 9, 28, 9));
  assert.equal(lastDue('weekly', { time: '09:00', weekday: 'tue' }, local(2026, 9, 29, 8)), local(2026, 9, 22, 9));
  assert.equal(lastDue('weekly', { time: '09:00', weekday: 'off' }, local(2026, 9, 29, 10)), null);
});

test('the engine writes summaries from its own records, once per scheduled time, without calling a model', async () => {
  let now = local(2026, 9, 29, 8, 0);
  const clock = { now: () => now };
  const calls = [];
  const adapter = { enabled: true, run: async (provider, prompt) => {
    calls.push(prompt.slice(0, 20));
    return { outcome: 'completed', answer: /^You are 기획팀/.test(prompt)
      ? 'AGENT_HQ_PLAN {"next_task":"구현","team":"dev","reviews":[]}' : 'AGENT_HQ_REPORT {"criteria":[]}' };
  } };
  const app = createApp({ root: path.resolve('.'), dataDir: mkdtempSync(path.join(tmpdir(), 'hq-digest-')), projectsDir: mkdtempSync(path.join(tmpdir(), 'hq-digest-p-')), adapter, clock });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const call = async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  try {
    app.store.setSetting('permissions.mode', 'careful');
    app.store.setSetting('trust.required', 1);
    const g = (await call('POST', '/api/projects', { title: '가계부', objective: '가계부 앱', completionCriteria: ['c'] })).body;
    await app.scheduler.runGoal(g.id); await app.scheduler.runGoal(g.id); // plan, dev → waits for a result check
    const before = calls.length;

    // 08:00: yesterday's 09:00 was missed while nothing had been written yet → one daily now; Monday's weekly too;
    // and the 아침 요약 (08:00 by default) comes first
    assert.deepEqual(app.digests.tick().map(d => d.kind), ['morning', 'daily', 'weekly']);
    assert.deepEqual(app.digests.tick(), [], 'nothing twice for the same scheduled time');
    now = local(2026, 9, 29, 9, 1);
    const [daily] = app.digests.tick();
    assert.equal(daily.kind, 'daily');
    assert.match(daily.lines[0], /지난 24시간 동안 실제 단계 2번 \(완료 2 · 문제 0\) · 기획팀 1 · 개발팀 1/);
    assert.match(daily.lines.at(-1), /대장 결정 대기: 프로젝트 1개/);
    assert.deepEqual(daily.projects.map(p => [p.title, p.statusL, p.steps]), [['가계부', '결과 확인 필요 (신뢰 쌓기)', 2]]);
    assert.equal(calls.length, before, 'writing a summary never calls a model');

    // 대장 deletes it: it is gone, and the engine does not write the same scheduled summary again
    assert.equal((await call('DELETE', `/api/digests/${daily.id}`)).status, 200);
    assert.ok(!app.digests.list().some(d => d.id === daily.id));
    now = local(2026, 9, 29, 9, 5);
    assert.deepEqual(app.digests.tick(), [], 'a deleted scheduled summary is not recreated');
    assert.match((await call('DELETE', `/api/digests/${daily.id}`)).body.error, /digest not found/);

    app.store.setSetting('digest.daily', false);
    app.store.setSetting('digest.morning', false);
    now = local(2026, 9, 30, 9, 30);
    assert.deepEqual(app.digests.tick(), [], 'daily summaries can be switched off');

    const made = await call('POST', '/api/digests', { kind: 'weekly' });
    assert.equal(made.status, 201);
    assert.match(made.body.lines[0], /^지난 7일 동안/);
    assert.match((await call('POST', '/api/digests', { kind: 'monthly' })).body.error, /unknown digest kind/);
    const list = (await call('GET', '/api/digests')).body;
    assert.equal(list.items[0].id, made.body.id);
    assert.deepEqual(list.schedule, { time: '09:00', daily: false, weekly: 'mon', morning: false, morningTime: '08:00' });
    assert.match((await call('POST', '/api/digests/clear', {})).body.error, /confirm/);
    assert.equal((await call('POST', '/api/digests/clear', { confirm: true })).body.removed, list.items.length);
    assert.deepEqual((await call('GET', '/api/digests')).body.items, []);
  } finally { await app.close(); }
});

// 아침 요약 (2026-10-02): finished since the last summary with result files, what waits for 대장 (question in one line),
// what stopped and why (the engine's own wait reason), usage left with reset times, and a 자율 시험 that ended.
test('the morning summary lists finished work, decisions, stops, usage and a finished measurement, and is saved as Markdown', async () => {
  const { Digests } = await import('../src/요약.js');
  const { readFileSync, readdirSync, writeFileSync, mkdirSync } = await import('node:fs');
  const settings = { 'digest.daily': false, 'digest.weekly': 'off' };
  const at = (h, mi = 0) => new Date(2026, 9, 2, h, mi).toISOString();
  const goals = [
    { id: 'g1', projectId: 'p1', title: '회의록 한글 문서', status: 'verified', updatedAt: at(2), completionCriteria: ['a', 'b'], evidence: [{}, {}] },
    { id: 'g0', projectId: 'p0', title: '어제 끝난 일', status: 'verified', updatedAt: new Date(2026, 8, 30, 10).toISOString(), completionCriteria: ['a'], evidence: [{}] },
    { id: 'g2', projectId: 'p2', title: '빵집 페이지', status: 'review_required', reason: 'needs_decision', completionCriteria: ['a'], evidence: [],
      question: '[검증팀] 남은 조건은\n대장 판단이 필요합니다: 영업 중 표시' },
    { id: 'g3', projectId: 'p3', title: '조사', status: 'review_required', reason: 'criteria_approval_required', criteriaApprovalPending: true, completionCriteria: ['a', 'b', 'c'], evidence: [] },
    { id: 'g4', projectId: 'p4', title: '발표 자료', status: 'scheduled', reason: 'daily_cap', autoRun: true, completionCriteria: ['a'], evidence: [] },
    { id: 'g5', projectId: 'p5', title: '가계부', status: 'model_wait', reason: 'usage_unavailable_or_limited', autoRun: true, completionCriteria: ['a'], evidence: [] },
    { id: 'g6', projectId: 'p6', title: '로그인 오류', status: 'blocked', reason: 'auth_error', completionCriteria: ['a'], evidence: [] },
    { id: 'g7', projectId: 'p1', title: '병렬', lane: 'a/', status: 'blocked', reason: 'auth_error', completionCriteria: ['a'], evidence: [] },
  ];
  const runs = { g1: [
    { team: 'dev', checkpoint: { added: ['회의록.md', '.hq-screens/x.png', '회의록.hwpx.md', 'attachments/원고.txt'], modified: [] } },
    { team: 'dev', documents: [{ path: '회의록.hwpx' }], checkpoint: { added: ['회의록.hwpx', '회의록.hwpx.svg'], modified: ['회의록.md'] } },
    { team: 'qa', checkpoint: { added: ['검증.md'] } }] };
  const store = { listGoals: () => goals, listRuns: id => runs[id] ?? [], getSettings: () => settings,
    setSetting: (k, v) => { settings[k] = v; return settings; }, emit: async () => {} };
  const root = mkdtempSync(path.join(tmpdir(), 'hq-morning-'));
  const measureDir = path.join(root, '자율시험'), saveDir = path.join(root, '요약');
  mkdirSync(measureDir);
  writeFileSync(path.join(measureDir, '2026-10-02T00-25-32-407Z.json'), JSON.stringify({ startedAt: at(0, 25), endedAt: at(3, 10), items: [
    { kind: '웹페이지', status: 'review_required', reason: 'needs_decision', met: 9, total: 11, interventions: [{ final: true }] },
    { kind: '코드', status: 'verified', met: 7, total: 7, interventions: [] },
    { kind: '조사', status: 'review_required', reason: 'needs_decision', met: 4, total: 8, interventions: [{ final: false }] }] }));
  writeFileSync(path.join(measureDir, 'claude-usage.json'), '{}');
  const quota = { items: [
    { provider: 'claude', windows: [{ period: 'five_hour', remaining: 62, resetAt: new Date(2026, 9, 2, 13, 40).toISOString() }, { period: 'weekly', remaining: 86, resetAt: new Date(2026, 9, 8, 21, 0).toISOString() }] },
    { provider: 'codex', windows: [{ period: 'five_hour', remaining: 15, blocked: true, resetAt: new Date(2026, 9, 2, 14, 3).toISOString() }] }] };
  const approvals = { pending: () => [{ kind: 'web', target: 'https://example.org/menu', team: 'research', project: 'p2' }] };
  const now = new Date(2026, 9, 2, 8, 0).getTime();
  settings['digest.last.morning'] = new Date(2026, 9, 1, 8, 0).toISOString();
  const d = new Digests({ store, approvals, clock: { now: () => now }, setting: (k, f) => settings[k] ?? f, usage: () => quota,
    waitWhy: g => (g.id === 'g5' ? 'Codex · 5시간 남은 양 15% (중단 기준 20%)' : null), measureDir, saveDir });

  const [m] = d.tick(now);
  assert.equal(m.kind, 'morning');
  assert.equal(m.title, '아침 요약');
  assert.equal(m.lines[0], '완료 1개 · 대장 결정 대기 3건 · 멈춤 3개');
  assert.match(m.lines[1], /^먼저 볼 것: 빵집 페이지 · 팀 질문에 답 필요/);
  const sec = id => m.sections.find(s => s.id === id).lines;
  assert.deepEqual(sec('finished'), ['회의록 한글 문서 · 조건 2/2 · 결과 회의록.hwpx, 회의록.md'], 'engine files, previews, read-backs, attachments and verifier notes left out; yesterday\'s work not repeated');
  assert.deepEqual(sec('waiting'), [
    '빵집 페이지 · 팀 질문에 답 필요 · [검증팀] 남은 조건은 대장 판단이 필요합니다: 영업 중 표시',
    '조사 · 완료 조건 승인 필요 · 완료 조건 3개를 확인하고 승인',
    '감시 에이전트 승인 · 빵집 페이지 · 조사팀 · 사이트 https://example.org/menu']);
  assert.deepEqual(sec('stopped'), ['발표 자료 · 오늘 단계 한도 도달 · 자정 뒤 이어서',
    '가계부 · 모델 대기 · Codex · 5시간 남은 양 15% (중단 기준 20%)', '로그인 오류 · 멈춤 · 로그인 필요 (CLI 인증 오류)'], 'a parallel lane is part of its project');
  assert.deepEqual(sec('usage'), ['Claude · 5시간 62% 남음 (13:40 초기화) · 주간 86% 남음 (10. 8. 21:00 초기화)', 'Codex · 5시간 15% 남음 (14:03 초기화) · 중단 기준 아래']);
  assert.equal(sec('measure')[0], '자율 완료 2/3 (09:25 시작 · 12:10 끝)'.replace('09:25', localHM(at(0, 25))).replace('12:10', localHM(at(3, 10))));
  assert.match(sec('measure')[3], /^조사 · 대장 결정 대기 \(팀 질문에 답 필요\) · 조건 4\/8 · 대장 개입 1번$/);
  assert.ok(m.lines.includes(sec('measure')[0]));

  // saved as Markdown, and not written twice for the same morning
  assert.equal(m.file, '2026-10-02-0800-아침요약.md');
  const md = readFileSync(path.join(saveDir, m.file), 'utf8');
  assert.match(md, /^# 아침 요약 · 10\. 2\. 08:00/);
  assert.match(md, /## 대장을 기다리는 일\n\n- 빵집 페이지/);
  assert.deepEqual(d.tick(now + 60_000), []);
  assert.deepEqual(readdirSync(saveDir), [m.file]);

  // the next morning counts only what happened since this one; the old measurement is not repeated
  const next = d.build('morning', now + 24 * 3600_000);
  assert.deepEqual(next.sections.find(s => s.id === 'finished').lines, ['지난 요약 뒤로 끝난 프로젝트는 없습니다.']);
  assert.equal(next.sections.some(s => s.id === 'measure'), false);
  // 대장's own summary time wins over the 08:00 default; turning it off stops it
  settings['digest.time'] = '07:30';
  assert.equal(d.schedule().morningTime, '07:30');
  settings['digest.morning'] = false;
  assert.deepEqual(d.tick(now + 24 * 3600_000), []);
});
const localHM = iso => { const x = new Date(iso); return `${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`; };
