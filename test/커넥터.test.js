import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConnectorGate, judgeTrial, READ_ONLY_CONNECTORS, readProbe, reviewTools } from '../src/커넥터.js';
import { connectorPlugins, parseMcpServers, parsePluginList } from '../src/연결환경.js';
import { decide } from '../src/보안감시.js';
import { createApp } from '../src/앱.js';

const N = t => `mcp__claude_ai_Notion__${t}`;
const NOTION_TOOLS = ['notion-search', 'notion-fetch', 'notion-create-pages', 'notion-update-page', 'notion-create-comment', 'notion-move-pages'].map(N);
const spec = READ_ONLY_CONNECTORS.notion;
const memStore = () => { const s = {}; return { getSettings: () => s, setSetting: (k, v) => { s[k] = v; return s; } }; };
const snapshot = { connectors: [{ name: 'Notion', status: 'connected' }, { name: 'Gmail', status: 'connected' }] };
// A probe that answers like the real runs did (2026-10-11): discovery lists 49 tools, the trial sees only the read tools.
const fakeProbe = (over = {}) => ({
  discover: async () => ({ tools: ['Read', ...NOTION_TOOLS, 'mcp__claude_ai_Gmail__send'], calls: [], denials: [] }),
  trial: async ({ allow }) => ({ tools: ['Read', ...allow], calls: [{ name: allow[0], error: false }], denials: [], sentinelLog: [{ tool: allow[0], decision: 'allow' }] }),
  ...over,
});

test('the review opens exactly the search and read tools and blocks every other tool of the connector', () => {
  const r = reviewTools(spec, [...NOTION_TOOLS, 'mcp__claude_ai_Gmail__send']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.allow, [N('notion-search'), N('notion-fetch')]);
  assert.deepEqual(r.deny, ['notion-create-pages', 'notion-update-page', 'notion-create-comment', 'notion-move-pages'].map(N), 'other connectors are not listed here');
  const missing = reviewTools(spec, [N('notion-create-pages')]);
  assert.equal(missing.ok, false, 'no read tool, nothing to open');
});

test('the isolated trial passes only when the read tools worked and no write tool was even offered', () => {
  const review = reviewTools(spec, NOTION_TOOLS);
  const good = { tools: review.allow, calls: [{ name: N('notion-search'), error: false }], denials: [] };
  assert.equal(judgeTrial(spec, review, good).ok, true);
  assert.equal(judgeTrial(spec, review, { ...good, tools: [...review.allow, N('notion-update-page')] }).ok, false, 'a write tool visible to the team fails');
  assert.equal(judgeTrial(spec, review, { ...good, calls: [{ name: N('notion-search'), error: true }] }).ok, false, 'a failed search fails');
  assert.equal(judgeTrial(spec, review, { ...good, calls: [] }).ok, false, 'no search fails');
  assert.equal(judgeTrial(spec, review, { ...good, denials: [N('notion-search')] }).ok, false);
});

test('the probe reads offered tools, calls and their errors from the Claude Code event stream', () => {
  const lines = [
    { type: 'system', subtype: 'init', tools: ['Read', N('notion-search')], mcp_servers: [{ name: 'claude.ai Notion', status: 'connected' }] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: N('notion-search'), input: { query: 'x' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'secret page text' }] } },
    { type: 'result', is_error: false, permission_denials: [] },
  ].map(e => JSON.stringify(e)).join('\n');
  const p = readProbe(lines);
  assert.deepEqual(p.calls, [{ name: N('notion-search'), error: false }]);
  assert.deepEqual(p.tools, ['Read', N('notion-search')]);
  assert.ok(!JSON.stringify(p).includes('secret page text'), 'what the run read is not kept');
});

