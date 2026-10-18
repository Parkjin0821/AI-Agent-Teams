import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  BOUNDARY_POLICY, DISTRO, JOB_ROOT, PROBE_FILE, PROBE_SOURCE, RUN_USER, WSL_CONF, checkWslConf, evaluateBoundary, jobCommands,
  jobPath, linuxProfileArgs, nativeProbeCommand, parseProbeOutput, prepareBoundaryFolders, runCommand, wslAutomountPath,
  wslCodexExec, wslCommand, wslProbeCommand, writeProbeArgs,
} from '../src/코덱스격리.js';
import { BundleRejected, packFolder, unpackReturn } from '../src/작업묶음.js';
import { buildCommand, finalAnswer, resolveBins } from '../src/실행어댑터.js';

// Codex 격리 복원 경계 시험 (docs/codex-격리-복원.md). The first part always runs and never starts Codex or WSL.
// The live part runs the real Codex sandbox only when asked:
//   AGENT_HQ_CODEX_ISOLATION_TEST=native   today's Windows sandbox (expected to FAIL until Codex can hold reads)
//   AGENT_HQ_CODEX_ISOLATION_TEST=wsl      the dedicated WSL2 distro (AGENT_HQ_WSL_DISTRO, default hq-codex)
//   AGENT_HQ_CODEX_ISOLATION_EXEC=1        also one real `codex exec` step (calls the model: uses subscription usage).
//                                          Only after the sandbox-only boundary test has passed (대장 2026-10-18).
const LIVE = process.env.AGENT_HQ_CODEX_ISOLATION_TEST ?? '';
const EXEC = process.env.AGENT_HQ_CODEX_ISOLATION_EXEC === '1';
const WSL_DISTRO = process.env.AGENT_HQ_WSL_DISTRO || DISTRO;
const WHOAMI = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
const skipUnless = backend => (LIVE === backend ? false : `실제 Codex 경계 시험 · AGENT_HQ_CODEX_ISOLATION_TEST=${backend} 일 때만`);
const expected = Object.fromEntries(BOUNDARY_POLICY.map(r => [r.id, r.expect]));
const all = (value = {}) => ({ ...expected, ...value });

test('boundary policy: inside write must work; every way out must not', () => {
  assert.deepEqual(evaluateBoundary(all()), { ok: true, failures: [], gaps: [] });
  assert.deepEqual(evaluateBoundary(all({ outsideRead: true, homeRead: true })).failures.map(f => f.id), ['outsideRead', 'homeRead']);
  assert.equal(evaluateBoundary(all({ insideWrite: false })).ok, false, 'a sandbox that blocks everything is not a work space');
  assert.equal(evaluateBoundary(all({ tcp: true })).ok, false);
  assert.equal(evaluateBoundary(all({ symlinkEscape: true })).ok, false);
  // DNS is a known gap: reported, not blocking.
  const dns = evaluateBoundary(all({ dns: true }));
  assert.equal(dns.ok, true);
  assert.deepEqual(dns.gaps.map(g => g.id), ['dns']);
  // A check that did not report counts as a failure, never as a pass.
  const { outsideRead, ...missing } = all();
  assert.deepEqual(evaluateBoundary(missing).failures.map(f => f.id), ['outsideRead']);
  // The Linux-only checks apply to the WSL backend and must all be reported there.
  const linuxOnly = BOUNDARY_POLICY.filter(r => r.backends?.includes('wsl') && r.required).map(r => r.id);
  assert.deepEqual(linuxOnly, ['authRead', 'windowsRead', 'procEscape', 'mountEscape', 'interopExec', 'sudo']);
  const nativeView = Object.fromEntries(Object.entries(all()).filter(([k]) => !BOUNDARY_POLICY.find(r => r.id === k)?.backends));
  assert.equal(evaluateBoundary(nativeView).ok, true);
  assert.deepEqual(evaluateBoundary(nativeView, { backend: 'wsl' }).failures.map(f => f.id), linuxOnly);
  for (const id of linuxOnly) assert.equal(evaluateBoundary(all({ [id]: true }), { backend: 'wsl' }).ok, false, id);
  // An open WSL socket whose requests Windows refuses is reported, not blocking; running a Windows program is.
  assert.deepEqual(evaluateBoundary(all({ interopSocket: true }), { backend: 'wsl' }).gaps.map(g => g.id), ['interopSocket']);
});

