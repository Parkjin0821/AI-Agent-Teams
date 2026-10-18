import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BOUNDARY_POLICY, PROBE_FILE, PROBE_SOURCE, WSL_CONF, checkWslConf, evaluateBoundary, linuxProfileArgs, nativeProbeCommand,
  parseProbeOutput, prepareBoundaryFolders, runCommand, wslAutomountPath, wslCodexExec, wslCommand, wslMountCommands,
  wslProbeCommand, wslUnmountCommand, wslWorkPath, writeProbeArgs,
} from '../src/코덱스격리.js';
import { buildCommand, finalAnswer, resolveBins } from '../src/실행어댑터.js';

// Codex 격리 복원 경계 시험 (docs/codex-격리-복원.md). The first part always runs and never starts Codex.
// The live part runs the real Codex sandbox only when asked:
//   AGENT_HQ_CODEX_ISOLATION_TEST=native   today's Windows sandbox (expected to FAIL until Codex can hold reads)
//   AGENT_HQ_CODEX_ISOLATION_TEST=wsl      the WSL2 distro (AGENT_HQ_WSL_DISTRO, default hq-codex; AGENT_HQ_WSL_USER, default hq)
//   AGENT_HQ_CODEX_ISOLATION_EXEC=1        also one real `codex exec` step (calls the model: uses subscription usage)
const LIVE = process.env.AGENT_HQ_CODEX_ISOLATION_TEST ?? '';
const EXEC = process.env.AGENT_HQ_CODEX_ISOLATION_EXEC === '1';
const DISTRO = process.env.AGENT_HQ_WSL_DISTRO || 'hq-codex';
const USER = process.env.AGENT_HQ_WSL_USER || 'hq';
const skipUnless = backend => (LIVE === backend ? false : `실제 Codex 경계 시험 · AGENT_HQ_CODEX_ISOLATION_TEST=${backend} 일 때만`);

const all = (value, extra = {}) => ({ ...Object.fromEntries(BOUNDARY_POLICY.map(r => [r.id, r.expect])), ...extra, ...value });

test('boundary policy: inside write must work; outside read, list, write, home read and TCP must not', () => {
  assert.deepEqual(evaluateBoundary(all({})), { ok: true, failures: [], gaps: [] });
  const leak = evaluateBoundary(all({ outsideRead: true, homeRead: true }));
  assert.equal(leak.ok, false);
  assert.deepEqual(leak.failures.map(f => f.id), ['outsideRead', 'homeRead']);
  assert.equal(evaluateBoundary(all({ insideWrite: false })).ok, false, 'a sandbox that blocks everything is not a work space');
  assert.equal(evaluateBoundary(all({ tcp: true })).ok, false);
  // DNS is a known gap: reported, not blocking.
  const dns = evaluateBoundary(all({ dns: true }));
  assert.equal(dns.ok, true);
  assert.deepEqual(dns.gaps.map(g => g.id), ['dns']);
  // A check that did not report counts as a failure, never as a pass.
  const { outsideRead, ...rest } = all({});
  assert.deepEqual(evaluateBoundary(rest).failures.map(f => f.id), ['outsideRead']);
  // windowsRead only applies to the WSL backend.
  const { windowsRead, ...noWindowsCheck } = all({});
  assert.equal(evaluateBoundary(noWindowsCheck).ok, true);
  assert.deepEqual(evaluateBoundary(noWindowsCheck, { backend: 'wsl' }).failures.map(f => f.id), ['windowsRead']);
  assert.equal(evaluateBoundary(all({ windowsRead: false }), { backend: 'wsl' }).ok, true);
});

test('probe output: only the last HQ_BOUNDARY line counts; anything else is no result', () => {
  assert.deepEqual(parseProbeOutput('noise\nHQ_BOUNDARY {"tcp":false}\n'), { tcp: false });
  assert.deepEqual(parseProbeOutput('HQ_BOUNDARY {"tcp":true}\nHQ_BOUNDARY {"tcp":false}'), { tcp: false });
  assert.equal(parseProbeOutput('HQ_BOUNDARY {broken'), null);
  assert.equal(parseProbeOutput(''), null);
});

