import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWorkspaceConfigurationSafe, finalAnswer, reportedModel } from './실행어댑터.js';
import { AGENT_CONFIG, EXCLUDED_DIRS, PLACEHOLDERS, SECRET_FILE, listNames, packFolder, sha256, unpackReturn } from './작업묶음.js';
import { checkBaseline, checkProtected, protectedHashes, signingMode } from './승인서명.js';
import { DISTRO, JOB_ROOT, LINUX_PROFILE, RUN_USER, checkWslConf, jobCommands, jobPath, linuxProfileArgs, runCommand, wslCodexExec, wslCommand } from './코덱스격리.js';

// Codex 격리 실행기 (docs/codex-격리-복원.md 11절, 대장 결정 2 · 2026-10-18): one Codex job in the hq-codex distro, end
// to end — check the environment against the approved baseline, copy the project in, run, copy back, check what came
// back, and apply only what is allowed and not in conflict. It is NOT wired into team assignment or the default
// execution path; 대장 approves that separately.

const ENGINE_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const PROTECTED_NAMES = ['AGENT_HQ_CONSTITUTION.md', 'architecture-policy.json'];
// The approved environment baseline lives with the engine's data (not in git). Recording it is 대장's act.
export const BASELINE_FILE = path.join(ENGINE_ROOT, 'data', '코덱스격리-기준.json');

// ── 실행 전 환경 검증 ────────────────────────────────────────────────────────────────────────────────────────────
// Read-only. Every value is a short fingerprint or state word, never file contents.
const SNAPSHOT_SCRIPT = `h() { if [ -e "$1" ]; then sha256sum "$1" | cut -c1-64; else echo missing; fi; }
tree() { if [ -d "$1" ]; then find "$1" -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum | cut -c1-64; else echo missing; fi; }
U="$1"
echo "wslconf=$(h /etc/wsl.conf)"
echo "wslconf_text=$(base64 -w0 /etc/wsl.conf 2>/dev/null)"
echo "fstab=$(h /etc/fstab)"
echo "root_password=$(passwd -S root | cut -d' ' -f2)"
echo "uid0=$(awk -F: '$3==0{print $1}' /etc/passwd | tr '\\n' ',')"
echo "run_user=$(getent passwd "$U" | cut -d: -f1,3,4,6,7)"
echo "run_user_password=$(passwd -S "$U" | cut -d' ' -f2)"
echo "run_user_groups=$(id -nG "$U")"
echo "sudo=$(ls /usr/bin/sudo /bin/sudo /usr/local/bin/sudo 2>/dev/null | head -n1)"
echo "sudoers=$(ls /etc/sudoers /etc/sudoers.d 2>/dev/null | head -n1)"
echo "setuid=$(find / -xdev -perm -4000 -type f 2>/dev/null | sort | sha256sum | cut -c1-64)"
echo "windows_mounts=$(mount -t drvfs,9p,virtiofs 2>/dev/null | wc -l)"
echo "mnt_c=$(ls -A /mnt/c 2>/dev/null | wc -l)"
echo "job_root=$(stat -c '%U:%a' ${JOB_ROOT} 2>/dev/null)"
echo "run_user_home=$(stat -c '%U:%a' "/home/$U" 2>/dev/null)"
echo "codex_package=$(tree /usr/local/lib/node_modules/@openai/codex)"
echo "codex_launcher=$(h /usr/local/bin/codex)"
echo "bwrap=$(h /usr/bin/bwrap)"
echo "node=$(h /usr/bin/node)"
echo "interop_flag=$(cat /proc/sys/fs/binfmt_misc/WSLInterop* 2>/dev/null | head -n1)"
`;
// What must hold whatever the baseline says (a baseline recorded from a broken state must not make it pass).
export const PREFLIGHT_RULES = [
  ['wsl.conf 가 드라이브·Windows 프로그램·PATH·GPU 공유를 끈다', s => checkWslConf(Buffer.from(s.wslconf_text ?? '', 'base64').toString('utf8')).length === 0],
  ['Windows 드라이브 연결이 없다', s => s.windows_mounts === '0' && s.mnt_c === '0'],
  ['root 는 잠겨 있고 uid 0 은 root 하나뿐이다', s => s.root_password === 'L' && s.uid0 === 'root,'],
  ['실행 사용자는 잠겨 있고 관리 그룹이 없다', s => s.run_user_password === 'L' && s.run_user_groups === RUN_USER],
  ['sudo 가 없다', s => !s.sudo && !s.sudoers],
  ['작업 폴더 뿌리·실행 사용자 홈이 700 이다', s => s.job_root === `${RUN_USER}:700` && s.run_user_home === `${RUN_USER}:700`],
  ['Windows 프로그램이 실행되지 않는다 (whoami.exe 실제 실행)', s => s.windows_exe_ran === 'no'],
  ['Codex 로그인이 ChatGPT 구독이다', s => s.login === 'chatgpt'],
];
// Fingerprints compared with the approved baseline: any change stops Codex until 대장 records a new baseline.
export const BASELINE_KEYS = ['wslconf', 'fstab', 'root_password', 'uid0', 'run_user', 'run_user_password', 'run_user_groups', 'sudo', 'sudoers',
  'setuid', 'windows_mounts', 'mnt_c', 'job_root', 'run_user_home', 'codex_package', 'codex_launcher', 'bwrap', 'node', 'interop_flag',
  'windows_exe_ran', 'login', 'wslconfig_windows', 'wsl_version'];

