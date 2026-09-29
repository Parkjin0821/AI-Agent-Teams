import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { teamPrompt } from '../src/teams.js';

const root = path.resolve('.');
async function start(adapterRun) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'hq-inbox-'));
  const adapter = { enabled: true, run: adapterRun };
  const app = createApp({ root, dataDir, projectsDir: mkdtempSync(path.join(tmpdir(), 'hq-inbox-p-')), adapter });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  const call = async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  return { app, call, dataDir };
}
const answer = team => team === 'plan' ? 'AGENT_HQ_PLAN {"next_task":"경쟁 서비스 조사","team":"research","reviews":[]}' : 'AGENT_HQ_REPORT {"criteria":[]}';

test('a site the Sentinel held back pauses the project until 대장 picks a scope; the same step then runs again', async () => {
  const seen = [];
  const { app, call, dataDir } = await start(async (provider, prompt, onEvent, opts) => {
    const team = /^You are (\S+)/.exec(prompt)[1];
    seen.push([team, opts.sentinel?.webMode]);
    if (team === '조사팀' && seen.filter(s => s[0] === '조사팀').length === 1) {
      // what the real hook writes when it holds a site back
      appendFileSync(opts.sentinel.log, JSON.stringify({ at: new Date().toISOString(), project: opts.sentinel.project, team: 'research', tool: 'WebFetch',
        target: 'nodejs.org/api', decision: 'ask', reason: '처음 여는 사이트 · 대장 승인 필요', ask: { kind: 'web', target: 'nodejs.org' } }) + '\n');
    }
    return { outcome: 'completed', answer: answer(/^You are 기획팀/.test(prompt) ? 'plan' : 'x') };
  });
  try {
    app.store.setSetting('trust.required', 0);
    const g = (await call('POST', '/api/projects', { objective: '경쟁 가계부 앱 조사', completionCriteria: ['research/a.md 있음'] })).body;
    await app.scheduler.runGoal(g.id); // plan
    await app.scheduler.runGoal(g.id); // research: one site held back
    let goal = app.store.getGoal(g.id);
    assert.deepEqual([goal.status, goal.reason, goal.team.step], ['review_required', 'approval_required', 'research'], 'waits on the same step');
    assert.equal(seen[1][1], 'ask', 'web mode defaults to asking first');
    assert.match((await call('POST', `/api/goals/${g.id}/start`, {})).body.status ?? '', /review_required/, 'start does not skip the wait');
    assert.match((await call('POST', `/api/goals/${g.id}/resume`, {})).body.error, /approval inbox/);
    const inbox = (await call('GET', '/api/inbox')).body;
    assert.equal(inbox.approvals.length, 1);
    assert.deepEqual([inbox.approvals[0].kind, inbox.approvals[0].target], ['web', 'nodejs.org']);
    assert.deepEqual([inbox.approvals[0].task, inbox.approvals[0].examples, inbox.approvals[0].tool], ['경쟁 서비스 조사', ['nodejs.org/api'], 'WebFetch'],
      'the request says what the team was doing and which address it tried');
    assert.match((await call('POST', `/api/approvals/${inbox.approvals[0].id}/grant`, { scope: 'forever' })).body.error, /unknown approval scope/);
    assert.equal((await call('POST', `/api/approvals/${inbox.approvals[0].id}/grant`, { scope: 'project' })).status, 200);
    goal = app.store.getGoal(g.id);
    assert.deepEqual([goal.status, goal.reason, goal.team.step], ['scheduled', null, 'research'], 'released: research runs again');
    const grants = JSON.parse(readFileSync(path.join(dataDir, 'sentinel-grants.json'), 'utf8')).grants;
    assert.deepEqual(grants.map(x => [x.kind, x.target, x.scope, x.project]), [['web', 'nodejs.org', 'project', g.projectId]]);
    await app.scheduler.runGoal(g.id);
    assert.notEqual(app.store.getGoal(g.id).reason, 'approval_required', 'with the grant the round goes through');
  } finally { await app.close(); }
});

