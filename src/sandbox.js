import { spawn } from 'node:child_process';
import path from 'node:path';

// Runs a program the engine chose (never one an agent typed) inside Codex's Windows sandbox:
//   codex sandbox -P :workspace -C <project> -- <program> <args>
// Checked on this machine (codex-cli 0.158.0-alpha): writes only inside the project folder (and temp),
// the user's home folder cannot be read, and network access is refused. No model is called, so it
// uses no subscription usage. The sandbox passes the environment through, so only a short list of
// system variables goes in: tokens and keys in the user's environment never reach project code.
const KEEP_ENV = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'LANG'];

export function sandboxEnv(env = process.env) {
  const clean = { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false' };
  for (const [key, value] of Object.entries(env)) if (KEEP_ENV.includes(key.toUpperCase())) clean[key] = value;
  return clean;
}

// Run npm through node itself, so no .cmd wrapper or shell is involved on the engine side.
export function npmCommand(args) {
  return [process.execPath, path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...args];
}

export class SandboxRunner {
  constructor({ codex, env = process.env, timeoutMs = 3 * 60_000, spawnFn = spawn } = {}) {
    Object.assign(this, { codex, env, timeoutMs, spawnFn });
  }

  get available() { return Boolean(this.codex?.file); }

  // command: [program, ...args] fixed by the engine. Resolves with the exit code and output tails.
  run(cwd, command, { timeoutMs = this.timeoutMs, network = false } = {}) {
    if (!this.available) return Promise.resolve({ status: 'unavailable', code: null, output: '' });
    if (!Array.isArray(command) || !command.length || command.some(a => typeof a !== 'string')) throw new Error('sandbox command must be a list of strings');
    const [file, args] = network
      // Only for engine-owned read-only lookups (npm audit): runs outside the sandbox, still with a clean environment.
      ? [command[0], command.slice(1)]
      : [this.codex.file, [...this.codex.prefix, 'sandbox', '-P', ':workspace', '-C', cwd, '--', ...command]];
    return new Promise((resolve) => {
      let output = '', timedOut = false, done = false;
      const child = this.spawnFn(file, args, { cwd, env: sandboxEnv(this.env), shell: false, windowsHide: true });
      const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
      const keep = (chunk) => { output = (output + chunk).slice(-20_000); };
      child.stdout?.setEncoding('utf8').on('data', keep);
      child.stderr?.setEncoding('utf8').on('data', keep);
      child.on('error', (error) => finish({ status: 'unavailable', code: null, output: error.code === 'ENOENT' ? '실행 파일 없음' : error.message }));
      child.on('close', (code) => finish(timedOut
        ? { status: 'timeout', code, output: output.slice(-4_000) }
        : { status: code === 0 ? 'pass' : 'fail', code, output: output.slice(-4_000) }));
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
