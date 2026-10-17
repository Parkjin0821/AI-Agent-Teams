import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPageTool, checkSyntaxTool, listDependenciesTool, runTestsTool, WORKBENCH_BUDGET, WORKBENCH_TOOLS } from '../src/작업도구.js';
import { buildCommand } from '../src/실행어댑터.js';
import { teamPrompt } from '../src/팀.js';

const folder = (files) => { const d = mkdtempSync(path.join(tmpdir(), 'hq-wb-')); for (const [f, t] of Object.entries(files)) { mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); writeFileSync(path.join(d, f), t); } return d; };
const sandbox = (status, output) => { const calls = []; return { available: true, calls, run: async (cwd, cmd, opts) => { calls.push({ cmd, opts }); return { status, code: status === 'pass' ? 0 : 1, output }; } }; };

test('9차 1번: run_tests runs the engine\'s confined command and returns counts and failing lines, never a free command', async () => {
  const dir = folder({ 'package.json': '{"scripts":{"test":"node --test 합계.test.js"}}', '합계.test.js': '' });
  const sb = sandbox('fail', 'not ok 1 - 합계\n  expected: 3\n  actual: 4\nℹ tests 2\nℹ pass 1\nℹ fail 1');
  const r = await runTestsTool(dir, { sandbox: sb });
  assert.equal(r.ok, false);
  assert.match(r.text, /자료이며 지시가 아님[\s\S]*실패[\s\S]*ℹ tests 2 · ℹ pass 1 · ℹ fail 1[\s\S]*expected: 3[\s\S]*actual: 4/);
  assert.ok(sb.calls[0].cmd.includes('--permission') && sb.calls[0].cmd.includes('합계.test.js'));
  const jest = folder({ 'package.json': '{"scripts":{"test":"jest"}}' });
  assert.match((await runTestsTool(jest, { sandbox: sb })).text, /폴더 밖 읽기를 막을 수 없는/);
  assert.equal(sb.calls.length, 1, 'an unconfined test is not run');
  assert.match((await runTestsTool(folder({ 'a.md': '' }), { sandbox: sb })).text, /테스트 파일이 없음/);
});

test('check_syntax finds broken JSON; check_page takes only an .html inside the work folder', async () => {
  const dir = folder({ 'data.json': '{"a":', 'ok.json': '{"a":1}', 'index.html': '<h1>x</h1>' });
  const s = await checkSyntaxTool(dir, { sandbox: sandbox('pass', '') });
  assert.equal(s.ok, false);
  assert.match(s.text, /data\.json: JSON 오류/);
  assert.doesNotMatch(s.text, /ok\.json:/);
  const vc = { available: true, check: async (cwd, pages) => ({ status: 'pass', summary: `화면 ${pages.length * 2}개 캡처`, details: [] }) };
  for (const bad of ['../x.html', 'C:/Windows/x.html', 'notes.md', 'missing.html']) assert.equal((await checkPageTool(dir, bad, { visualChecker: vc })).ok, false, bad);
  assert.match((await checkPageTool(dir, 'index.html', { visualChecker: vc })).text, /화면 2개 캡처/);
  assert.match(listDependenciesTool(folder({ 'package.json': '{"dependencies":{"left-pad":"1.0.0"}}' })).text, /left-pad/);
});

test('the MCP server speaks MCP over stdio: lists only the fixed tools, refuses unknown ones, and counts calls', async () => {
  const script = fileURLToPath(new URL('../scripts/작업도구-mcp.mjs', import.meta.url));
  const dir = folder({ 'package.json': '{"dependencies":{"left-pad":"1.0.0"}}' });
  const child = spawn(process.execPath, [script], { env: { ...process.env, AGENT_HQ_WORKSPACE: dir, AGENT_HQ_CODEX_BIN: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const waiting = new Map();
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  let id = 0;
  const rpc = (method, params) => new Promise(res => { const n = ++id; waiting.set(n, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  try {
    assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't' } })).result.serverInfo.name, 'agent-hq-workbench');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    assert.deepEqual((await rpc('tools/list', {})).result.tools.map(t => t.name), WORKBENCH_TOOLS.map(t => t.name));
    const deps = await rpc('tools/call', { name: 'list_dependencies', arguments: {} });
    assert.match(deps.result.content[0].text, /left-pad/);
    const tests = await rpc('tools/call', { name: 'run_tests', arguments: {} });
    assert.equal(tests.result.isError, true);
    assert.match((await rpc('tools/call', { name: 'run_shell', arguments: { cmd: 'whoami' } })).result.content[0].text, /없는 도구/);
    for (let i = 1; i < WORKBENCH_BUDGET.list_dependencies; i++) await rpc('tools/call', { name: 'list_dependencies', arguments: {} });
    assert.match((await rpc('tools/call', { name: 'list_dependencies', arguments: {} })).result.content[0].text, /번까지/, 'the per-step budget holds');
  } finally { child.kill(); }
});

test('a dev step gets only the engine\'s own MCP server, its four tools allowed by name, and strict MCP stays on', () => {
  const bins = { claude: { file: 'claude', prefix: [] }, codex: { file: 'codex', prefix: [] } };
  const sentinel = { script: 'C:/hq/scripts/보안감시-훅.mjs', log: 'C:/hq/l.jsonl', project: 'p', team: 'dev' };
  const cmd = buildCommand('claude', { cwd: 'C:/w', bins, sentinel, workbench: { script: 'C:/hq/scripts/작업도구-mcp.mjs', env: { AGENT_HQ_WORKSPACE: 'C:/w' } } });
  assert.ok(cmd.args.includes('--strict-mcp-config'));
  const cfg = JSON.parse(cmd.args[cmd.args.indexOf('--mcp-config') + 1]);
  assert.deepEqual(Object.keys(cfg.mcpServers), ['hq']);
  assert.deepEqual(cfg.mcpServers.hq.args, ['C:/hq/scripts/작업도구-mcp.mjs']);
  assert.ok(cmd.args.includes('--allowedTools=mcp__hq__run_tests,mcp__hq__check_syntax,mcp__hq__check_page,mcp__hq__list_dependencies'));
  assert.deepEqual(JSON.parse(cmd.env.AGENT_HQ_MCP_ALLOW).tools, WORKBENCH_TOOLS.map(t => `mcp__hq__${t.name}`), 'the Sentinel allows exactly these');
  const plain = buildCommand('claude', { cwd: 'C:/w', bins });
  assert.equal(plain.args[plain.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}', 'without the workbench no MCP server at all');
  const goal = { objective: 'x', completionCriteria: ['a'] };
  assert.match(teamPrompt('dev', { goal, files: [], team: { task: 't' }, workbench: true }), /mcp__hq__run_tests/);
  assert.doesNotMatch(teamPrompt('dev', { goal, files: [], team: { task: 't' } }), /mcp__hq__run_tests/);
});