test('a refusal is noted for planning, and "once" grants are spent by the next round', async () => {
  let hold = true;
  const { app, call, dataDir } = await start(async (provider, prompt, onEvent, opts) => {
    if (/^You are 조사팀/.test(prompt) && hold) {
      hold = false;
      for (const t of ['a.example', 'b.example']) appendFileSync(opts.sentinel.log, JSON.stringify({ at: new Date().toISOString(), project: opts.sentinel.project,
        team: 'research', decision: 'ask', reason: 'r', ask: { kind: 'web', target: t } }) + '\n');
    }
    return { outcome: 'completed', answer: answer(/^You are 기획팀/.test(prompt) ? 'plan' : 'x') };
  });
  try {
    app.store.setSetting('trust.required', 0);
    const g = (await call('POST', '/api/projects', { objective: '조사', completionCriteria: ['c'] })).body;
    await app.scheduler.runGoal(g.id); await app.scheduler.runGoal(g.id);
    const [a, b] = (await call('GET', '/api/inbox')).body.approvals.sort((x, y) => x.target.localeCompare(y.target));
    await call('POST', `/api/approvals/${a.id}/grant`, { scope: 'once' });
    assert.equal(app.store.getGoal(g.id).reason, 'approval_required', 'still waits while one request is open');
    await call('POST', `/api/approvals/${b.id}/deny`, { note: '광고 사이트' });
    const goal = app.store.getGoal(g.id);
    assert.equal(goal.status, 'scheduled');
    assert.match(goal.team.feedback, /감시 에이전트 요청 거절: b\.example/);
    await app.scheduler.runGoal(g.id);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dataDir, 'sentinel-grants.json'), 'utf8')).grants, [], 'the once grant was spent');
  } finally { await app.close(); }
});

test('신뢰 쌓기: the first results of each kind of work wait for 대장; start cannot skip; accept counts, send back needs a reason', async () => {
  const { app, call } = await start(async (provider, prompt) => ({ outcome: 'completed', answer: /^You are 기획팀/.test(prompt)
    ? 'AGENT_HQ_PLAN {"next_task":"구현","team":"dev","reviews":[]}' : 'AGENT_HQ_REPORT {"criteria":[]}', }));
  try {
    app.store.setSetting('trust.required', 2);
    const g = (await call('POST', '/api/projects', { objective: '가계부', completionCriteria: ['c'] })).body;
    await app.scheduler.runGoal(g.id); await app.scheduler.runGoal(g.id); // plan, dev
    let goal = app.store.getGoal(g.id);
    assert.deepEqual([goal.reason, goal.trustReview, goal.team.step], ['trust_review', { team: 'dev', number: 1, required: 2 }, 'security']);
    await call('POST', `/api/goals/${g.id}/start`, {});
    assert.equal(app.store.getGoal(g.id).reason, 'trust_review', 'start does not skip the review');
    assert.equal((await call('GET', '/api/inbox')).body.reviews.length, 1);
    assert.match((await call('POST', `/api/goals/${g.id}/trust-review`, { accept: false })).body.error, /what to fix/);
    assert.equal((await call('POST', `/api/goals/${g.id}/trust-review`, { accept: true })).status, 200);
    goal = app.store.getGoal(g.id);
    assert.deepEqual([goal.status, goal.team.step, app.store.getSettings()['trust.count.dev']], ['scheduled', 'security', 1]);
    assert.match(goal.messages.at(-1).text, /개발팀 결과 확인 · 계속/);
    // a second project: one more review, then dev runs on its own
    const h = (await call('POST', '/api/projects', { objective: '두 번째', completionCriteria: ['c'] })).body;
    await app.scheduler.runGoal(h.id); await app.scheduler.runGoal(h.id);
    assert.equal(app.store.getGoal(h.id).reason, 'trust_review');
    await call('POST', `/api/goals/${h.id}/trust-review`, { accept: false, note: '테스트가 없음' });
    assert.deepEqual([app.store.getGoal(h.id).team.step, app.store.getGoal(h.id).team.feedback], ['plan', '[대장] 개발팀 결과를 되돌림: 테스트가 없음']);
    assert.equal(app.store.getSettings()['trust.count.dev'], 1, 'a send-back does not count');
    // "이 종류는 이제 맡기기": accepting with trustFully ends the reviews for that kind of work at once
    const k = (await call('POST', '/api/projects', { objective: '세 번째', completionCriteria: ['c'] })).body;
    await app.scheduler.runGoal(k.id); await app.scheduler.runGoal(k.id);
    assert.equal(app.store.getGoal(k.id).reason, 'trust_review');
    await call('POST', `/api/goals/${k.id}/trust-review`, { accept: true, trustFully: true });
    assert.equal(app.store.getSettings()['trust.count.dev'], 2);
    assert.match(app.store.getGoal(k.id).messages.at(-1).text, /이 종류는 이제 믿고 맡김/);
    const n = (await call('POST', '/api/projects', { objective: '네 번째', completionCriteria: ['c'] })).body;
    await app.scheduler.runGoal(n.id); await app.scheduler.runGoal(n.id);
    assert.notEqual(app.store.getGoal(n.id).reason, 'trust_review', 'dev now runs without a review');
  } finally { await app.close(); }
});

