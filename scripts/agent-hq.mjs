// AGENT HQ server control (real execution, http://localhost:4314, data in data/real-test).
//   node scripts/agent-hq.mjs start [--no-open]   start in the background (no window) and open the page once
//   node scripts/agent-hq.mjs stop                stop it
//   node scripts/agent-hq.mjs restart [--force]   stop and start again without opening a page; refuses while a
//                                                 team step is running unless --force
//   node scripts/agent-hq.mjs status
// The server runs with no console window of its own; its output goes to data/real-test/server-output.log and every
// start and end to data/real-test/server.log. start-agent-hq.cmd / stop-agent-hq.cmd call this script.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4314, URL_ = `http://localhost:${PORT}`;
const dataDir = path.join(root, 'data', 'real-test');
const pidFile = path.join(dataDir, 'server.pid');
const [command = 'start', ...flags] = process.argv.slice(2);
const has = f => flags.includes(f);
const say = m => console.log(m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function up() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/engine`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
}
function serverPid() {
  try { const pid = Number(readFileSync(pidFile, 'utf8').trim()); process.kill(pid, 0); return pid; } catch { return null; }
}
function logLine(pid, text) {
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(path.join(dataDir, 'server.log'), `${new Date().toISOString()} [pid ${pid ?? '-'}] ${text}\n`);
}
function openPage() {
  spawn('cmd.exe', ['/c', 'start', '""', URL_], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
// Team steps running right now, read from the database itself (the web page may be down).
async function runningSteps() {
  const db = path.join(dataDir, 'hq.sqlite');
  if (!existsSync(db)) return 0;
  const { DatabaseSync } = await import('node:sqlite');
  const conn = new DatabaseSync(db, { readOnly: true });
  try { return conn.prepare('select body from goals').all().filter(r => JSON.parse(r.body).status === 'running').length; }
  finally { conn.close(); }
}

async function start({ open }) {
  if (await up()) { say('AGENT HQ가 이미 켜져 있습니다.'); if (open) openPage(); return 0; }
  mkdirSync(dataDir, { recursive: true });
  const out = openSync(path.join(dataDir, 'server-output.log'), 'a');
  const child = spawn(process.execPath, ['src/server.js'], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', out, out],
    env: { ...process.env, AGENT_HQ_ENABLE_EXEC: '1', AGENT_HQ_DATA_DIR: path.join('data', 'real-test'), PORT: String(PORT) } });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    if (await up()) { say(`AGENT HQ를 켰습니다 · ${URL_} (창 없이 동작, 끄려면 stop-agent-hq.cmd)`); if (open) openPage(); return 0; }
  }
  say('AGENT HQ를 켜지 못했습니다. data\\real-test\\server-output.log 와 server.log 를 확인하세요.');
  return 1;
}

async function stop(who) {
  const pid = serverPid();
  if (!pid) {
    if (await up()) { say('켜져 있는 AGENT HQ의 프로세스 번호를 찾지 못했습니다 (이전 방식으로 켠 서버일 수 있음). 그 창을 닫아 주세요.'); return 1; }
    say('AGENT HQ가 켜져 있지 않습니다.'); return 0;
  }
  logLine(pid, `종료 · ${who}`);
  try { process.kill(pid); } catch { /* already gone */ }
  for (let i = 0; i < 20 && await up(); i++) await sleep(250);
  say('AGENT HQ를 껐습니다.');
  return 0;
}

let code = 0;
if (command === 'start') code = await start({ open: !has('--no-open') });
else if (command === 'stop') code = await stop('stop-agent-hq로 끔');
else if (command === 'restart') {
  const busy = await runningSteps();
  if (busy && !has('--force')) { say(`팀 단계 ${busy}개가 실행 중이라 다시 켜지 않았습니다. 끝난 뒤 다시 하세요.`); code = 2; }
  else { code = await stop('새 코드 적용을 위해 재시작'); if (code === 0) code = await start({ open: false }); }
} else if (command === 'status') { const ok = await up(); say(ok ? `켜짐 · ${URL_} · pid ${serverPid() ?? '확인 못 함'}` : '꺼짐'); code = ok ? 0 : 1; }
else { say('사용법: node scripts/agent-hq.mjs start|stop|restart|status'); code = 64; }
process.exit(code);