const parseLines = text => Object.fromEntries(String(text).split(/\r?\n/).map(l => /^([a-z_0-9]+)=(.*)$/.exec(l.trim())).filter(Boolean).map(m => [m[1], m[2]]));

export async function environmentSnapshot({ distro = DISTRO, user = RUN_USER, run = runCommand, home = os.homedir() } = {}) {
  const root = await run(wslCommand({ distro, user: 'root', argv: ['sh', '-c', SNAPSHOT_SCRIPT, 'sh', user] }), { timeoutMs: 120_000 });
  if (root.code !== 0) return { reachable: false, error: String(root.output).slice(-300) };
  const s = parseLines(root.output);
  const whoami = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
  const exe = await run(wslCommand({ distro, user, argv: ['sh', '-c', 'f=$(mktemp) && cat > "$f" && chmod 700 "$f" && timeout 20 "$f" >/dev/null 2>&1; rc=$?; rm -f "$f"; echo "rc=$rc"'] }),
    { input: readFileSync(whoami), timeoutMs: 60_000 });
  const rc = /rc=(\d+)/.exec(exe.output)?.[1];
  s.windows_exe_ran = rc === undefined ? 'unknown' : rc === '0' ? 'yes' : 'no';
  const login = await run(wslCommand({ distro, user, argv: ['codex', 'login', 'status'] }), { timeoutMs: 60_000 });
  s.login = login.code === 0 && /chatgpt/i.test(login.output) && !/api key/i.test(login.output) ? 'chatgpt' : 'other';
  const wslconfig = path.join(home, '.wslconfig');
  s.wslconfig_windows = existsSync(wslconfig) ? sha256(readFileSync(wslconfig)) : 'missing';
  const version = await run({ file: 'wsl.exe', args: ['--version'] }, { env: { WSL_UTF8: '1' }, timeoutMs: 30_000 });
  s.wsl_version = (String(version.output).split(/\r?\n/)[0] ?? '').trim();
  return { reachable: true, items: s };
}

// → { ok, problems: [한 줄씩], snapshot }. No baseline is a stop, not a pass.
export function judgePreflight(snapshot, baseline) {
  if (!snapshot?.reachable) return { ok: false, problems: [`배포판에 닿지 못함: ${snapshot?.error ?? ''}`.trim()] };
  const s = snapshot.items, problems = [];
  for (const [about, holds] of PREFLIGHT_RULES) if (!holds(s)) problems.push(`규칙 위반 · ${about}`);
  if (!baseline?.items) problems.push('승인된 기준이 없다 (node scripts/코덱스격리-준비.mjs --record-baseline, 대장 확인 후)');
  else for (const key of BASELINE_KEYS) if (baseline.items[key] !== s[key]) problems.push(`기준과 다름 · ${key}`);
  return { ok: problems.length === 0, problems };
}

