import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
// The chosen way back (pending 대장's install decision): Codex inside a WSL2 distro that cannot see Windows drives or
// start Windows programs, with only the project folder mounted, and Codex's own Linux sandbox inside that.
// Nothing here is wired into team execution yet: it builds the commands and runs the boundary test.

// What the boundary must hold before Codex teams return. required=false is a known gap, reported but not blocking.
export const BOUNDARY_POLICY = [
  { id: 'insideWrite', expect: true, required: true, about: '작업 폴더 안 쓰고 다시 읽기' },
  { id: 'outsideRead', expect: false, required: true, about: '작업 폴더 밖(옆 폴더) 파일 읽기' },
  { id: 'outsideList', expect: false, required: true, about: '작업 폴더 밖 폴더 목록 보기' },
  { id: 'outsideWrite', expect: false, required: true, about: '작업 폴더 밖 쓰기' },
  { id: 'homeRead', expect: false, required: true, about: '실행 계정 홈의 파일 읽기 (로그인 정보가 있는 곳)' },
  { id: 'windowsRead', expect: false, required: true, backends: ['wsl'], about: 'WSL 안에서 Windows 쪽 파일 읽기 (/mnt/c 경로)' },
  { id: 'tcp', expect: false, required: true, about: '외부 TCP 연결 (1.1.1.1:443)' },
  { id: 'dns', expect: false, required: false, about: 'DNS 조회 (이름에 내용을 실어 보낼 수 있음)' },
];

// Runs inside the sandbox from the work folder. It prints only true/false per check — never file contents — so a
// leak in the sandbox cannot leak into test output either. Arguments come from a file next to it (no quoting).
export const PROBE_FILE = '.hq-boundary-probe.cjs';
export const PROBE_ARGS = '.hq-boundary-args.json';
export const PROBE_SOURCE = `'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), dns = require('dns');
const a = JSON.parse(fs.readFileSync(path.join(__dirname, ${JSON.stringify(PROBE_ARGS)}), 'utf8'));
const home = p => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const tries = f => { try { return f() !== false; } catch { return false; } };
const within = (ms, p) => Promise.race([p, new Promise(r => setTimeout(() => r(false), ms))]);
(async () => {
  const r = {};
  r.insideWrite = tries(() => { fs.writeFileSync('hq-inside.txt', 'ok'); return fs.readFileSync('hq-inside.txt', 'utf8') === 'ok'; });
  r.outsideRead = tries(() => fs.readFileSync(a.outsideFile, 'utf8').includes(a.token));
  r.outsideList = tries(() => fs.readdirSync(path.dirname(a.outsideFile)).length >= 0);
  r.outsideWrite = tries(() => { fs.writeFileSync(a.outsideWriteFile, 'x'); return true; });
  r.homeRead = tries(() => fs.readFileSync(home(a.homeFile), 'utf8').includes(a.token));
  if (a.windowsFile) r.windowsRead = tries(() => fs.readFileSync(a.windowsFile, 'utf8').includes(a.token));
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
// The distro's /etc/wsl.conf must keep Windows out: no drive automount (no /mnt/c), no Windows programs from inside
// (interop could start cmd.exe as 대장's Windows account and read anything), no Windows PATH.
export const WSL_CONF = `[automount]
enabled = false
mountFsTab = false

