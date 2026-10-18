import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxEnv } from './격리환경.js';

// Codex 팀 실행 복원 (architecture-policy.json codexTeamExecution.restorePlan, docs/codex-격리-복원.md).
// Checked on this PC (2026-10-18, codex-cli 0.163.0-alpha.10.2, elevated Windows sandbox): commands run as the
// CodexSandboxOffline account, and each sandbox run grants that account's group read (RX) on every folder under the
// home folder, so a file next to the work folder or anywhere in home is readable; only listing home itself is refused.
// A read-restricting permissions profile is refused ("elevated Windows sandbox requires effective `:root` read
// access"), "deny" entries are silently ignored, the unelevated backend refuses restricted reads, and MXC is
// unavailable on Windows 11 23H2. So the native sandbox cannot keep Codex inside the work folder.
//
// The way back 대장 approved (2026-10-18): a dedicated WSL2 distro. WSL2 is not a security boundary from the Windows
// user by itself (Microsoft: a shell in WSL has the same rights as PowerShell run by that user), so the design adds:
// no drive automount, no Windows programs (interop off), no GPU driver share, no shared Windows folder at all (the
// job's files go in and come back as a tar stream, 작업묶음.js), a Linux user without sudo and a locked root, and
// Codex's own Linux sandbox (bubblewrap) with a profile that reads only platform paths and the job folder — so the
// Codex login in ~/.codex stays out of reach of the commands Codex runs.
// Nothing here is wired into team execution: it builds the commands and runs the boundary test.

// What the boundary must hold before Codex teams return. required=false is a known gap, reported but not blocking.
export const BOUNDARY_POLICY = [
  { id: 'insideWrite', expect: true, required: true, about: '작업 폴더 안 쓰고 다시 읽기' },
  { id: 'outsideRead', expect: false, required: true, about: '작업 폴더 밖(옆 폴더) 파일 읽기' },
  { id: 'outsideList', expect: false, required: true, about: '작업 폴더 밖 폴더 목록 보기' },
  { id: 'outsideWrite', expect: false, required: true, about: '작업 폴더 밖 쓰기' },
  { id: 'homeRead', expect: false, required: true, about: '실행 계정 홈의 파일 읽기' },
  { id: 'symlinkEscape', expect: false, required: true, about: '작업 폴더 안에 만든 링크로 밖 파일 읽기' },
  { id: 'authRead', expect: false, required: true, backends: ['wsl'], about: 'Codex 인증정보(~/.codex) 읽기' },
  { id: 'windowsRead', expect: false, required: true, backends: ['wsl'], about: 'WSL 안에서 Windows 쪽 파일 읽기 (/mnt/c 경로)' },
  { id: 'procEscape', expect: false, required: true, backends: ['wsl'], about: '/proc/1/root 를 거쳐 밖 파일 읽기' },
  { id: 'mountEscape', expect: false, required: true, backends: ['wsl'], about: 'Windows 드라이브 직접 연결(mount -t drvfs)' },
  { id: 'interopExec', expect: false, required: true, backends: ['wsl'], about: 'Windows 프로그램 실행 (cmd.exe·interop 소켓)' },
  { id: 'sudo', expect: false, required: true, backends: ['wsl'], about: '비밀번호 없는 root 권한 (sudo -n)' },
  { id: 'tcp', expect: false, required: true, about: '외부 TCP 연결 (1.1.1.1:443)' },
  { id: 'dns', expect: false, required: false, about: 'DNS 조회 (이름에 내용을 실어 보낼 수 있음)' },
];