test('기억: 대장 adds, edits and forgets; team suggestions wait for approval; approved memory reaches the prompt', async () => {
  const prompts = [];
  const { app, call } = await start(async (provider, prompt) => {
    prompts.push(prompt);
    return { outcome: 'completed', answer: 'AGENT_HQ_PLAN {"next_task":"x","team":"dev","reviews":[],"remember":[{"scope":"all","text":"답은 짧게"},{"scope":"design","text":"남색 계열"}]}' };
  });
  try {
    const a = (await call('POST', '/api/memory', { text: 'GPT-5.6 계열은 쓰지 않는다' })).body;
    const b = (await call('POST', '/api/memory', { scope: 'design', text: '버튼은 둥글게' })).body;
    assert.match((await call('POST', '/api/memory', { scope: 'marketing', text: 'x' })).body.error, /unknown memory scope/);
    assert.equal((await call('PUT', `/api/memory/${b.id}`, { text: '버튼은 모서리 8px' })).body.text, '버튼은 모서리 8px');
    const g = (await call('POST', '/api/projects', { objective: '가계부', completionCriteria: ['c'] })).body;
    await app.scheduler.runGoal(g.id);
    assert.match(prompts[0], /\[대장 기억 · 대장이 승인한 것 · 모든 프로젝트에 적용\]\n- GPT-5\.6 계열은 쓰지 않는다/);
    assert.doesNotMatch(prompts[0], /모서리 8px/, 'design memory is not given to planning');
    const proposals = (await call('GET', '/api/inbox')).body.memoryProposals;
    assert.deepEqual(proposals.map(p => [p.scope, p.text, p.by]), [['all', '답은 짧게', '기획팀'], ['design', '남색 계열', '기획팀']]);
    assert.doesNotMatch(teamPrompt('plan', { goal: app.store.getGoal(g.id), team: {}, files: [], memory: app.store.getSettings()['memory.items'] && { common: [], team: [] } }), /답은 짧게/);
    await call('POST', `/api/memory/${proposals[0].id}/approve`, {});
    await call('DELETE', `/api/memory/${a.id}`, {});
    const items = (await call('GET', '/api/memory')).body.items;
    assert.deepEqual(items.filter(i => i.status === 'active').map(i => i.text), ['버튼은 모서리 8px', '답은 짧게']);
    await app.scheduler.runGoal(g.id).catch(() => {});
    assert.match((await call('POST', '/api/memory/reset', {})).body.error, /confirm/);
    await call('POST', '/api/memory/reset', { confirm: true });
    assert.deepEqual((await call('GET', '/api/memory')).body.items, []);
  } finally { await app.close(); }
});