[interop]
enabled = false
appendWindowsPath = false
`;
export function checkWslConf(text) {
  const values = {};
  let section = '';
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) { section = header[1].trim().toLowerCase(); continue; }
    const kv = /^\s*([A-Za-z]+)\s*=\s*([^#\s]+)/.exec(line);
    if (kv) values[`${section}.${kv[1].toLowerCase()}`] = kv[2].toLowerCase();
  }
  const need = { 'automount.enabled': 'false', 'automount.mountfstab': 'false', 'interop.enabled': 'false', 'interop.appendwindowspath': 'false' };
  return Object.entries(need).filter(([key, value]) => values[key] !== value).map(([key, value]) => `${key} = ${value} 이어야 한다`);
}

// One mount point per project, named by a hash so no Windows name (Korean, spaces) reaches a Linux command line.
export function wslWorkPath(windowsPath) {
  const id = createHash('sha256').update(path.win32.resolve(windowsPath).toLowerCase()).digest('hex').slice(0, 12);
  return `/hq/work/p-${id}`;
}
// Where a Windows file would be if drives were mounted — the probe expects it to be missing.
export function wslAutomountPath(windowsPath) {
  const full = path.win32.resolve(windowsPath);
  return `/mnt/${full[0].toLowerCase()}/${full.slice(3).replace(/\\/g, '/')}`;
}

// wsl.exe argv; --exec runs the program without a Linux shell, so nothing is re-parsed.
export function wslCommand({ distro, user = null, cwd = null, argv }) {
  if (!/^[A-Za-z0-9._-]+$/.test(String(distro ?? ''))) throw new Error('invalid WSL distro name');
  if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== 'string')) throw new Error('WSL command must be a list of strings');
  return { file: 'wsl.exe', args: ['-d', distro, ...(user ? ['-u', user] : []), ...(cwd ? ['--cd', cwd] : []), '--exec', ...argv] };
}
export function wslMountCommands({ distro, windowsPath, uid = 1000, gid = 1000 }) {
  const target = wslWorkPath(windowsPath);
  return [
    wslCommand({ distro, user: 'root', argv: ['mkdir', '-p', target] }),
    wslCommand({ distro, user: 'root', argv: ['mount', '-t', 'drvfs', path.win32.resolve(windowsPath), target, '-o', `uid=${uid},gid=${gid},metadata`] }),
  ];
}
export function wslUnmountCommand({ distro, windowsPath }) {
  return wslCommand({ distro, user: 'root', argv: ['umount', wslWorkPath(windowsPath)] });
}

// Inside the distro, Codex's Linux sandbox narrows reads too: a permissions profile that reads only platform paths and
// the work folder (so ~/.codex, where the login lives, stays out of reach of the commands Codex runs). No --sandbox
// flag: it would switch Codex back to the legacy settings and ignore default_permissions.
export const LINUX_PROFILE = 'hq';
export const linuxProfileArgs = (access = 'write') => [
  '-c', `permissions.${LINUX_PROFILE}={filesystem={":minimal"="read",":workspace_roots"={"."="${access === 'read' ? 'read' : 'write'}"}}}`,
  '-c', `default_permissions="${LINUX_PROFILE}"`,
];

// The team-step command (codex exec) for the WSL backend — the same options as buildCommand's codex branch, with
// Linux paths. The prompt still goes through stdin.
export function wslCodexExec({ distro, user, windowsPath, model = null, effort = null, access = 'write', codex = 'codex' }) {
  const cwd = wslWorkPath(windowsPath);
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
export function wslProbeCommand({ distro, user, windowsPath, codex = 'codex', node = 'node' }) {
  const cwd = wslWorkPath(windowsPath);
  return wslCommand({ distro, user, cwd, argv: [codex, 'sandbox', ...linuxProfileArgs('write'), '-P', LINUX_PROFILE, '-C', cwd, '--', node, PROBE_FILE] });
}

export function runCommand({ file, args }, { cwd = undefined, input = null, timeoutMs = 120_000, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let output = '', done = false;
    const child = spawnFn(file, args, { cwd, env: sandboxEnv(), shell: false, windowsHide: true });
    const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { child.kill(); finish({ code: null, output, timedOut: true }); }, timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', c => { output = (output + c).slice(-20_000); });
    child.stderr?.setEncoding('utf8').on('data', c => { output = (output + c).slice(-20_000); });
    child.on('error', error => finish({ code: null, output: error.message, timedOut: false }));
    child.on('close', code => finish({ code, output, timedOut: false }));
    if (input !== null) child.stdin?.end(input); else child.stdin?.end();
  });
}

// Lays out the folders the probe needs, outside TEMP (Codex lets sandboxed commands use TEMP by design):
//   <home>/.hq-boundary-<random>/work                 the work folder
//   <home>/.hq-boundary-<random>/outside/marker.txt   a sibling outside it
//   <home>/.hq-boundary-home-<random>/marker.txt      another folder in home (homeRead, native backend)
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