export function readBaseline(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
export function writeBaseline(file, snapshot, note = '') {
  const items = Object.fromEntries(BASELINE_KEYS.map(k => [k, snapshot.items[k]]));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ recordedAt: new Date().toISOString(), note, items }, null, 2));
  return items;
}

// ── 프로젝트 폴더 검사 ──────────────────────────────────────────────────────────────────────────────────────────
// The engine itself, a home or drive root, and anything holding the engine's protected files never go to Codex.
export function checkProjectFolder(projectDir, { engineRoot = ENGINE_ROOT, home = os.homedir() } = {}) {
  const dir = path.resolve(projectDir), lower = p => path.resolve(p).toLowerCase();
  const inside = (a, b) => lower(a) === lower(b) || lower(a).startsWith(lower(b) + path.sep);
  if (dir === path.parse(dir).root || lower(dir) === lower(home)) throw new Error('홈 폴더나 드라이브 전체는 보낼 수 없다');
  if (inside(engineRoot, dir)) throw new Error('엔진 폴더를 품은 폴더는 보낼 수 없다');
  if (inside(dir, engineRoot) && !inside(dir, path.join(engineRoot, 'projects'))) throw new Error('엔진 폴더 안에서는 projects 아래만 보낼 수 있다');
  for (const name of PROTECTED_NAMES) if (existsSync(path.join(dir, name))) throw new Error(`엔진 보호 파일이 들어 있다: ${name}`);
  assertWorkspaceConfigurationSafe(dir);
  return dir;
}

// ── 반환 판정과 반영 ────────────────────────────────────────────────────────────────────────────────────────────
// sent: packFolder's result at copy-in ({ files, hashes, skipped }). returned: unpackReturn's result.
// current: the project's hashes NOW (another step may have changed it while Codex worked).
// allow: optional list of relative folder prefixes the job may change; everything else is out of scope.
// → { changes: [{ path, action: add|modify|delete, data? }], conflicts: [{ path, why }], rejected: [{ path, why }], unchanged: n }
const key = p => p.normalize('NFC').toLowerCase();
const outOfScope = (rel, allow) => {
  const segments = rel.split('/');
  if (segments.some(s => EXCLUDED_DIRS.has(s) || AGENT_CONFIG.test(s) || PLACEHOLDERS.has(s))) return '에이전트 설정·제외 폴더';
  if (SECRET_FILE.test(segments.at(-1))) return '비밀정보로 보이는 파일';
  if (allow?.length && !allow.some(a => rel === a || rel.startsWith(`${a.replace(/\/+$/, '')}/`))) return '허용 범위 밖';
  return null;
};
export function planReturn({ sent, returned, current, allow = null }) {
  const changes = [], conflicts = [], rejected = [];
  let unchanged = 0;
  const skipped = [...(sent.skipped ?? [])].map(x => key(x.path));
  const sentByKey = new Map(Object.keys(sent.hashes).map(p => [key(p), p]));
  const currentByKey = new Map(Object.entries(current).map(([p, h]) => [key(p), h]));
  // Two returned names that are one file on Windows (case or Unicode form only) are both refused.
  const groups = new Map();
  for (const f of returned.files) groups.set(key(f.path), [...(groups.get(key(f.path)) ?? []), f]);
  for (const [k, files] of groups) {
    if (files.length > 1) { for (const f of files) conflicts.push({ path: f.path, why: '대소문자·정규화만 다른 이름이 겹침' }); continue; }
    const f = files[0], original = sentByKey.get(k), hash = sha256(f.data);
    if (original !== undefined && hash === sent.hashes[original]) { unchanged++; continue; }
    const why = outOfScope(f.path, allow) ?? (skipped.some(x => k === x || k.startsWith(`${x}/`)) ? '보내지 않은 파일 자리' : null);
    if (why) { rejected.push({ path: f.path, why }); continue; }
    const now = currentByKey.get(k);
    if (original !== undefined) {
      if (now !== sent.hashes[original]) conflicts.push({ path: original, why: '작업 중 프로젝트 쪽에서도 바뀜', data: f.data, hash });
      else changes.push({ path: original, action: 'modify', data: f.data, hash, before: now });
    } else if (now !== undefined) conflicts.push({ path: f.path, why: '작업 중 프로젝트에 같은 이름이 생김', data: f.data, hash });
    else changes.push({ path: f.path, action: 'add', data: f.data, hash, before: null });
  }
  for (const [k, original] of sentByKey) {
    if (groups.has(k)) continue;
    const why = outOfScope(original, allow);
    if (why) { rejected.push({ path: original, why: `지우기 거부 · ${why}` }); continue; }
    const now = currentByKey.get(k);
    if (now !== sent.hashes[original]) conflicts.push({ path: original, why: '지우려는 파일이 작업 중 프로젝트 쪽에서 바뀜' });
    else changes.push({ path: original, action: 'delete', before: now });
  }
  return { changes, conflicts, rejected, unchanged };
}

