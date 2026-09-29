import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { sentinelSettings } from './sentinel.js';

// Options checked against the installed CLIs' --help (Claude Code 2.1.265, codex-cli 0.158.0-alpha).
// The prompt always goes through stdin, never the command line, so it cannot be parsed as options.
// claude.ai connector "Google Drive" → tool prefix mcp__claude_ai_Google_Drive (Claude Code naming).
export const connectorTool = (name) => `mcp__claude_ai_${name.replace(/[^A-Za-z0-9]+/g, '_')}`;

// access: 'write' (default) lets the tool change files in the workspace; 'read' only lets it look.
// web: adds Claude Code's built-in WebSearch/WebFetch. connectors: claude.ai connectors this team may use;
// every other connector in knownConnectors is denied. Without connectors, all MCP is switched off.
export function buildCommand(provider, { cwd, model = null, effort = null, bins, access = 'write', web = false, connectors = [], knownConnectors = [], sentinel = null }) {
  if (connectors.some(c => /higgsfield/i.test(c))) throw new Error('subscription-only: paid image credits are blocked');
  if (effort && !['low','medium','high','xhigh','max','ultra'].includes(effort)) throw new Error('invalid reasoning effort');
  if (provider === 'claude' && effort === 'ultra') throw new Error('unsupported Claude reasoning effort');
  if (!['read', 'write'].includes(access)) throw new Error(`unknown access: ${access}`);
  const env = childEnv();
  if (provider === 'claude') {
    const tools = [...(access === 'read' ? ['Read'] : ['Read', 'Write', 'Edit']), ...(web ? ['WebSearch', 'WebFetch'] : [])];
    // acceptEdits: file edits inside the workspace only; no shell tool is offered at all.
    // --strict-mcp-config drops local/project MCP servers; claude.ai connectors need their own switch.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      `--tools=${tools.join(',')}`, '--no-session-persistence', '--setting-sources', 'user', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
    if (connectors.length) {
      const unknown = connectors.filter(c => !knownConnectors.includes(c));
      if (!knownConnectors.length || unknown.length) throw new Error(`connector not available: ${unknown.join(', ') || connectors.join(', ')}`);
      args.push(`--allowedTools=${connectors.map(connectorTool).join(',')}`);
      const others = knownConnectors.filter(c => !connectors.includes(c));
      if (others.length) args.push(`--disallowedTools=${others.map(connectorTool).join(',')}`);
    } else {
      env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false'; // official switch: mail, drive and other account connectors stay off
    }
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    // 감시 에이전트: hooks given with --settings always load, even with --setting-sources user.
    if (sentinel) {
      args.push('--settings', JSON.stringify(sentinelSettings(sentinel.script)));
      Object.assign(env, { AGENT_HQ_WORKSPACE: cwd, AGENT_HQ_SENTINEL_LOG: sentinel.log,
        AGENT_HQ_PROJECT: sentinel.project ?? '', AGENT_HQ_TEAM: sentinel.team ?? '',
        AGENT_HQ_SENTINEL_GRANTS: sentinel.grants ?? '', AGENT_HQ_SENTINEL_WEB: sentinel.webMode === 'open' ? 'open' : 'ask' });
    }
    return { file: bins.claude.file, args: [...bins.claude.prefix, ...args], cwd, env };
  }
  if (provider === 'codex') {
    // --ignore-user-config: skip ~/.codex/config.toml (and its MCP servers); login still works.
    const args = ['exec', '--json', '--ignore-user-config', '--sandbox', access === 'read' ? 'read-only' : 'workspace-write',
      '--skip-git-repo-check', '--ephemeral', '--cd', cwd];
    // Skipping the user config also drops its Windows sandbox mode, and without one Codex refuses every
    // command (even reading a file). Only that one value is carried over.
    if (bins.codex.windowsSandbox) args.push('-c', `windows.sandbox="${bins.codex.windowsSandbox}"`);
    if (model) args.push('-m', model);
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    args.push('-');
    return { file: bins.codex.file, args: [...bins.codex.prefix, ...args], cwd, env };
  }
  throw new Error(`unknown provider: ${provider}`);
}