test('발견 → 검토 → 격리 시험 → 승인 → 팀별 켜기; nothing reaches a team before 대장 approves and turns it on', async () => {
  const store = memStore();
  const gate = new ConnectorGate({ store, probe: fakeProbe(), snapshot: () => snapshot, plugins: () => ['design@synced'] });
  assert.deepEqual(gate.readOnlyFor('research'), []);
  assert.throws(() => gate.canTurnOn('connectors.notion.research'), /승인되지 않았습니다/);
  const state = await gate.check('notion');
  assert.deepEqual(state.history.map(h => h.stage), ['discovered', 'reviewed', 'tested']);
  assert.equal(gate.requests().length, 1, 'the request waits in 승인함');
  assert.deepEqual(gate.readOnlyFor('research'), [], 'a tested connector is not connected yet');
  assert.throws(() => gate.approve('notion', {}), /approval/);
  assert.equal(gate.approve('notion', { confirm: true }).stage, 'connected');
  assert.deepEqual(gate.readOnlyFor('research'), [], 'connected but not turned on for the team');
  assert.equal(gate.canTurnOn('connectors.notion.research'), true);
  assert.throws(() => gate.canTurnOn('connectors.notion.dev'), /cannot use/);
  store.setSetting('connectors.notion.research', true);
  assert.deepEqual(gate.readOnlyFor('research'), [{ name: 'Notion', label: 'Notion', allow: [N('notion-search'), N('notion-fetch')],
    deny: ['notion-create-pages', 'notion-update-page', 'notion-create-comment', 'notion-move-pages'].map(N) }]);
  assert.deepEqual(gate.readOnlyFor('plan'), []);
  assert.deepEqual(gate.readOnlyFor('dev'), []);
  gate.revoke('notion');
  assert.equal(store.getSettings()['connectors.notion.research'], false, 'revoking turns the teams off');
  assert.deepEqual(gate.readOnlyFor('research'), []);
});

test('a connector check stops early: not connected, plugin list unknown, failed trial', async () => {
  const off = new ConnectorGate({ store: memStore(), probe: fakeProbe(), snapshot: () => ({ connectors: [{ name: 'Notion', status: 'needs-auth' }] }), plugins: () => [] });
  await assert.rejects(off.check('notion'), /not connected/);
  const noPlugins = new ConnectorGate({ store: memStore(), probe: fakeProbe(), snapshot: () => snapshot, plugins: () => null });
  await assert.rejects(noPlugins.check('notion'), /plugin list/);
  const leaky = new ConnectorGate({ store: memStore(), snapshot: () => snapshot, plugins: () => [],
    probe: fakeProbe({ trial: async ({ allow }) => ({ tools: [...allow, N('notion-update-page')], calls: [{ name: allow[0], error: false }], denials: [] }) }) });
  const failed = await leaky.check('notion');
  assert.equal(failed.stage, 'failed');
  assert.match(failed.history.at(-1).reason, /막아야 할 도구가 보임/);
  assert.equal(leaky.requests().length, 0, 'a failed trial never reaches 승인함');
  assert.throws(() => leaky.approve('notion', { confirm: true }), /isolated trial/);
});

test('the Sentinel denies every MCP tool the step was not given, including Notion writes', () => {
  const mcpAllow = { prefixes: [], tools: [N('notion-search'), N('notion-fetch')] };
  const call = (tool, opts = { mcpAllow }) => decide({ tool_name: tool, tool_input: {} }, { workspace: 'C:/w', ...opts }).decision;
  assert.equal(call(N('notion-search')), 'allow');
  assert.equal(call(N('notion-create-pages')), 'deny');
  assert.equal(call(N('notion-update-page')), 'deny');
  assert.equal(call('mcp__claude_ai_Gmail__search'), 'deny');
  assert.equal(call('mcp__claude_ai_Figma__get_file', { mcpAllow: { prefixes: ['mcp__claude_ai_Figma'], tools: [] } }), 'allow', 'a whole design connector');
  assert.equal(call(N('notion-search'), { mcpAllow: { prefixes: [], tools: [] } }), 'deny', 'no connector opened, no MCP tool');
});

