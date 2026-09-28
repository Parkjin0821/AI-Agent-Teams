import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCommand, childEnv, classifyFailure, CliAgentAdapter, finalAnswer, reportedModel } from '../src/adapters.js';

test('child CLIs do not inherit a hosting Claude session (its tokens or endpoints)', () => {
  const env = childEnv({ PATH: 'p', HOME: 'h', APPDATA: 'a', CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'desktop',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret', CLAUDE_AGENT_SDK_VERSION: 'x', CLAUDE_PID: '1', CLAUDE_EFFORT: 'low',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', OPENAI_API_KEY: 'kept-for-user' });
  assert.deepEqual(Object.keys(env).sort(), ['APPDATA', 'HOME', 'OPENAI_API_KEY', 'PATH']);
  assert.equal(childEnv({ ANTHROPIC_BASE_URL: 'https://proxy.example' }).ANTHROPIC_BASE_URL, 'https://proxy.example',
    'a base URL the user set themselves (no hosting session) is kept');
});

const bins = { claude: { file: 'claude.exe', prefix: [] }, codex: { file: 'codex.exe', prefix: [] } };

test('claude runs non-interactively, edits only inside the workspace, without shell tools or any MCP', () => {
  const cmd = buildCommand('claude', { cwd: 'C:/w', model: null, bins });
  assert.equal(cmd.file, 'claude.exe');
  assert.deepEqual(cmd.args, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
    '--tools=Read,Write,Edit', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']);
  assert.equal(cmd.env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false', 'claude.ai connectors (mail, drive, …) are off by default');
  assert.equal(cmd.cwd, 'C:/w');
  assert.deepEqual(buildCommand('claude', { cwd: 'C:/w', model: 'sonnet', bins }).args.slice(-2), ['--model', 'sonnet']);
});

test('web access adds only the built-in web search and fetch tools', () => {
  const args = buildCommand('claude', { cwd: 'C:/w', bins, web: true }).args;
  assert.ok(args.includes('--tools=Read,Write,Edit,WebSearch,WebFetch'));
});

test('selected claude.ai connectors are allowed by name and every other connector is denied', () => {
  const cmd = buildCommand('claude', { cwd: 'C:/w', bins, connectors: ['Figma', 'Canva'], knownConnectors: ['Figma', 'Canva', 'Gmail', 'Google Drive', 'AWS MCP'] });
  assert.equal(cmd.env.ENABLE_CLAUDEAI_MCP_SERVERS, undefined, 'connectors stay loaded');
  assert.ok(cmd.args.includes('--allowedTools=mcp__claude_ai_Figma,mcp__claude_ai_Canva'));
  assert.ok(cmd.args.includes('--disallowedTools=mcp__claude_ai_Gmail,mcp__claude_ai_Google_Drive,mcp__claude_ai_AWS_MCP'));
  assert.throws(() => buildCommand('claude', { cwd: 'C:/w', bins, connectors: ['Figma'], knownConnectors: [] }), /connector/,
    'without the current connector list we cannot deny the rest, so connectors are refused');
});

test('read-only access gives Claude only the Read tool and Codex the read-only sandbox', () => {
  assert.ok(buildCommand('claude', { cwd: 'C:/w', bins, access: 'read' }).args.includes('--tools=Read'));
  assert.deepEqual(buildCommand('codex', { cwd: 'C:/w', bins, access: 'read' }).args.slice(0, 5), ['exec', '--json', '--ignore-user-config', '--sandbox', 'read-only']);
  assert.throws(() => buildCommand('claude', { cwd: 'C:/w', bins, access: 'admin' }), /access/);
});

test('codex ignores the user config (its MCP servers) and runs in the workspace-write sandbox, prompt from stdin', () => {
  const cmd = buildCommand('codex', { cwd: 'C:/w', model: null, bins });
  assert.deepEqual(cmd.args, ['exec', '--json', '--ignore-user-config', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--ephemeral', '--cd', 'C:/w', '-']);
  assert.deepEqual(buildCommand('codex', { cwd: 'C:/w', model: 'm1', bins }).args.slice(-3), ['-m', 'm1', '-']);
  assert.throws(() => buildCommand('other', { cwd: 'C:/w', bins }), /provider/);
});

test('the final answer is read from Claude result events and Codex agent messages', () => {
  assert.equal(finalAnswer('{"type":"assistant"}\n{"type":"result","subtype":"success","result":"끝났습니다"}'), '끝났습니다');
  assert.equal(finalAnswer('{"type":"item.completed","item":{"type":"agent_message","text":"first"}}\n{"type":"item.completed","item":{"type":"agent_message","text":"last"}}'), 'last');
  assert.equal(finalAnswer('{"type":"result","is_error":true,"result":"Failed"}'), null, 'an error result is not an answer');
  assert.equal(finalAnswer('plain text'), null);
});

test('the model comes only from what the tool printed', () => {
  assert.equal(reportedModel('{"type":"system","subtype":"init","model":"claude-x"}\n{"type":"result"}'), 'claude-x');
  assert.equal(reportedModel('not json\n{"type":"turn.completed"}'), null);
});

test('failures are classified; unknown stays unclassified', () => {
  assert.equal(classifyFailure('Error: usage limit reached, try again later'), 'limit');
  assert.equal(classifyFailure('Please run /login. 401 Unauthorized'), 'auth');
  assert.equal(classifyFailure('ECONNRESET while contacting server'), 'network');
  assert.equal(classifyFailure('something odd'), 'unclassified');
});

function fakeTool(script) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hq-fake-'));
  const file = path.join(dir, 'fake.mjs');
  writeFileSync(file, script);
  return { claude: { file: process.execPath, prefix: [file] }, codex: { file: process.execPath, prefix: [file] } };
}

test('a real child process: prompt via stdin, cwd respected, reported model captured', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-ws-'));
  const fake = fakeTool(`import { writeFileSync } from 'node:fs';
let input = ''; process.stdin.on('data', c => input += c).on('end', () => {
  writeFileSync('got.txt', input);
  console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'fake-model-1' }));
  console.log('x'.repeat(100000));
  console.log(JSON.stringify({ type: 'result', result: 'final answer after long output' }));
});`);
  const adapter = new CliAgentAdapter({ enabled: true, bins: fake });
  const result = await adapter.run('claude', 'say hi; rm -rf / "quoted"', () => {}, { cwd });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.model, 'fake-model-1');
  assert.equal(result.answer, 'final answer after long output', 'the answer is found even after a long output');
  assert.equal(readFileSync(path.join(cwd, 'got.txt'), 'utf8'), 'say hi; rm -rf / "quoted"');
});

test('non-zero exit is classified and a hung tool is killed at the timeout', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-ws-'));
  const limited = new CliAgentAdapter({ enabled: true, bins: fakeTool(`process.stderr.write('usage limit reached'); process.exit(1);`) });
  assert.deepEqual(await limited.run('codex', 'x', () => {}, { cwd }).then(r => [r.outcome, r.errorKind]), ['limited', 'limit']);
  const hung = new CliAgentAdapter({ enabled: true, timeoutMs: 300, bins: fakeTool(`setInterval(() => {}, 1000);`) });
  const r = await hung.run('codex', 'x', () => {}, { cwd });
  assert.deepEqual([r.outcome, r.errorKind], ['failed', 'timeout']);
});
