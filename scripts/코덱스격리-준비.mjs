#!/usr/bin/env node
// Codex 격리용 WSL 배포판 준비·확인 (docs/codex-wsl-설치안내.md).
//   node scripts/코덱스격리-준비.mjs              확인만 한다 (아무것도 바꾸지 않음)
//   node scripts/코덱스격리-준비.mjs --provision  배포판 안에 패키지·사용자·설정을 만든다 (대장 승인 후, 배포판 안 root로)
//   node scripts/코덱스격리-준비.mjs --preflight        Codex 실행 전 점검: 규칙 + 승인된 기준과 비교 (실행기와 같은 판정)
//   node scripts/코덱스격리-준비.mjs --record-baseline  지금 상태를 승인된 기준으로 기록 (대장 확인 후에만; 규칙 위반이면 거부)
// Windows 관리자 권한이 필요한 일(WSL 설치, 재부팅)과 Codex 로그인은 하지 않는다 — 대장이 직접 한다.
import path from 'node:path';
import { BASELINE_FILE, environmentSnapshot, judgePreflight, readBaseline, writeBaseline } from '../src/코덱스격리실행.js';
import { DISTRO, JOB_ROOT, RUN_USER, WSL_CONF, checkWslConf, runCommand, wslCommand } from '../src/코덱스격리.js';

const CODEX_VERSION = '0.163.0'; // npm @openai/codex, pinned (checked 2026-10-18); engines: node >= 16
const distro = process.env.AGENT_HQ_WSL_DISTRO || DISTRO;
const wsl = (user, argv, opts = {}) => runCommand(wslCommand({ distro, user, argv }), { timeoutMs: opts.timeoutMs ?? 60_000, input: opts.input ?? null });

// Plain ASCII on purpose: it goes through stdin into `sh -s` inside the distro.
const PROVISION = `set -eu
RUN_USER="$1"; CODEX_VERSION="$2"; JOB_ROOT="$3"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates bubblewrap nodejs npm tar
# No privilege-raising helper in this distro: the engine reaches root only with wsl -u root from Windows.
# Debian's sudo refuses removal while root is locked unless told to (checked 2026-10-18).
SUDO_FORCE_REMOVE=yes apt-get purge -y sudo >/dev/null 2>&1 || true
# Empty folders left from the first start (drives were mounted before wsl.conf existed); never a mounted one.
for d in /mnt/c /mnt/d /mnt/e /mnt/wslg; do mountpoint -q "$d" 2>/dev/null || rmdir "$d" 2>/dev/null || true; done
npm install -g --no-fund --no-audit "@openai/codex@$CODEX_VERSION"
id "$RUN_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$RUN_USER"
passwd -l "$RUN_USER" >/dev/null
passwd -l root >/dev/null
for g in sudo wheel adm docker lxd; do gpasswd -d "$RUN_USER" "$g" >/dev/null 2>&1 || true; done
chmod 700 "/home/$RUN_USER"
install -d -o root -g root -m 755 "$(dirname "$JOB_ROOT")"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 700 "$JOB_ROOT"
cat > /etc/wsl.conf <<'HQ_WSL_CONF'
${WSL_CONF}HQ_WSL_CONF
chmod 644 /etc/wsl.conf
echo "sudo group members (should be empty): $(getent group sudo | cut -d: -f4)"
echo "provision done"
`;

async function provision() {
  console.log(`[준비] ${distro} 안에 bubblewrap·node·npm·@openai/codex@${CODEX_VERSION}, 사용자 ${RUN_USER}, ${JOB_ROOT}, /etc/wsl.conf`);
  const r = await wsl('root', ['sh', '-s', '--', RUN_USER, CODEX_VERSION, JOB_ROOT], { input: PROVISION, timeoutMs: 15 * 60_000 });
  console.log(r.output.trim().split('\n').slice(-15).join('\n'));
  if (r.code !== 0) { console.log(`[준비] 실패 (종료 코드 ${r.code})`); process.exit(1); }
  // wsl.conf applies on the next start of the distro.
  await runCommand({ file: 'wsl.exe', args: ['--terminate', distro] });
  console.log(`[준비] ${distro} 를 껐다 켭니다 (wsl.conf 적용). 이어서 확인합니다.\n`);
}

async function windowsProgramRuns() {
  const { readFileSync } = await import('node:fs');
  const exePath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
  const r = await runCommand(wslCommand({ distro, user: RUN_USER, argv: ['sh', '-c', 'f=$(mktemp) && cat > "$f" && chmod 700 "$f" && timeout 20 "$f" >/dev/null 2>&1; rc=$?; rm -f "$f"; echo "rc=$rc"'] }),
    { input: readFileSync(exePath), timeoutMs: 60_000 });
  const rc = /rc=(\d+)/.exec(r.output)?.[1];
  return { ran: rc === '0', note: rc === undefined ? '판정 불가' : `종료 코드 ${rc}` };
}