// Runs inside the sandbox from the work folder. It prints only true/false per check — never file contents (an
// auth file is opened and one byte read, then dropped) — so a leaking sandbox cannot leak into test output either.
// Arguments come from a file next to it (no quoting through two command lines).
export const PROBE_FILE = '.hq-boundary-probe.cjs';
export const PROBE_ARGS = '.hq-boundary-args.json';
export const PROBE_SOURCE = `'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), dns = require('dns'), cp = require('child_process');
const a = JSON.parse(fs.readFileSync(path.join(__dirname, ${JSON.stringify(PROBE_ARGS)}), 'utf8'));
const home = p => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const tries = f => { try { return f() !== false; } catch { return false; } };
const within = (ms, p) => Promise.race([p, new Promise(r => setTimeout(() => r(false), ms))]);
const has = (file, token) => fs.readFileSync(file, 'utf8').includes(token);
const oneByte = file => { const fd = fs.openSync(home(file), 'r'); try { return fs.readSync(fd, Buffer.alloc(1), 0, 1, 0) === 1; } finally { fs.closeSync(fd); } };
const runs = (cmd, args) => tries(() => cp.spawnSync(cmd, args, { timeout: 8000, stdio: 'ignore' }).status === 0);
const connects = sock => within(3000, new Promise(res => { const s = net.connect(sock); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); }));
(async () => {
  const r = {};
  r.insideWrite = tries(() => { fs.writeFileSync('hq-inside.txt', 'ok'); return fs.readFileSync('hq-inside.txt', 'utf8') === 'ok'; });
  r.outsideRead = tries(() => has(a.outsideFile, a.token));
  r.outsideList = tries(() => fs.readdirSync(path.dirname(a.outsideFile)).length >= 0);
  r.outsideWrite = tries(() => { fs.writeFileSync(a.outsideWriteFile, 'x'); return true; });
  r.homeRead = tries(() => has(home(a.homeFile), a.token));
  r.symlinkEscape = tries(() => { fs.symlinkSync(path.dirname(a.outsideFile), 'hq-link', process.platform === 'win32' ? 'junction' : 'dir'); return has(path.join('hq-link', path.basename(a.outsideFile)), a.token); });
  tries(() => fs.unlinkSync('hq-link')) || tries(() => fs.rmdirSync('hq-link'));
  if (a.linux) {
    r.authRead = (a.authFiles || []).some(f => tries(() => oneByte(f)));
    r.windowsRead = tries(() => has(a.windowsFile, a.token)) || tries(() => fs.readdirSync('/mnt/c').length >= 0);
    r.procEscape = tries(() => has('/proc/1/root' + a.outsideFile, a.token));
    r.mountEscape = tries(() => { fs.mkdirSync('hq-mnt', { recursive: true }); return cp.spawnSync('mount', ['-t', 'drvfs', 'C:', 'hq-mnt'], { timeout: 8000, stdio: 'ignore' }).status === 0; });
    tries(() => fs.rmSync('hq-mnt', { recursive: true, force: true }));
    const sockets = [process.env.WSL_INTEROP, ...(tries(() => fs.readdirSync('/run/WSL')) ? fs.readdirSync('/run/WSL').map(n => '/run/WSL/' + n) : [])].filter(Boolean);
    let viaSocket = false;
    for (const s of sockets) if (await connects(s)) viaSocket = true;
    r.interopExec = viaSocket || runs('cmd.exe', ['/c', 'ver']) || runs('powershell.exe', ['-Command', 'exit 0']) || runs('/mnt/c/Windows/System32/cmd.exe', ['/c', 'ver']);
    r.sudo = runs('sudo', ['-n', 'true']);
  }
  if (a.network === false) { console.log('HQ_BOUNDARY ' + JSON.stringify(r)); process.exit(0); }
  r.tcp = await within(6000, new Promise(res => { const s = net.connect({ host: '1.1.1.1', port: 443 }); s.on('connect', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); }));
  r.dns = await within(6000, new Promise(res => dns.lookup('example.com', e => res(!e))));
  console.log('HQ_BOUNDARY ' + JSON.stringify(r));
  process.exit(0);
})();
`;

// → { ok, failures: [{ id, about, observed }], gaps: [...] }. A missing observation counts as a failure.
export function evaluateBoundary(observed, { backend = 'native', policy = BOUNDARY_POLICY } = {}) {
  const failures = [], gaps = [];
  for (const rule of policy.filter(r => !r.backends || r.backends.includes(backend))) {
    const value = observed?.[rule.id];
    if (value === rule.expect) continue;
    (rule.required ? failures : gaps).push({ id: rule.id, about: rule.about, observed: typeof value === 'boolean' ? value : null });
  }
  return { ok: failures.length === 0, failures, gaps };
}

export function parseProbeOutput(text) {
  const line = String(text ?? '').split(/\r?\n/).reverse().find(l => l.startsWith('HQ_BOUNDARY '));
  if (!line) return null;
  try { return JSON.parse(line.slice('HQ_BOUNDARY '.length)); } catch { return null; }
}

