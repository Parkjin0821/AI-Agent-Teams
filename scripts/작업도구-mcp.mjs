// AGENT HQ 작업 도구 MCP server (9차 1번). Claude Code starts it for a dev or design step (--mcp-config) and talks
// MCP over stdio: one JSON-RPC message per line. It offers only the fixed tools in src/작업도구.js; the engine picks
// every command, and runs it in the Codex sandbox under Node's permission model. Arguments are at most one file path
// inside the work folder. Each call is logged (tool, ok, time) for the step record; no tool output is logged.
// Environment (set by the engine): AGENT_HQ_WORKSPACE, AGENT_HQ_CODEX_BIN, AGENT_HQ_CODEX_SANDBOX, AGENT_HQ_TESTS_UNCONFINED,
// AGENT_HQ_WORKBENCH_LOG.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const { SandboxRunner } = await import('../src/격리환경.js');
const { VisualChecker } = await import('../src/화면검사.js');
const tools = await import('../src/작업도구.js');

const cwd = process.env.AGENT_HQ_WORKSPACE;
const codexBin = process.env.AGENT_HQ_CODEX_BIN;
const codex = codexBin ? { file: codexBin, prefix: [], ...(process.env.AGENT_HQ_CODEX_SANDBOX ? { windowsSandbox: process.env.AGENT_HQ_CODEX_SANDBOX } : {}) } : null;
const sandbox = codex ? new SandboxRunner({ codex }) : null;
const visualChecker = new VisualChecker({ sandbox });
const used = {};

const send = msg => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const log = entry => { try { if (process.env.AGENT_HQ_WORKBENCH_LOG) appendFileSync(process.env.AGENT_HQ_WORKBENCH_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); } catch { /* logging never breaks a call */ } };

async function call(name, args) {
  if (!cwd) return { ok: false, text: '작업 폴더를 알 수 없음' };
  const spec = tools.WORKBENCH_TOOLS.find(t => t.name === name);
  if (!spec) return { ok: false, text: `없는 도구: ${name}` };
  used[name] = (used[name] ?? 0) + 1;
  if (used[name] > tools.WORKBENCH_BUDGET[name]) return { ok: false, text: `이 단계에서 ${spec.title}는 ${tools.WORKBENCH_BUDGET[name]}번까지 · 남은 것은 결과에 적고 다음 단계에 넘긴다` };
  if (name === 'run_tests') return tools.runTestsTool(cwd, { sandbox, unconfined: process.env.AGENT_HQ_TESTS_UNCONFINED === '1' });
  if (name === 'check_syntax') return tools.checkSyntaxTool(cwd, { sandbox });
  if (name === 'check_page') return tools.checkPageTool(cwd, String(args?.path ?? ''), { visualChecker });
  return tools.listDependenciesTool(cwd);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
      serverInfo: { name: 'agent-hq-workbench', version: '1.0.0' } } });
  }
  if (method === 'tools/list') return send({ id, result: { tools: tools.WORKBENCH_TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })) } });
  if (method === 'tools/call') {
    const started = Date.now();
    let r;
    try { r = await call(params?.name, params?.arguments ?? {}); } catch (e) { r = { ok: false, text: `도구 실행 오류: ${String(e?.message ?? e).slice(0, 200)}` }; }
    log({ tool: params?.name, ok: r.ok, ms: Date.now() - started });
    return send({ id, result: { content: [{ type: 'text', text: r.text }], isError: !r.ok } });
  }
  if (method === 'ping') return send({ id, result: {} });
  if (id !== undefined && id !== null) send({ id, error: { code: -32601, message: `method not found: ${method}` } });
});