async function check() {
  const rows = [];
  const add = (ok, what, note = '') => rows.push({ ok, what, note });
  const reach = await wsl('root', ['true']);
  add(reach.code === 0, `배포판 ${distro} 실행`, reach.code === 0 ? '' : 'WSL 또는 배포판이 아직 없음');
  if (reach.code !== 0) return rows;
  const conf = await wsl('root', ['cat', '/etc/wsl.conf']);
  const problems = checkWslConf(conf.output);
  add(!problems.length, '/etc/wsl.conf (드라이브 자동 연결·Windows 프로그램·Windows PATH·GPU 공유 끔)', problems.join(', '));
  const mounts = (await wsl('root', ['sh', '-c', 'mount -t drvfs,9p,virtiofs 2>/dev/null; ls -A /mnt/c 2>/dev/null'])).output.trim();
  add(!mounts, 'Windows 드라이브 연결 없음 (drvfs·9p·virtiofs, /mnt/c 비었거나 없음)', mounts.split(/\r?\n/)[0]);
  // A real Windows program, handed in through stdin: it must not run (the binfmt flag alone says nothing).
  const exe = await windowsProgramRuns();
  add(!exe.ran, 'Windows 프로그램 실행 안 됨 (whoami.exe 실제 실행 시험)', exe.note);
  add((await wsl(RUN_USER, ['sh', '-c', 'command -v cmd.exe powershell.exe explorer.exe'])).code !== 0, 'PATH에 Windows 프로그램 없음');
  add((await wsl(RUN_USER, ['sudo', '-n', 'true'])).code !== 0, `${RUN_USER}: sudo 없음`);
  add((await wsl('root', ['sh', '-c', 'command -v sudo'])).code !== 0, 'sudo 프로그램 자체가 없음');
  add(/^root\s+L/m.test((await wsl('root', ['passwd', '-S', 'root'])).output), 'root 잠김');
  const groups = (await wsl(RUN_USER, ['id', '-nG'])).output.trim();
  add(!/\b(sudo|wheel|adm|docker|lxd)\b/.test(groups), `${RUN_USER} 그룹에 관리 그룹 없음`, groups);
  const jobs = (await wsl('root', ['stat', '-c', '%U %a', JOB_ROOT])).output.trim();
  add(jobs === `${RUN_USER} 700`, `${JOB_ROOT} 소유·권한 (${RUN_USER} 700)`, jobs);
  const home = (await wsl('root', ['stat', '-c', '%a', `/home/${RUN_USER}`])).output.trim();
  add(home === '700', `/home/${RUN_USER} 권한 700`, home);
  add((await wsl(RUN_USER, ['bwrap', '--version'])).code === 0, 'bubblewrap 설치');
  const node = (await wsl(RUN_USER, ['node', '--version'])).output.trim();
  add(/^v(1[6-9]|[2-9]\d)\./.test(node), 'node 16 이상', node);
  const codex = (await wsl(RUN_USER, ['codex', '--version'])).output.trim();
  add(codex.includes(CODEX_VERSION), `codex ${CODEX_VERSION}`, codex.split('\n').at(-1));
  // Only whether the login is the ChatGPT subscription; the output itself is not shown.
  const login = await wsl(RUN_USER, ['codex', 'login', 'status']);
  const chatgpt = login.code === 0 && /chatgpt/i.test(login.output) && !/api key/i.test(login.output);
  add(chatgpt, 'Codex 로그인 = ChatGPT 구독 (API 키 아님)', chatgpt ? '' : '대장이 직접: codex login --device-auth');
  return rows;
}

if (process.argv.includes('--preflight') || process.argv.includes('--record-baseline')) {
  const snap = await environmentSnapshot({ distro });
  const baseline = readBaseline(BASELINE_FILE);
  if (process.argv.includes('--record-baseline')) {
    const rules = judgePreflight(snap, { items: snap.items ?? {} });
    if (!rules.ok) { console.log(`기준 기록 거부 — 규칙 위반:\n- ${rules.problems.join('\n- ')}`); process.exit(1); }
    const note = process.argv.slice(process.argv.indexOf('--record-baseline') + 1).join(' ') || '대장 확인 후 기록';
    writeBaseline(BASELINE_FILE, snap, note);
    const { signingMode } = await import('../src/승인서명.js');
    if (signingMode() === 'enforced') console.log('대장 서명 키가 등록돼 있어, 이 기준은 서명 전까지 쓰이지 않습니다: node scripts/승인-서명.mjs --request-baseline "목적"');
    if (baseline?.items) console.log(`이전 기준(${baseline.recordedAt})을 바꿨습니다.`);
    console.log(`기준 기록: ${BASELINE_FILE}`);
    process.exit(0);
  }
  const r = judgePreflight(snap, baseline);
  console.log(r.ok ? `✓ 실행 전 점검 통과 (기준 ${baseline.recordedAt})` : `✗ 실행 전 점검 실패 — Codex 실행 중단:\n- ${r.problems.join('\n- ')}`);
  process.exit(r.ok ? 0 : 1);
}
if (process.argv.includes('--provision')) await provision();
const rows = await check();
for (const r of rows) console.log(`${r.ok ? '✓' : '✗'} ${r.what}${r.note ? ` · ${r.note}` : ''}`);
const ok = rows.every(r => r.ok);
console.log(ok ? '\n격리 배포판 준비 확인 통과 — 다음: AGENT_HQ_CODEX_ISOLATION_TEST=wsl 경계 시험' : '\n준비가 끝나지 않았습니다 (✗ 항목)');
process.exit(ok ? 0 : 1);