// ── WSL2 backend ────────────────────────────────────────────────────────────────────────────────────────────────
export const DISTRO = 'hq-codex';
export const RUN_USER = 'hqcodex';
export const JOB_ROOT = '/srv/hq/jobs';

// /etc/wsl.conf of the distro. Root inside the distro could change it (and manual drvfs mounts stay possible for
// root even with automount off), which is why the run user has no sudo and root is locked; the engine re-checks it.
export const WSL_CONF = `[automount]
enabled = false
mountFsTab = false

[interop]
enabled = false
appendWindowsPath = false

[gpu]
enabled = false

[user]
default = ${RUN_USER}
`;
const WSL_CONF_NEEDS = { 'automount.enabled': 'false', 'automount.mountfstab': 'false', 'interop.enabled': 'false', 'interop.appendwindowspath': 'false', 'gpu.enabled': 'false' };
export function checkWslConf(text) {
  const values = {};
  let section = '';
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const head = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (head) { section = head[1].trim().toLowerCase(); continue; }
    const kv = /^\s*([A-Za-z]+)\s*=\s*([^#\s]+)/.exec(line);
    if (kv) values[`${section}.${kv[1].toLowerCase()}`] = kv[2].toLowerCase();
  }
  return Object.entries(WSL_CONF_NEEDS).filter(([key, value]) => values[key] !== value).map(([key, value]) => `${key} = ${value} 이어야 한다`);
}

// Where a Windows file would be if drives were mounted — the probe expects it to be missing.
export function wslAutomountPath(windowsPath) {
  const full = path.win32.resolve(windowsPath);
  return `/mnt/${full[0].toLowerCase()}/${full.slice(3).replace(/\\/g, '/')}`;
}

// wsl.exe argv; --exec runs the program without a Linux shell, so nothing is re-parsed.
export function wslCommand({ distro = DISTRO, user = RUN_USER, cwd = null, argv }) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(distro ?? ''))) throw new Error('invalid WSL distro name');
  if (!/^[a-z_][a-z0-9_-]*$/.test(String(user ?? ''))) throw new Error('invalid WSL user name');
  if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== 'string')) throw new Error('WSL command must be a list of strings');
  return { file: 'wsl.exe', args: ['-d', distro, '-u', user, ...(cwd ? ['--cd', cwd] : []), '--exec', ...argv] };
}

// One folder per job under JOB_ROOT (0700, owned by the run user). Jobs of the same user are only kept apart by
// Codex's sandbox, which the boundary test checks with a sibling job's file.
export function jobPath(jobId) {
  if (!/^[a-z0-9][a-z0-9-]{5,39}$/.test(String(jobId))) throw new Error('invalid job id');
  return `${JOB_ROOT}/${jobId}`;
}
// create/remove run as root (the run user cannot make folders outside its job root or delete others' leftovers);
// copy-in/out run as the run user. copyIn reads the engine's tar from stdin; copyOut writes one to stdout.
export function jobCommands({ distro = DISTRO, user = RUN_USER, jobId }) {
  const dir = jobPath(jobId);
  return {
    dir,
    create: wslCommand({ distro, user: 'root', argv: ['install', '-d', '-o', user, '-g', user, '-m', '700', dir] }),
    copyIn: wslCommand({ distro, user, argv: ['tar', '-x', '-f', '-', '-C', dir, '--no-same-owner', '--no-same-permissions'] }),
    copyOut: wslCommand({ distro, user, argv: ['tar', '-c', '-f', '-', '--format=pax', '--exclude=./node_modules', '--exclude=./.git', '-C', dir, '.'] }),
    remove: wslCommand({ distro, user: 'root', argv: ['rm', '-rf', '--one-file-system', dir] }),
  };
}

// Inside the distro, Codex's Linux sandbox narrows reads too: platform paths and the job folder only. No --sandbox
// flag: it would switch Codex back to the legacy settings and ignore default_permissions.
export const LINUX_PROFILE = 'hq';
export const linuxProfileArgs = (access = 'write') => [
  '-c', `permissions.${LINUX_PROFILE}={filesystem={":minimal"="read",":workspace_roots"={"."="${access === 'read' ? 'read' : 'write'}"}}}`,
  '-c', `default_permissions="${LINUX_PROFILE}"`,
];