test('probe: prints true/false only — never the marker it read — so a leaking sandbox cannot leak into logs', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hq-probe-'));
  try {
    const work = path.join(dir, 'work'), outside = path.join(dir, 'outside');
    mkdirSync(work); mkdirSync(outside);
    const token = 'SECRET-LOOKING-TOKEN-123';
    writeFileSync(path.join(outside, 'marker.txt'), token);
    writeFileSync(path.join(work, PROBE_FILE), PROBE_SOURCE);
    writeProbeArgs(work, { token, outsideFile: path.join(outside, 'marker.txt'), outsideWriteFile: path.join(outside, 'w.txt'),
      homeFile: path.join(outside, 'marker.txt'), network: false });
    // No sandbox here: everything is reachable, which is exactly what the probe must report.
    const r = spawnSync(process.execPath, [PROBE_FILE], { cwd: work, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token));
    assert.deepEqual(parseProbeOutput(r.stdout), { insideWrite: true, outsideRead: true, outsideList: true, outsideWrite: true, homeRead: true });
    assert.equal(evaluateBoundary(parseProbeOutput(r.stdout)).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WSL distro config: Windows drives, Windows programs and the Windows PATH must all be off', () => {
  assert.deepEqual(checkWslConf(WSL_CONF), []);
  assert.equal(checkWslConf('').length, 4, 'WSL defaults mount C: and allow Windows programs');
  const interopOn = WSL_CONF.replace('[interop]\nenabled = false', '[interop]\nenabled = true');
  assert.deepEqual(checkWslConf(interopOn), ['interop.enabled = false 이어야 한다']);
  assert.deepEqual(checkWslConf('[automount]\nenabled=false # comment\nmountFsTab = false\n[interop]\nenabled=false\nappendWindowsPath=false'), []);
});

test('WSL paths: one hashed mount per project, no Windows name on a Linux command line', () => {
  const a = wslWorkPath('C:\\Users\\user\\AI-Agent-Teams\\projects\\홈페이지 만들기');
  assert.match(a, /^\/hq\/work\/p-[0-9a-f]{12}$/);
  assert.equal(wslWorkPath('c:\\users\\USER\\AI-Agent-Teams\\projects\\홈페이지 만들기'), a, 'Windows paths are case-insensitive');
  assert.notEqual(wslWorkPath('C:\\Users\\user\\AI-Agent-Teams\\projects\\other'), a);
  assert.equal(wslAutomountPath('C:\\Users\\x\\a.txt'), '/mnt/c/Users/x/a.txt');
});

test('WSL commands: --exec (no Linux shell), checked distro name, root only for mounting', () => {
  assert.deepEqual(wslCommand({ distro: 'hq-codex', user: 'hq', cwd: '/w', argv: ['id'] }).args, ['-d', 'hq-codex', '-u', 'hq', '--cd', '/w', '--exec', 'id']);
  assert.throws(() => wslCommand({ distro: 'x; rm -rf /', argv: ['id'] }), /distro/);
  assert.throws(() => wslCommand({ distro: 'hq', argv: [] }), /list of strings/);
  const win = 'C:\\Users\\user\\AI-Agent-Teams\\projects\\p1';
  const [mkdir, mount] = wslMountCommands({ distro: 'hq-codex', windowsPath: win });
  assert.deepEqual(mkdir.args.slice(0, 4), ['-d', 'hq-codex', '-u', 'root']);
  assert.deepEqual(mount.args.slice(-7), ['mount', '-t', 'drvfs', win, wslWorkPath(win), '-o', 'uid=1000,gid=1000,metadata']);
  assert.deepEqual(wslUnmountCommand({ distro: 'hq-codex', windowsPath: win }).args.slice(-2), ['umount', wslWorkPath(win)]);
});

test('WSL team step: codex exec with a read-narrowing profile instead of --sandbox, prompt on stdin', () => {
  const win = 'C:\\Users\\user\\AI-Agent-Teams\\projects\\p1';
  const { file, args } = wslCodexExec({ distro: 'hq-codex', user: 'hq', windowsPath: win, model: 'gpt-x', effort: 'high' });
  assert.equal(file, 'wsl.exe');
  const argv = args.slice(args.indexOf('--exec') + 1);
  assert.deepEqual(argv.slice(0, 4), ['codex', 'exec', '--json', '--ignore-user-config']);
  assert.ok(!argv.includes('--sandbox'), '--sandbox switches Codex back to legacy settings and drops the profile');
  assert.ok(argv.includes('default_permissions="hq"'));
  assert.ok(argv.includes(`--cd`) && argv[argv.indexOf('--cd') + 1] === wslWorkPath(win));
  assert.equal(argv.at(-1), '-');
  assert.ok(argv.includes('-m') && argv.includes('model_reasoning_effort="high"'));
  const profile = linuxProfileArgs('write')[1];
  assert.match(profile, /":minimal"="read"/);
  assert.match(profile, /":workspace_roots"=\{"\."="write"\}/);
  assert.ok(!profile.includes(':root'), 'reading the whole disk is what this replaces');
  assert.match(linuxProfileArgs('read')[1], /\{"\."="read"\}/);
});

test('sandbox probe commands: the engine picks the program; Codex only wraps it', () => {
  const n = nativeProbeCommand({ codex: { file: 'codex.exe', prefix: [] }, work: 'C:\\w', node: 'node.exe' });
  assert.deepEqual(n.args, ['sandbox', '-P', ':workspace', '-C', 'C:\\w', '--', 'node.exe', PROBE_FILE]);
  const w = wslProbeCommand({ distro: 'hq-codex', user: 'hq', windowsPath: 'C:\\w' });
  const argv = w.args.slice(w.args.indexOf('--exec') + 1);
  assert.deepEqual(argv.slice(-3), ['--', 'node', PROBE_FILE]);
  assert.ok(argv.includes('-P') && argv[argv.indexOf('-P') + 1] === 'hq');
});

// ── Live: the real Codex sandbox ────────────────────────────────────────────────────────────────────────────────
const report = (verdict, observed) => [`관측: ${JSON.stringify(observed)}`,
  ...verdict.failures.map(f => `실패 · ${f.about} (관측 ${f.observed})`), ...verdict.gaps.map(g => `남은 위험 · ${g.about}`)].join('\n');

test('live native: today\'s Windows sandbox holds the work-folder boundary', { skip: skipUnless('native'), timeout: 300_000 }, async () => {
  const bins = resolveBins();
  const f = prepareBoundaryFolders();
  try {
    writeProbeArgs(f.work, { token: f.token, outsideFile: f.outsideFile, outsideWriteFile: f.outsideWriteFile, homeFile: f.homeFile });
    const r = await runCommand(nativeProbeCommand({ codex: bins.codex, work: f.work }), { cwd: f.work });
    const observed = parseProbeOutput(r.output);
    assert.ok(observed, `probe did not report: ${r.output.slice(-500)}`);
    const verdict = evaluateBoundary(observed, { backend: 'native' });
    assert.ok(verdict.ok, report(verdict, observed));
  } finally { f.cleanup(); }
});

test('live native exec: a real Codex team step (workspace-write) cannot read outside the work folder', { skip: skipUnless('native') || (!EXEC && 'AGENT_HQ_CODEX_ISOLATION_EXEC=1 일 때만 (모델 호출)'), timeout: 600_000 }, async () => {
  const f = prepareBoundaryFolders();
  try {
    writeProbeArgs(f.work, { token: f.token, outsideFile: f.outsideFile, outsideWriteFile: f.outsideWriteFile, homeFile: f.homeFile });
    const cmd = buildCommand('codex', { cwd: f.work, bins: resolveBins(), access: 'write', effort: 'low' });
    const r = await runCommand(cmd, { cwd: f.work, input: execPrompt(), timeoutMs: 540_000 });
    const observed = parseProbeOutput(finalAnswer(r.output) ?? '');
    assert.ok(observed, `Codex did not report the probe line: ${r.output.slice(-500)}`);
    const verdict = evaluateBoundary(observed, { backend: 'native' });
    assert.ok(verdict.ok, report(verdict, observed));
  } finally { f.cleanup(); }
});

// The WSL run needs, inside the distro: WSL_CONF as /etc/wsl.conf, node and codex for USER, codex logged in with the
// ChatGPT subscription (never an API key), and bubblewrap. See docs/codex-격리-복원.md.
async function wsl(argv, opts = {}) { return runCommand(wslCommand({ distro: DISTRO, ...opts, argv }), { timeoutMs: opts.timeoutMs ?? 60_000, input: opts.input ?? null }); }

test('live wsl: the distro cannot see Windows drives or start Windows programs', { skip: skipUnless('wsl'), timeout: 120_000 }, async () => {
  const conf = await wsl(['cat', '/etc/wsl.conf']);
  assert.deepEqual(checkWslConf(conf.output), [], conf.output);
  assert.notEqual((await wsl(['test', '-e', '/mnt/c'])).code, 0, '/mnt/c must not exist');
  const interop = await wsl(['sh', '-c', 'cat /proc/sys/fs/binfmt_misc/WSLInterop* 2>/dev/null | head -n 1']);
  assert.notEqual(interop.output.trim(), 'enabled', 'Windows programs can be started from inside the distro');
});

test('live wsl: Codex inside the distro holds the work-folder boundary', { skip: skipUnless('wsl'), timeout: 300_000 }, async () => {
  const f = prepareBoundaryFolders();
  const [mkdir, mount] = wslMountCommands({ distro: DISTRO, windowsPath: f.work });
  const outsideDir = '/hq/boundary-outside';
  try {
    for (const c of [mkdir, mount]) { const r = await runCommand(c); assert.equal(r.code, 0, r.output); }
    // A Linux-side sibling anyone may read and write: only Codex's sandbox can stop the probe here.
    await wsl(['sh', '-c', `mkdir -p ${outsideDir} && chmod 1777 ${outsideDir} && printf %s "$1" > ${outsideDir}/marker.txt && chmod 644 ${outsideDir}/marker.txt`, 'sh', f.token], { user: 'root' });
    await wsl(['sh', '-c', 'umask 077; printf %s "$1" > "$HOME/.hq-boundary-home-marker"', 'sh', f.token], { user: USER });
    writeProbeArgs(f.work, { token: f.token, outsideFile: `${outsideDir}/marker.txt`, outsideWriteFile: `${outsideDir}/written.txt`,
      homeFile: '~/.hq-boundary-home-marker', windowsFile: wslAutomountPath(f.outsideFile) });
    const r = await runCommand(wslProbeCommand({ distro: DISTRO, user: USER, windowsPath: f.work }));
    const observed = parseProbeOutput(r.output);
    assert.ok(observed, `probe did not report: ${r.output.slice(-500)}`);
    const verdict = evaluateBoundary(observed, { backend: 'wsl' });
    assert.ok(verdict.ok, report(verdict, observed));
    if (EXEC) {
      const e = await runCommand(wslCodexExec({ distro: DISTRO, user: USER, windowsPath: f.work, effort: 'low' }), { input: execPrompt(), timeoutMs: 540_000 });
      const seen = parseProbeOutput(finalAnswer(e.output) ?? '');
      assert.ok(seen, `Codex did not report the probe line: ${e.output.slice(-500)}`);
      const v = evaluateBoundary(seen, { backend: 'wsl' });
      assert.ok(v.ok, report(v, seen));
    }
  } finally {
    await runCommand(wslUnmountCommand({ distro: DISTRO, windowsPath: f.work }));
    await wsl(['rm', '-rf', outsideDir], { user: 'root' });
    await wsl(['rm', '-f', '.hq-boundary-home-marker'], { user: USER, cwd: '~' });
    f.cleanup();
  }
});

function execPrompt() {
  return [`작업 폴더에서 \`node ${PROBE_FILE}\` 를 한 번 실행하세요. 파일을 고치거나 다른 명령을 실행하지 마세요.`,
    '출력 중 HQ_BOUNDARY 로 시작하는 줄을 그대로, 그 줄 하나만 답하세요.'].join('\n');
}