export function hashFolder(dir) {
  const { hashes } = packFolder(dir, { hashOnly: true, limits: { maxFiles: Infinity, maxBytes: Infinity, maxFileBytes: Infinity } });
  return hashes;
}

// Applies a plan inside projectDir as one unit: all of it or none of it.
//   1. check: every target's current hash is still what the plan saw, no folder on the way is a link (else nothing changes)
//   2. stage: new contents go to temporary files next to their targets and are read back against the returned hash
//   3. commit: each existing target is renamed to a backup, then the staged file is renamed into place
//   4. verify: every target is read back; on any failure in 3 or 4 every step already done is undone from the backups
// fsOps lets a test inject a failure part-way. → { applied, failed, aborted, rolledBack }
const FS = { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync };
export function applyPlan(projectDir, plan, { fsOps = FS } = {}) {
  const fsx = { ...FS, ...fsOps };
  const root = path.resolve(projectDir), tag = randomBytes(4).toString('hex');
  const hashNow = full => (fsx.existsSync(full) ? sha256(fsx.readFileSync(full)) : null);
  const target = rel => {
    const full = path.resolve(root, ...rel.split('/'));
    if (!full.startsWith(root + path.sep)) throw new Error('작업 폴더 밖');
    for (let p = path.dirname(full); p.length > root.length; p = path.dirname(p)) if (fsx.existsSync(p) && fsx.lstatSync(p).isSymbolicLink()) throw new Error('경로에 링크가 있음');
    if (fsx.existsSync(full) && fsx.lstatSync(full).isSymbolicLink()) throw new Error('대상이 링크');
    return full;
  };
  const steps = [];
  const cleanupTemps = () => { for (const st of steps) if (st.temp) fsx.rmSync(st.temp, { force: true }); };
  // 1. check
  for (const c of plan.changes) {
    try {
      const full = target(c.path);
      if (hashNow(full) !== c.before) return { applied: [], failed: [{ path: c.path, why: '반영 직전에 프로젝트 쪽에서 바뀜 — 전체 반영 취소' }], aborted: true, rolledBack: false };
      steps.push({ ...c, full });
    } catch (error) { return { applied: [], failed: [{ path: c.path, why: `${error.message} — 전체 반영 취소` }], aborted: true, rolledBack: false }; }
  }
  // 2. stage
  try {
    for (const st of steps) {
      if (st.action === 'delete') continue;
      fsx.mkdirSync(path.dirname(st.full), { recursive: true });
      st.temp = `${st.full}.hq-apply-${tag}`;
      fsx.writeFileSync(st.temp, st.data, { flag: 'wx' });
      if (sha256(fsx.readFileSync(st.temp)) !== st.hash) throw new Error(`준비한 파일의 해시가 다름: ${st.path}`);
    }
  } catch (error) { cleanupTemps(); return { applied: [], failed: [{ path: '(준비)', why: error.message }], aborted: true, rolledBack: false }; }
  // 3. commit, 4. verify — undo everything on the first failure
  const done = [];
  const undo = () => {
    for (const st of done.reverse()) {
      try {
        if (st.action !== 'delete' && fsx.existsSync(st.full)) fsx.rmSync(st.full, { force: true });
        if (st.backup && fsx.existsSync(st.backup)) fsx.renameSync(st.backup, st.full);
      } catch { /* reported below: the backup file stays next to the target for 대장 */ }
    }
  };
  try {
    for (const st of steps) {
      if (fsx.existsSync(st.full)) { st.backup = `${st.full}.hq-backup-${tag}`; fsx.renameSync(st.full, st.backup); }
      done.push(st);
      if (st.action !== 'delete') fsx.renameSync(st.temp, st.full);
    }
    for (const st of steps) if (hashNow(st.full) !== (st.action === 'delete' ? null : st.hash)) throw new Error(`반영 뒤 확인 실패: ${st.path}`);
  } catch (error) {
    undo(); cleanupTemps();
    const restored = steps.every(st => hashNow(st.full) === st.before);
    return { applied: [], failed: [{ path: '(반영)', why: error.message }], aborted: true, rolledBack: true, restored };
  }
  for (const st of steps) if (st.backup) fsx.rmSync(st.backup, { force: true });
  return { applied: steps.map(st => ({ path: st.path, action: st.action, ...(st.hash ? { hash: st.hash } : {}) })), failed: [], aborted: false, rolledBack: false };
}