// The team-step command (codex exec) for the WSL backend — the same options as buildCommand's codex branch, with
// the job folder as the workspace. The prompt still goes through stdin.
export function wslCodexExec({ distro = DISTRO, user = RUN_USER, jobId, model = null, effort = null, access = 'write', codex = 'codex' }) {
  const cwd = jobPath(jobId);
  const argv = [codex, 'exec', '--json', '--ignore-user-config', ...linuxProfileArgs(access), '--skip-git-repo-check', '--ephemeral', '--cd', cwd];
  if (model) argv.push('-m', model);
  if (effort) argv.push('-c', `model_reasoning_effort="${effort}"`);
  argv.push('-');
  return wslCommand({ distro, user, cwd, argv });
}

// ── Running the boundary test ───────────────────────────────────────────────────────────────────────────────────
// The probe runs through the sandbox command alone (codex sandbox): no model is called, no subscription is used.
export function nativeProbeCommand({ codex, work, node = process.execPath }) {
  return { file: codex.file, args: [...(codex.prefix ?? []), 'sandbox', '-P', ':workspace', '-C', work, '--', node, PROBE_FILE] };
}
export function wslProbeCommand({ distro = DISTRO, user = RUN_USER, jobId, codex = 'codex', node = 'node' }) {
  const cwd = jobPath(jobId);
  return wslCommand({ distro, user, cwd, argv: [codex, 'sandbox', ...linuxProfileArgs('write'), '-P', LINUX_PROFILE, '-C', cwd, '--', node, PROBE_FILE] });
}

// input: a string or Buffer for stdin. binary: stdout comes back as a Buffer (tar), stderr as text.
export function runCommand({ file, args }, { cwd = undefined, input = null, binary = false, timeoutMs = 120_000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let output = '', done = false;
    const chunks = [];
    const child = spawnFn(file, args, { cwd, env: sandboxEnv(), shell: false, windowsHide: true });
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve({ ...value, ...(binary ? { stdout: Buffer.concat(chunks) } : {}) }); } };
    const timer = setTimeout(() => { child.kill(); finish({ code: null, output, timedOut: true }); }, timeoutMs);
    if (binary) child.stdout?.on('data', c => chunks.push(c));
    else child.stdout?.setEncoding('utf8').on('data', c => { output = (output + c).slice(-20_000); });
    child.stderr?.setEncoding('utf8').on('data', c => { output = (output + c).slice(-20_000); });
    child.on('error', error => finish({ code: null, output: error.message, timedOut: false }));
    child.on('close', code => finish({ code, output, timedOut: false }));
    child.stdin?.on('error', () => {});
    if (input !== null) child.stdin?.end(input); else child.stdin?.end();
  });
}

// Lays out the folders the native probe needs, outside TEMP (Codex lets sandboxed commands use TEMP by design):
//   <home>/.hq-boundary-<random>/work                 the work folder
//   <home>/.hq-boundary-<random>/outside/marker.txt   a sibling outside it
//   <home>/.hq-boundary-home-<random>/marker.txt      another folder in home (homeRead)
// Only these folders are made and removed; nothing else in home is read or listed.
export function prepareBoundaryFolders({ home = os.homedir(), token = `HQ-BOUNDARY-${Date.now().toString(36)}` } = {}) {
  const base = mkdtempSync(path.join(home, '.hq-boundary-'));
  const other = mkdtempSync(path.join(home, '.hq-boundary-home-'));
  const work = path.join(base, 'work'), outside = path.join(base, 'outside');
  mkdirSync(work); mkdirSync(outside);
  const outsideFile = path.join(outside, 'marker.txt'), homeFile = path.join(other, 'marker.txt');
  writeFileSync(outsideFile, token); writeFileSync(homeFile, token);
  writeFileSync(path.join(work, PROBE_FILE), PROBE_SOURCE);
  const cleanup = () => { rmSync(base, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); };
  return { base, work, outsideFile, outsideWriteFile: path.join(outside, 'written.txt'), homeFile, token, cleanup };
}
export function writeProbeArgs(work, args) {
  writeFileSync(path.join(work, PROBE_ARGS), JSON.stringify(args));
}
