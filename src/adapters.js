import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Options checked against the installed CLIs' --help (Claude Code 2.1.265, codex-cli 0.158.0-alpha).
// The prompt always goes through stdin, never the command line, so it cannot be parsed as options.
// access: 'write' (default) lets the tool change files in the workspace; 'read' only lets it look.
export function buildCommand(provider, { cwd, model = null, bins, access = 'write' }) {
  if (!['read', 'write'].includes(access)) throw new Error(`unknown access: ${access}`);
  if (provider === 'claude') {
    // acceptEdits: file edits inside the workspace only; no shell or web tools are offered at all.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      access === 'read' ? '--tools=Read' : '--tools=Read,Write,Edit', '--no-session-persistence'];
    if (model) args.push('--model', model);
    return { file: bins.claude.file, args: [...bins.claude.prefix, ...args], cwd };
  }
  if (provider === 'codex') {
    const args = ['exec', '--json', '--sandbox', access === 'read' ? 'read-only' : 'workspace-write', '--skip-git-repo-check', '--ephemeral', '--cd', cwd];
    if (model) args.push('-m', model);
    args.push('-');
    return { file: bins.codex.file, args: [...bins.codex.prefix, ...args], cwd };
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
  const hosted = Boolean(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT);
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (HOST_SESSION.test(key) || (hosted && key === 'ANTHROPIC_BASE_URL')) continue;
    clean[key] = value;
  }
  return clean;
}

export function resolveBins(env = process.env) {
  const claudeExe = env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  const claude = env.AGENT_HQ_CLAUDE_BIN || (claudeExe && existsSync(claudeExe) ? claudeExe : 'claude');
  const codex = env.AGENT_HQ_CODEX_BIN || newestCodexApp(env.LOCALAPPDATA) || 'codex';
  return { claude: { file: claude, prefix: [] }, codex: { file: codex, prefix: [] } };
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

  async run(provider, prompt, onEvent, { cwd, model = null, access = 'write' } = {}) {
    if (!this.enabled) {
      onEvent({ type: 'provider.notice', provider, message: 'Safe mode: CLI execution is disabled' });
      return { outcome: 'simulated', summary: `${provider} dry-run only; no work executed`, model: null };
    }
    if (!cwd) throw new Error('Project workspace is required for CLI execution');
    const command = buildCommand(provider, { cwd, model, access, bins: this.bins ?? resolveBins() });
    return new Promise((resolve) => {
      const child = spawn(command.file, command.args, { cwd: command.cwd, shell: false, windowsHide: true, env: childEnv() });
      let head = '', partial = '', model = null, answer = null, stderr = '', timedOut = false, settled = false;
      const finish = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ...result, answer }); } };
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, this.timeoutMs);
      // Read the JSON event stream line by line, keeping only what we need (model, final answer).
      const consume = (line) => {
        const event = parseEvent(line.trim());
        if (!event) return;
        model ??= modelFrom(event);
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

function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
  } else {
    child.kill('SIGKILL');
  }
}