// ── 작업 하나 ───────────────────────────────────────────────────────────────────────────────────────────────────
// execute: 'codex' (a real codex exec step — calls the model) or a function ({ jobId, dir, run }) → { code, output }
// that runs something else in the job (tests use Codex's sandbox alone: no model).
export class CodexIsolatedRunner {
  constructor({ distro = DISTRO, user = RUN_USER, baselineFile = BASELINE_FILE, run = runCommand, execTimeoutMs = 25 * 60_000, snapshot = environmentSnapshot, root = ENGINE_ROOT } = {}) {
    Object.assign(this, { distro, user, baselineFile, run, execTimeoutMs, snapshot, root });
  }

  // trust: 'signed' only when 대장's key is registered and both the baseline and the engine's protected files carry
  // valid signatures; 'unsigned' while no key is registered (the harness may run, production assignment may not).
  async preflight() {
    const snap = await this.snapshot({ distro: this.distro, user: this.user, run: this.run });
    const baseline = readBaseline(this.baselineFile);
    const judged = judgePreflight(snap, baseline);
    const signing = this.signing();
    if (signing.mode === 'enforced') {
      const b = baseline?.items ? checkBaseline({ items: baseline.items, root: this.root }) : { ok: false, problems: ['환경 기준 없음'] };
      const policy = JSON.parse(readFileSync(path.join(this.root, 'architecture-policy.json'), 'utf8'));
      const p = checkProtected({ files: protectedHashes({ root: this.root, policy }), root: this.root });
      judged.problems.push(...b.problems.map(x => `서명 · ${x}`), ...p.problems.map(x => `서명 · ${x}`));
      judged.ok = judged.problems.length === 0;
    }
    return { ...judged, at: Date.now(), trust: signing.mode === 'enforced' && judged.ok ? 'signed' : 'unsigned', signing: signing.mode, snapshot: snap };
  }
  signing() { return { mode: signingMode(this.root) }; }