function parseEvent(line) {
  if (!line.startsWith('{')) return null;
  try { return JSON.parse(line); } catch { return null; }
}
function modelFrom(event) {
  const model = event.model ?? event.message?.model ?? event.session?.model;
  return typeof model === 'string' && model ? model : null;
}
// Claude Code stream-json ends with {"type":"result","result":"..."}; Codex --json emits agent_message items.
function answerFrom(event) {
  if (event.type === 'result' && !event.is_error && typeof event.result === 'string') return event.result;
  if (event.item?.type === 'agent_message' && typeof event.item.text === 'string') return event.item.text;
  return null;
}

// Claude Code stream-json reports the subscription limit state it saw (no percentages):
// {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1784283600,"rateLimitType":"five_hour",...}}
// Undocumented shape (anthropics/claude-code#78476), so anything unexpected is ignored.
export function rateLimitFrom(event) {
  const info = event?.type === 'rate_limit_event' ? event.rate_limit_info : null;
  if (!info || typeof info.status !== 'string' || typeof info.rateLimitType !== 'string') return null;
  const resetsAt = Number.isFinite(info.resetsAt) && info.resetsAt > 0 ? new Date(info.resetsAt * 1000).toISOString() : null;
  return { window: info.rateLimitType.slice(0, 40), status: info.status.slice(0, 40), resetsAt, usingOverage: info.isUsingOverage === true };
}

// Only a model name the tool itself printed counts; nothing is inferred from settings.
export function reportedModel(stdout) {
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseEvent(line);
    if (event && modelFrom(event)) return modelFrom(event);
  }
  return null;
}

export function finalAnswer(stdout) {
  let answer = null;
  for (const line of stdout.split(/\r?\n/)) {
    const event = parseEvent(line);
    if (event && answerFrom(event) !== null) answer = answerFrom(event);
  }
  return answer;
}

export function classifyFailure(text) {
  if (/unauthori[sz]ed|\b401\b|not logged in|\/login|authenticat|invalid api key/i.test(text)) return 'auth';
  if (/usage limit|rate limit|quota|limit reached|\b429\b|capacity/i.test(text)) return 'limit';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error/i.test(text)) return 'network';
  if (/permission denied|not permitted|EACCES/i.test(text)) return 'permission';
  return 'unclassified';
}

