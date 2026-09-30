import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { matchPath, pathViolations, readRules, ruleFor, Rules, rulesPrompt } from '../src/rules.js';
import { decide } from '../src/sentinel.js';
import { PersistentStore } from '../src/persistent-store.js';
import { GoalScheduler } from '../src/scheduler.js';
import { DEFAULT_POLICY } from '../src/policy.js';

const ws = () => mkdtempSync(path.join(tmpdir(), 'hq-rules-'));
const rule = (kind, target, action, extra = {}) => ({ id: `${kind}-${target}-${action}`, kind, target, action, project: null, ...extra });

test('path patterns: folders, one-level and any-depth globs, exact files', () => {
  assert.equal(matchPath('secrets/', 'secrets/a.txt'), true);
  assert.equal(matchPath('secrets/', 'x/secrets/a.txt'), false);
  assert.equal(matchPath('*.env', '.env.local'), false);
  assert.equal(matchPath('*.pem', 'keys/server.pem'), true, 'a bare file pattern matches the file name at any depth');
  assert.equal(matchPath('docs/**/*.pdf', 'docs/a/b/c.pdf'), true);
  assert.equal(matchPath('docs/*.pdf', 'docs/a/c.pdf'), false);
  assert.equal(matchPath('index.html', 'index.html'), true);
  assert.equal(matchPath('build', 'build/app.js'), true);
});

test('the strongest rule wins (금지 > 승인 필요 > 허용), and a project rule applies only to its project', () => {
  const rules = [rule('site', 'example.com', 'allow'), rule('site', 'files.example.com', 'deny'), rule('site', 'news.com', 'ask', { project: 'p1' })];
  assert.equal(ruleFor(rules, { kind: 'site', target: 'files.example.com', project: 'p1' }).action, 'deny');
  assert.equal(ruleFor(rules, { kind: 'site', target: 'www.example.com', project: 'p1' }).action, 'allow');
  assert.equal(ruleFor(rules, { kind: 'site', target: 'news.com', project: 'p2' }), null);
});

test('the Sentinel applies 대장 rules after its fixed ones: sites, paths, connectors', () => {
  const cwd = ws();
  const rules = [rule('site', 'blocked.com', 'deny', { note: '회사 정책' }), rule('site', 'docs.dev', 'allow'), rule('site', 'careful.org', 'ask'),
    rule('path', 'secrets/', 'deny'), rule('path', 'release/', 'ask'), rule('connector', 'gmail', 'deny'), rule('connector', 'slack', 'allow')];
  const web = (url, opts = {}) => decide({ tool_name: 'WebFetch', tool_input: { url } }, { workspace: cwd, rules, project: 'p1', webMode: 'ask', ...opts });
  assert.deepEqual([web('https://blocked.com/a').decision, web('https://blocked.com/a').reason], ['deny', '대장 규칙으로 금지된 사이트 (회사 정책)']);
  assert.equal(web('https://docs.dev/x').decision, 'allow', 'allowed without asking even in ask mode');
  assert.equal(web('https://careful.org/x', { webMode: 'open' }).decision, 'ask', '승인 필요 asks even in open mode');
  assert.equal(web('https://careful.org/x', { grants: [{ kind: 'web', target: 'careful.org', project: 'p1' }] }).decision, 'allow');
  assert.equal(decide({ tool_name: 'WebFetch', tool_input: { url: 'https://localhost/x' } }, { rules: [rule('site', 'localhost', 'allow')] }).decision, 'deny', 'no rule opens an internal address');
  const write = (file) => decide({ tool_name: 'Write', tool_input: { file_path: path.join(cwd, file), content: 'x' } }, { workspace: cwd, rules, project: 'p1' });
  assert.equal(write('secrets/key.txt').decision, 'deny');
  const asked = write('release/notes.md');
  assert.deepEqual([asked.decision, asked.ask], ['ask', { kind: 'path', target: 'release/notes.md' }]);
  assert.equal(write('src/a.js').decision, 'allow');
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: path.join(cwd, '.claude', 'x'), content: 'x' } }, { workspace: cwd, rules: [rule('path', '.claude/', 'allow')] }).decision, 'deny', 'no rule opens a settings folder');
  const mcp = (tool) => decide({ tool_name: tool, tool_input: {} }, { workspace: cwd, rules, project: 'p1' });
  assert.equal(mcp('mcp__claude_ai_Gmail__search').decision, 'deny');
  assert.equal(mcp('mcp__claude_ai_Slack__send_message').decision, 'allow', '대장 allowed it although sending normally asks');
});