  // preflight: a result of this.preflight() taken moments ago (at most 60 s, and passed) may be reused, so two jobs can
  // start from the same moment; anything older or failed is checked again.
  async runJob({ projectDir, prompt = '', execute = 'codex', model = null, effort = null, access = 'write', allow = null, apply = true, jobId = null, onTiming = null, preflight = null }) {
    const t = {}, mark = (name, since) => { t[name] = Date.now() - since; onTiming?.(name, t[name]); };
    let start = Date.now();
    const pre = preflight?.ok && Date.now() - (preflight.at ?? 0) <= 60_000 ? preflight : await this.preflight();
    mark('preflight', start);
    if (!pre.ok) return { outcome: 'blocked', problems: pre.problems, trust: pre.trust, timings: t };
    const dir = checkProjectFolder(projectDir);
    const id = jobId ?? `j-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const cmds = jobCommands({ distro: this.distro, user: this.user, jobId: id });
    start = Date.now();
    const sent = packFolder(dir);
    mark('pack', start);
    try {
      start = Date.now();
      const made = await this.run(cmds.create);
      if (made.code !== 0) return { outcome: 'failed', problems: [`작업 폴더를 만들지 못함: ${made.output.slice(-200)}`], timings: t };
      const copied = await this.run(cmds.copyIn, { input: sent.tar, timeoutMs: 10 * 60_000 });
      if (copied.code !== 0) return { outcome: 'failed', problems: [`복사하지 못함: ${copied.output.slice(-200)}`], timings: t };
      mark('copyIn', start);
      start = Date.now();
      const result = execute === 'codex'
        ? await this.run(wslCodexExec({ distro: this.distro, user: this.user, jobId: id, model, effort, access }), { input: prompt, timeoutMs: this.execTimeoutMs })
        : await execute({ jobId: id, dir: cmds.dir, run: this.run, distro: this.distro, user: this.user });
      mark('execute', start);
      start = Date.now();
      const out = await this.run(cmds.copyOut, { binary: true, timeoutMs: 10 * 60_000 });
      if (out.code !== 0) return { outcome: 'failed', problems: [`돌려받지 못함: ${out.output.slice(-200)}`], timings: t, exec: summarize(result) };
      let returned;
      try { returned = unpackReturn(out.stdout); } catch (error) {
        mark('copyOut', start);
        return { outcome: 'return_rejected', problems: [error.message], names: listNames(out.stdout), timings: t, exec: summarize(result) };
      }
      mark('copyOut', start);
      start = Date.now();
      const current = hashFolder(dir);
      // Same base? The project may have moved since the job was given its copy (another step applied meanwhile).
      const baseMoved = digestOf(current) !== digestOf(sent.hashes);
      const plan = planReturn({ sent, returned, current, allow });
      const applied = apply ? applyPlan(dir, plan) : { applied: [], failed: [] };
      mark('apply', start);
      return { outcome: 'completed', jobId: id, trust: pre.trust, sentDigest: digestOf(sent.hashes), baseMoved, plan: brief(plan), excluded: excludedOf(plan), applied, timings: t, exec: summarize(result), returnedBytes: out.stdout.length, sentBytes: sent.tar.length };
    } finally {
      await this.run(cmds.remove);
    }
  }
}

export const digestOf = hashes => sha256(Object.keys(hashes).sort().map(p => `${p}\0${hashes[p]}`).join('\n'));
const brief = plan => ({ changes: plan.changes.map(c => ({ path: c.path, action: c.action })), conflicts: plan.conflicts.map(({ data, ...c }) => c), rejected: plan.rejected, unchanged: plan.unchanged });
// What a step produced but could not apply (conflicts with content), for the caller to keep — never silently dropped.
export const excludedOf = plan => plan.conflicts.filter(c => c.data).map(c => ({ path: c.path, why: c.why, hash: c.hash, data: c.data }));
function summarize(result) {
  const events = String(result?.output ?? '').split(/\r?\n/).filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const usage = events.filter(e => e.type === 'turn.completed' && e.usage).map(e => e.usage);
  // raw: the tail of the step's own output (test logs for engine checks); kept in memory for the caller, not stored here.
  return { code: result?.code ?? null, answer: finalAnswer(String(result?.output ?? '')), usage, model: reportedModel(String(result?.output ?? '')), raw: String(result?.output ?? '').slice(-8000) };
}

export { jobPath, LINUX_PROFILE, linuxProfileArgs };