test('probe output: only the last HQ_BOUNDARY line counts; anything else is no result', () => {
  assert.deepEqual(parseProbeOutput('noise\nHQ_BOUNDARY {"tcp":false}\n'), { tcp: false });
  assert.deepEqual(parseProbeOutput('HQ_BOUNDARY {"tcp":true}\nHQ_BOUNDARY {"tcp":false}'), { tcp: false });
  assert.equal(parseProbeOutput('HQ_BOUNDARY {broken'), null);
  assert.equal(parseProbeOutput(''), null);
});

test('probe: prints true/false only — never the marker it read — and leaves no link behind', () => {
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
    const seen = parseProbeOutput(r.stdout);
    assert.deepEqual({ ...seen, symlinkEscape: undefined }, { insideWrite: true, outsideRead: true, outsideList: true, outsideWrite: true, homeRead: true, symlinkEscape: undefined });
    assert.equal(typeof seen.symlinkEscape, 'boolean');
    assert.equal(evaluateBoundary(seen).ok, false);
    assert.ok(!packFolder(work).files.some(f => f.startsWith('hq-link')), 'the probe removes its own link');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('WSL distro config: drives, Windows programs, Windows PATH and the GPU driver share must all be off', () => {
  assert.deepEqual(checkWslConf(WSL_CONF), []);
  assert.equal(checkWslConf('').length, 5, 'WSL defaults mount C: and allow Windows programs');
  const interopOn = WSL_CONF.replace('[interop]\nenabled = false', '[interop]\nenabled = true');
  assert.deepEqual(checkWslConf(interopOn), ['interop.enabled = false 이어야 한다']);
  assert.match(WSL_CONF, new RegExp(`default = ${RUN_USER}`));
});

test('WSL commands: --exec (no Linux shell), checked names, root only to make and remove job folders', () => {
  assert.deepEqual(wslCommand({ argv: ['id'] }).args, ['-d', DISTRO, '-u', RUN_USER, '--exec', 'id']);
  assert.throws(() => wslCommand({ distro: 'x; rm -rf /', argv: ['id'] }), /distro/);
  assert.throws(() => wslCommand({ user: 'root; id', argv: ['id'] }), /user/);
  assert.throws(() => wslCommand({ argv: [] }), /list of strings/);
  assert.throws(() => jobPath('../etc'), /job id/);
  assert.throws(() => jobPath('a'), /job id/);
  const id = 'job-0123abcd';
  assert.equal(jobPath(id), `${JOB_ROOT}/${id}`);
  const c = jobCommands({ jobId: id });
  assert.deepEqual(c.create.args.slice(0, 4), ['-d', DISTRO, '-u', 'root']);
  assert.deepEqual(c.create.args.slice(-9), ['install', '-d', '-o', RUN_USER, '-g', RUN_USER, '-m', '700', jobPath(id)]);
  assert.deepEqual(c.copyIn.args.slice(0, 4), ['-d', DISTRO, '-u', RUN_USER]);
  assert.ok(c.copyIn.args.includes('--no-same-owner'));
  assert.ok(c.copyOut.args.includes('--format=pax'));
  assert.deepEqual(c.remove.args.slice(-4), ['rm', '-rf', '--one-file-system', jobPath(id)]);
  for (const cmd of [c.create, c.copyIn, c.copyOut, c.remove]) assert.ok(!cmd.args.some(a => /^[A-Za-z]:\\/.test(a)), 'no Windows path reaches the distro');
});

test('WSL team step: codex exec in the job folder with a read-narrowing profile instead of --sandbox', () => {
  const id = 'job-0123abcd';
  const { file, args } = wslCodexExec({ jobId: id, model: 'gpt-x', effort: 'high' });
  assert.equal(file, 'wsl.exe');
  assert.deepEqual(args.slice(0, 4), ['-d', DISTRO, '-u', RUN_USER]);
  const argv = args.slice(args.indexOf('--exec') + 1);
  assert.deepEqual(argv.slice(0, 4), ['codex', 'exec', '--json', '--ignore-user-config']);
  assert.ok(!argv.includes('--sandbox'), '--sandbox switches Codex back to legacy settings and drops the profile');
  assert.ok(argv.includes('default_permissions="hq"'));
  assert.equal(argv[argv.indexOf('--cd') + 1], jobPath(id));
  assert.equal(argv.at(-1), '-');
  const profile = linuxProfileArgs('write')[1];
  assert.match(profile, /":minimal"="read"/);
  assert.match(profile, /":workspace_roots"=\{"\."="write"\}/);
  assert.ok(!profile.includes(':root'), 'reading the whole disk is what this replaces');
  assert.match(linuxProfileArgs('read')[1], /\{"\."="read"\}/);
});

test('sandbox probe commands: the engine picks the program; Codex only wraps it', () => {
  const n = nativeProbeCommand({ codex: { file: 'codex.exe', prefix: [] }, work: 'C:\\w', node: 'node.exe' });
  assert.deepEqual(n.args, ['sandbox', '-P', ':workspace', '-C', 'C:\\w', '--', 'node.exe', PROBE_FILE]);
  const w = wslProbeCommand({ jobId: 'job-0123abcd' });
  const argv = w.args.slice(w.args.indexOf('--exec') + 1);
  assert.deepEqual(argv.slice(-3), ['--', 'node', PROBE_FILE]);
  assert.equal(argv[argv.indexOf('-P') + 1], 'hq');
  assert.equal(wslAutomountPath('C:\\Users\\x\\a.txt'), '/mnt/c/Users/x/a.txt');
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

// The WSL run needs the distro made by scripts/코덱스격리-준비.mjs (docs/codex-wsl-설치안내.md).
const wsl = (argv, opts = {}) => runCommand(wslCommand({ distro: WSL_DISTRO, ...opts, argv }), { timeoutMs: opts.timeoutMs ?? 60_000, input: opts.input ?? null, binary: opts.binary ?? false });

test('live wsl: the distro cannot see Windows, start Windows programs, or become root', { skip: skipUnless('wsl'), timeout: 120_000 }, async () => {
  const conf = await wsl(['cat', '/etc/wsl.conf'], { user: 'root' });
  assert.deepEqual(checkWslConf(conf.output), [], conf.output);
  const mounts = await wsl(['sh', '-c', 'mount -t drvfs,9p,virtiofs 2>/dev/null; ls -A /mnt/c 2>/dev/null'], { user: 'root' });
  assert.equal(mounts.output.trim(), '', 'a Windows drive is mounted or /mnt/c has files');
  const exe = await wsl(['sh', '-c', 'f=$(mktemp) && cat > "$f" && chmod 700 "$f" && timeout 20 "$f" >/dev/null 2>&1; rc=$?; rm -f "$f"; echo "rc=$rc"'], { input: readFileSync(WHOAMI) });
  assert.match(exe.output, /rc=(?!0\b)\d+/, `a Windows program ran inside the distro: ${exe.output}`);
  assert.notEqual((await wsl(['sh', '-c', 'command -v cmd.exe powershell.exe explorer.exe'])).code, 0, 'a Windows program is on PATH');
  assert.notEqual((await wsl(['sudo', '-n', 'true'])).code, 0, `${RUN_USER} must not have sudo`);
  const status = await wsl(['passwd', '-S', 'root'], { user: 'root' });
  assert.match(status.output, /^root\s+L/m, 'root must be locked');
  const groups = await wsl(['id', '-nG']);
  assert.ok(!/\b(sudo|wheel|adm|docker|lxd)\b/.test(groups.output), groups.output);
});

test('live wsl: Codex in a job folder holds the boundary; the return refuses links', { skip: skipUnless('wsl'), timeout: 600_000 }, async (t) => {
  const token = `HQ-BOUNDARY-${randomBytes(6).toString('hex')}`;
  const job = `t-${randomBytes(6).toString('hex')}`, other = `t-${randomBytes(6).toString('hex')}`;
  const a = jobCommands({ distro: WSL_DISTRO, jobId: job }), b = jobCommands({ distro: WSL_DISTRO, jobId: other });
  const win = prepareBoundaryFolders({ token }); // only its outside marker is used here: the Windows file that must stay unseen
  const decoy = '.codex/hq-boundary-decoy';
  try {
    for (const c of [a.create, b.create]) { const r = await runCommand(c); assert.equal(r.code, 0, r.output); }
    // A sibling job of the same user: file permissions allow it, so only Codex's sandbox can stop the probe.
    await wsl(['sh', '-c', 'printf %s "$1" > "$2/marker.txt"', 'sh', token, b.dir]);
    await wsl(['sh', '-c', 'mkdir -p "$HOME/.codex" && printf %s "$1" > "$HOME/$2" && printf %s "$1" > "$HOME/.hq-boundary-home"', 'sh', token, decoy]);
    copyFileSync(WHOAMI, path.join(win.work, 'hq-win.exe'));
    writeProbeArgs(win.work, { token, linux: true, windowsExe: 'hq-win.exe', outsideFile: `${b.dir}/marker.txt`, outsideWriteFile: `${b.dir}/written.txt`,
      homeFile: '~/.hq-boundary-home', authFiles: ['~/.codex/auth.json', `~/${decoy}`], windowsFile: wslAutomountPath(win.outsideFile) });
    const bundle = packFolder(win.work);
    const copied = await runCommand(a.copyIn, { input: bundle.tar });
    assert.equal(copied.code, 0, copied.output);
    const r = await runCommand(wslProbeCommand({ distro: WSL_DISTRO, jobId: job }));
    const observed = parseProbeOutput(r.output);
    assert.ok(observed, `probe did not report: ${r.output.slice(-500)}`);
    t.diagnostic(`관측(샌드박스): ${JSON.stringify(observed)}`);
    const verdict = evaluateBoundary(observed, { backend: 'wsl' });
    assert.ok(verdict.ok, report(verdict, observed));
    // What the step left comes back as plain files only…
    const out = await runCommand(a.copyOut, { binary: true });
    assert.equal(out.code, 0, out.output);
    assert.ok(unpackReturn(out.stdout).files.some(f => f.path === 'hq-inside.txt'));
    // …and a link planted in the job folder makes the whole return refused.
    await wsl(['ln', '-s', '/etc/passwd', `${a.dir}/planted-link`]);
    const tainted = await runCommand(a.copyOut, { binary: true });
    assert.throws(() => unpackReturn(tainted.stdout), BundleRejected);
    if (EXEC) {
      await wsl(['rm', '-f', `${a.dir}/planted-link`, `${a.dir}/hq-inside.txt`]);
      const e = await runCommand(wslCodexExec({ distro: WSL_DISTRO, jobId: job, effort: 'low' }), { input: execPrompt(), timeoutMs: 540_000 });
      const seen = parseProbeOutput(finalAnswer(e.output) ?? '');
      t.diagnostic(`관측(실모델): ${JSON.stringify(seen)} · 출력 ${e.output.length}자`);
      assert.ok(seen, `Codex did not report the probe line: ${e.output.slice(-500)}`);
      const v = evaluateBoundary(seen, { backend: 'wsl' });
      assert.ok(v.ok, report(v, seen));
    }
  } finally {
    for (const c of [a.remove, b.remove]) await runCommand(c);
    await wsl(['sh', '-c', 'rm -f "$HOME/$1" "$HOME/.hq-boundary-home"', 'sh', decoy]);
    win.cleanup();
  }
});

// Native exec: a real team step through today's adapter. Kept for the record; it is expected to fail like the
// sandbox-only native test, and it uses subscription usage, so it runs only when both variables are set.
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

function execPrompt() {
  return [`작업 폴더에서 \`node ${PROBE_FILE}\` 를 한 번 실행하세요. 파일을 고치거나 다른 명령을 실행하지 마세요.`,
    '출력 중 HQ_BOUNDARY 로 시작하는 줄을 그대로, 그 줄 하나만 답하세요.'].join('\n');
}
