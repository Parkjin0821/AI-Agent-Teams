import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { readClaudeUsage, readUsage } from './usage.js';

// Runs on its own: no Claude Code chat or Codex app has to stay open. The teams call the installed CLIs.
//   PORT                   default 4311
//   AGENT_HQ_ENABLE_EXEC=1 real execution (otherwise simulation)
//   AGENT_HQ_DATA_DIR      database folder, default data/ (relative paths are from the repo root)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sharedData = path.join(root, 'data');
const dataDir = process.env.AGENT_HQ_DATA_DIR ? path.resolve(root, process.env.AGENT_HQ_DATA_DIR) : sharedData;
// Claude's usage from the terminal status line is always written to <repo>/data; limit states reported by this
// server's own team runs live in its own data folder.
const usageReader = dataDir === sharedData ? readUsage : async () => {
  const usage = await readUsage(sharedData);
  const own = await readClaudeUsage(dataDir);
  const claude = usage.items.find(i => i.provider === 'claude');
  if (claude) claude.limitStatus = own.limitStatus;
  return usage;
};
const executing = process.env.AGENT_HQ_ENABLE_EXEC === '1';
const app = createApp({
  root,
  dataDir,
  projectsDir: path.join(root, 'projects'),
  enableExec: executing,
  tickMs: 30_000,
  detectEnvironments: true,
  usageReader,
});

const port = Number(process.env.PORT || 4311);

// 서버 기록: start and every way this process ends, so a stop can be explained afterwards. Windows sends SIGHUP when
// the server window is closed, SIGINT for Ctrl+C and SIGBREAK for Ctrl+Break; a crash is logged with its stack.
// A process killed from outside (Task Manager, taskkill) leaves a start line with no end line.
const logFile = path.join(dataDir, 'server.log');
mkdirSync(dataDir, { recursive: true });
const log = (line) => { try { appendFileSync(logFile, `${new Date().toISOString()} [pid ${process.pid}] ${line}\n`); } catch { /* the log never stops the server */ } };
log(`시작 · port ${port} · ${executing ? '실제 실행' : '모의 실행'} · node ${process.version}`);
for (const [signal, why] of [['SIGHUP', '서버 창이 닫힘'], ['SIGINT', 'Ctrl+C로 멈춤'], ['SIGBREAK', 'Ctrl+Break로 멈춤'], ['SIGTERM', '종료 요청을 받음']]) {
  process.on(signal, () => { log(`종료 · ${why} (${signal})`); process.exit(0); });
}
process.on('uncaughtException', (error) => { log(`종료 · 처리되지 않은 오류: ${String(error?.stack ?? error).slice(0, 2000)}`); process.exit(1); });
process.on('unhandledRejection', (error) => { log(`처리되지 않은 비동기 오류 (계속 동작): ${String(error?.stack ?? error).slice(0, 2000)}`); });
process.on('exit', (code) => log(`끝 · 종료 코드 ${code}`));
app.server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`포트 ${port}를 이미 다른 프로그램이 쓰고 있습니다. AGENT HQ가 이미 켜져 있다면 http://localhost:${port} 를 여세요.`);
    process.exit(1);
  }
  throw error;
});
app.server.listen(port, '127.0.0.1', () => console.log(`AGENT HQ ${executing ? '(실제 실행)' : '(모의 실행)'} http://localhost:${port} · 데이터 ${path.relative(root, dataDir) || '.'}`
  + '\n이 창을 닫으면 AGENT HQ가 꺼집니다. 최소화해 두면 계속 동작합니다.'));