// When AGENT HQ itself runs inside a Claude Code / Claude desktop session, that host injects its own
// session variables (messaging tokens, a local API endpoint). Child CLIs must not inherit them: they
// should authenticate with the user's own login, and host tokens must not leak into other agents.
const HOST_SESSION = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.*)$/;
export function childEnv(env = process.env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    // Subscription-only: do not inherit metered credentials, proxies or cloud provider switches.
    if (HOST_SESSION.test(key) || /(_API_KEY|_TOKEN)$/i.test(key) || /^(AWS_|AZURE_|ANTHROPIC_VERTEX_|GOOGLE_APPLICATION_CREDENTIALS$|HTTPS?_PROXY$|ALL_PROXY$)/i.test(key)
      || /^(OPENAI_BASE_URL|OPENAI_API_BASE|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|CLAUDE_CODE_USE_FOUNDRY)$/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

export function resolveBins(env = process.env) {
  const claudeExe = env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const claude = env.AGENT_HQ_CLAUDE_BIN || (claudeExe && existsSync(claudeExe) ? claudeExe : 'claude');
  const codex = env.AGENT_HQ_CODEX_BIN || newestCodexApp(env.LOCALAPPDATA) || 'codex';
  return { claude: { file: claude, prefix: [] },
    codex: { file: codex, prefix: [], ...(process.platform === 'win32' ? { windowsSandbox: codexWindowsSandbox(env) } : {}) } };
}

// The [windows] sandbox mode from the user's Codex config ("elevated" needs a one-time admin setup);
// "unelevated" when none is set. Nothing else in that file is read.
export function codexWindowsSandbox(env = process.env, read = readFileSync) {
  const home = env.CODEX_HOME || (env.USERPROFILE && path.join(env.USERPROFILE, '.codex'));
  let text = '';
  try { text = home ? read(path.join(home, 'config.toml'), 'utf8') : ''; } catch { /* no config */ }
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) { section = header[1].trim(); continue; }
    const value = section === 'windows' && /^\s*sandbox\s*=\s*"(elevated|unelevated)"\s*(#.*)?$/.exec(line);
    if (value) return value[1];
  }
  return 'unelevated';
}

// The Codex desktop app ships the official CLI under a versioned folder; pick the newest one.
function newestCodexApp(localAppData) {
  if (!localAppData) return null;
  const dir = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  try {
    return readdirSync(dir).map(d => path.join(dir, d, 'codex.exe')).filter(f => existsSync(f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
  } catch { return null; }
}

export class CliAgentAdapter {
  constructor({ enabled = false, cwd = process.cwd(), bins = null, timeoutMs = 15 * 60_000 } = {}) {
    Object.assign(this, { enabled, cwd, bins, timeoutMs });
  }

  async run(provider, prompt, onEvent, { cwd, model = null, effort = null, access = 'write', web = false, connectors = [], knownConnectors = [], sentinel = null } = {}) {
    if (!this.enabled) {
      onEvent({ type: 'provider.notice', provider, message: 'Safe mode: CLI execution is disabled' });
      return { outcome: 'simulated', summary: `${provider} dry-run only; no work executed`, model: null };
    }
    if (!cwd) throw new Error('Project workspace is required for CLI execution');
    assertWorkspaceConfigurationSafe(cwd);
    const command = buildCommand(provider, { cwd, model, effort, access, web, connectors, knownConnectors, sentinel, bins: this.bins ?? resolveBins() });
    return new Promise((resolve) => {
      const child = spawn(command.file, command.args, { cwd: command.cwd, shell: false, windowsHide: true, env: command.env });
      let head = '', partial = '', model = null, answer = null, stderr = '', timedOut = false, settled = false;
      const limits = new Map();
      const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ...result, answer, rateLimits: [...limits.values()] }); } };
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, this.timeoutMs);
      // Read the JSON event stream line by line, keeping only what we need (model, final answer).
      const consume = (line) => {
        const event = parseEvent(line.trim());
        if (!event) return;
        model ??= modelFrom(event);
        const limit = rateLimitFrom(event);
        if (limit) limits.set(limit.window, limit);
        const text = answerFrom(event);
        if (text !== null) answer = text;
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        if (head.length < 64_000) head += chunk;
        const lines = (partial + chunk).split('\n');
        partial = lines.pop();
        if (partial.length > 4_000_000) partial = '';
        lines.forEach(consume);
        onEvent({ type: 'provider.output', provider, chunk });
      });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
      child.on('error', (error) => finish({ outcome: 'failed', errorKind: error.code === 'ENOENT' ? 'not_installed' : 'unclassified', summary: error.message, model: null }));
      child.on('close', (code) => {
        consume(partial);
        if (timedOut) return finish({ outcome: 'failed', errorKind: 'timeout', summary: `${provider} exceeded ${this.timeoutMs}ms`, model });
        if (code === 0) return finish({ outcome: 'completed', summary: `${provider} completed`, model });
        const errorKind = classifyFailure(`${stderr}\n${head.slice(-4_000)}`);
        finish({ outcome: errorKind === 'limit' ? 'limited' : 'failed', errorKind, summary: stderr.trim() || `${provider} exited ${code}`, model });
      });
      child.stdin.on('error', () => { /* tool exited before reading the prompt */ });
      child.stdin.end(prompt);
    });
  }
}

// Inspect before every actual spawn. Never execute/read the suspect file contents,
// follow links, delete files, or silently grant approval for workspace settings.
export function assertWorkspaceConfigurationSafe(cwd) {
  const forbidden = /^(\.claude|\.codex|\.mcp\.json|CLAUDE(?:\.local)?\.md|AGENTS(?:\.override)?\.md)$/i;
  const deny = relative => { throw Object.assign(new Error(`Untrusted workspace configuration: ${relative}`), { kind: 'permission' }); };
  const root = path.resolve(cwd);
  let inspected = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 64) deny('inspection depth exceeded');
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++inspected > 100000) deny('inspection entry limit exceeded');
      const file = path.join(dir, entry.name);
      if (forbidden.test(entry.name)) deny(path.relative(root, file));
      if (entry.isSymbolicLink()) deny(`link: ${path.relative(root, file)}`);
      if (entry.isDirectory()) walk(file, depth + 1);
    }
  };
  if (lstatSync(root).isSymbolicLink()) deny('workspace root is a link');
  walk(root);
  // CLIs also discover instruction files above cwd.
  for (let dir = path.dirname(root); ; dir = path.dirname(dir)) {
    for (const entry of readdirSync(dir)) {
      if (/^(CLAUDE(?:\.local)?\.md|AGENTS(?:\.override)?\.md)$/i.test(entry)) deny('ancestor instruction file');
    }
    if (path.dirname(dir) === dir) break;
  }
}

function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
  } else {
    child.kill('SIGKILL');
  }
}