test('after a step, changed files under 금지 / 승인 필요 paths are reported (how Codex steps are caught)', () => {
  const rules = [rule('path', 'secrets/', 'deny'), rule('path', '*.pem', 'ask'), rule('path', 'docs/', 'allow')];
  assert.deepEqual(pathViolations(rules, 'p1', ['secrets/a.txt', 'keys/b.pem', 'docs/c.md', 'src/d.js']).map(v => [v.file, v.rule.action]), [['secrets/a.txt', 'deny'], ['keys/b.pem', 'ask']]);
  assert.match(rulesPrompt(rules, 'p1'), /금지 · 파일 경로 secrets\/[\s\S]*승인 필요 · 파일 경로 \*\.pem/);
  assert.equal(rulesPrompt([], 'p1'), '');
});

test('a step that broke a rule stops the project for 대장, who can answer or start again', async () => {
  const store = new PersistentStore({ dataDir: ws() });
  try {
    const scheduler = new GoalScheduler({ store, policy: DEFAULT_POLICY, runner: { run: async (goal, run) => run.team === 'plan'
      ? { outcome: 'completed', plan: { nextTask: '구현', team: 'dev', reviews: [] } }
      : { outcome: 'completed', evidence: [], ruleViolations: [{ file: 'secrets/a.txt', rule: { target: 'secrets/', action: 'deny', note: '' } }] } } });
    const g = scheduler.addGoal({ projectId: 'p1', kind: 'team', autoRun: true, objective: 'x', completionCriteria: ['a'] });
    await scheduler.runGoal(g.id); await scheduler.runGoal(g.id);
    const held = store.getGoal(g.id);
    assert.deepEqual([held.status, held.reason], ['review_required', 'rule_violation']);
    assert.match(held.question, /개발팀이 대장 규칙에 걸리는 파일을 바꿨습니다:\n- secrets\/a\.txt · 금지 규칙 “secrets\/”/);
    scheduler.answer(g.id, '그 파일은 지우고 다시 해');
    assert.equal(store.getGoal(g.id).status, 'scheduled');
  } finally { store.close(); }
});

test('rules are validated and stored in the file the Sentinel hook reads', () => {
  const file = path.join(ws(), 'rules.json');
  const rules = new Rules({ file });
  const r = rules.add({ kind: 'site', target: 'https://Example.com/path', action: 'deny', note: '테스트' });
  assert.equal(r.target, 'example.com');
  assert.deepEqual(readRules(file).map(x => x.target), ['example.com']);
  assert.throws(() => rules.add({ kind: 'site', target: 'not a host', action: 'deny' }), /host name/);
  assert.throws(() => rules.add({ kind: 'path', target: '../outside', action: 'deny' }), /inside the work folder/);
  assert.throws(() => rules.add({ kind: 'command', target: 'x', action: 'deny' }), /kind/);
  assert.throws(() => rules.add({ kind: 'path', target: 'a/', action: 'block' }), /action/);
  rules.remove(r.id);
  assert.deepEqual(readRules(file), []);
  writeFileSync(file, 'broken');
  assert.deepEqual(readRules(file), [], 'a broken file reads as no rules');
});

test('the real Sentinel hook process reads the rules file and blocks what 대장 forbade', async () => {
  const { spawnSync } = await import('node:child_process');
  const dir = ws(), cwd = ws();
  const file = path.join(dir, 'rules.json');
  new Rules({ file }).add({ kind: 'path', target: 'secrets/', action: 'deny' });
  const run = (target) => spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', 'sentinel-hook.mjs')], {
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(cwd, target), content: 'x' } }), encoding: 'utf8',
    env: { ...process.env, AGENT_HQ_WORKSPACE: cwd, AGENT_HQ_PROJECT: 'p1', AGENT_HQ_SENTINEL_RULES: file, AGENT_HQ_SENTINEL_LOG: path.join(dir, 'log.jsonl') } });
  const blocked = run('secrets/a.txt');
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /대장 규칙으로 금지된 경로/);
  assert.equal(run('src/a.js').status, 0);
});

test('the rules API adds, lists and removes rules', async () => {
  const { createApp } = await import('../src/app.js');
  const root = ws();
  const app = createApp({ root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects') });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  try {
    const added = await call('POST', '/api/rules', { kind: 'site', target: 'example.com', action: 'deny' });
    assert.equal(added.status, 201);
    assert.deepEqual((await call('GET', '/api/rules')).body.items.map(r => r.target), ['example.com']);
    assert.equal((await call('POST', '/api/rules', { kind: 'site', target: 'x.com', action: 'deny', project: 'nope' })).status >= 400, true, 'a project rule needs a real project');
    assert.equal((await call('DELETE', `/api/rules/${added.body.id}`)).status, 200);
    assert.deepEqual((await call('GET', '/api/rules')).body.items, []);
  } finally { await app.close(); }
});