test('the MCP and plugin listings decide whether a connector run may start at all', () => {
  const mcp = ['Checking MCP server health…', '', 'claude.ai Notion: https://mcp.notion.com/mcp - √ Connected',
    'plugin:design:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication',
    'plugin:desktop-commander:desktop-commander: npx -y @wonderwhy-er/desktop-commander@latest - √ Connected'].join('\n');
  assert.deepEqual(parseMcpServers(mcp), { plugins: ['design', 'desktop-commander'], others: [] });
  assert.deepEqual(parseMcpServers('mine: node server.js - ✓ Connected').others, ['mine']);
  assert.deepEqual(parsePluginList('Synced from claude.ai:\n\n  > design@synced\n    Version: 1.2.0\n  > desktop-commander@synced\n'), ['design@synced', 'desktop-commander@synced']);
  assert.equal(parsePluginList('', -1), null);
  // 2026-10-18: after a Claude Code update the marker became "❯"; the list was unreadable and the Notion relay refused.
  assert.deepEqual(parsePluginList('Synced from claude.ai:\n\n  ❯ codex-dispatch@synced\n    Status: ✔ loaded\n\n  ❯ pdf-viewer@synced\n'), ['codex-dispatch@synced', 'pdf-viewer@synced']);
  assert.equal(parsePluginList('garbage'), null);
  const servers = parseMcpServers(mcp);
  assert.deepEqual(connectorPlugins({ plugins: ['design@synced', 'desktop-commander@synced'], mcpServers: servers }), ['design@synced', 'desktop-commander@synced']);
  assert.equal(connectorPlugins({ plugins: ['design@synced'], mcpServers: servers }), null, 'a plugin server not on the list could start');
  assert.equal(connectorPlugins({ plugins: [], mcpServers: { plugins: [], others: ['mine'] } }), null, 'a local MCP server would start');
  assert.equal(connectorPlugins({ plugins: null, mcpServers: servers }), null);
});

test('the dashboard API runs the check, puts it in 승인함, and a reading team gets only the read tools after it is turned on', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-conn-'));
  const seen = [];
  const adapter = { enabled: true, run: async (provider, prompt, onEvent, opts) => {
    seen.push({ who: /^You are (\S+)/.exec(prompt)?.[1], readOnly: opts.readOnly, plugins: opts.plugins, prompt });
    return { outcome: 'completed', answer: 'AGENT_HQ_PLAN {"next_task":"Notion 페이지 요약","team":"research","reviews":[]}' };
  } };
  const monitor = { snapshot: { ...snapshot, plugins: ['design@synced'], mcpServers: { plugins: ['design'], others: [] } }, refresh: async () => monitor.snapshot };
  const app = createApp({ root, dataDir: path.join(root, 'data'), projectsDir: path.join(root, 'projects'), adapter, monitor, connectorProbe: fakeProbe() });
  t.after(() => app.close());
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => { const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  assert.equal((await call('PUT', '/api/settings', { key: 'connectors.notion.research', value: true })).status, 400, 'not before approval');
  assert.equal((await call('POST', '/api/connectors/notion/check', {})).body.stage, 'tested');
  assert.equal((await call('GET', '/api/inbox')).body.connectorRequests.length, 1);
  assert.equal((await call('POST', '/api/connectors/notion/approve', { confirm: true })).body.stage, 'connected');
  assert.equal((await call('GET', '/api/inbox')).body.connectorRequests.length, 0);
  assert.equal((await call('PUT', '/api/settings', { key: 'connectors.notion.research', value: true })).status, 200);
  assert.equal((await call('GET', '/api/connectors')).body.items[0].teams.find(x => x.team === 'research').on, true);
  const { body: g } = await call('POST', '/api/projects', { objective: 'Notion 페이지 요약', completionCriteria: ['research/요약.md 파일이 있다'] });
  await call('POST', `/api/goals/${g.id}/run`, {});
  await call('POST', `/api/goals/${g.id}/run`, {});
  assert.deepEqual(seen.map(s => [s.who, (s.readOnly ?? []).map(r => r.allow.length)]), [['기획팀', []], ['조사팀', [2]]], 'planning stays off until turned on');
  assert.deepEqual(seen[1].plugins, ['design@synced']);
  assert.match(seen[1].prompt, /읽기 전용 도구: Notion: notion-search, notion-fetch/);
});
