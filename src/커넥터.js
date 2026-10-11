import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCommand, connectorTool } from './실행어댑터.js';
import { TEAMS } from './팀.js';

// 읽기 전용 커넥터: a claude.ai connector a reading team (조사팀·기획팀) may use to search and read only.
// It is connected in the order the skill/connector rule sets (docs/인수인계.md, 안전 경계):
//   발견 (the tools the connector really offers) → 보안·정책 검토 (engine, no model) → 격리 시험 (one real run in an
//   empty folder) → 대장 승인 (승인함) → 연결 (대장 turns it on per team, 팀 page).
// Three locks hold a team to the read tools: --allowedTools names only them, --disallowedTools names every other
// tool of the connector, and the Sentinel denies any MCP tool the step was not given.
export const READ_ONLY_CONNECTORS = Object.freeze({
  notion: Object.freeze({ id: 'notion', connector: 'Notion', name: 'Notion', teams: ['research', 'plan'],
    read: ['notion-search', 'notion-fetch'], what: '대장의 Notion 페이지 검색 · 페이지 읽기',
    docs: 'https://developers.notion.com/docs/mcp' }),
});
const WRITE_WORD = /(create|update|delete|move|duplicate|comment|upload|restore|spawn|send|stop|convert|wait|attach)/i;
const KEY = id => `connector.gate.${id}`;
export const teamKey = (id, team) => `connectors.${id}.${team}`;
const specOf = id => { const s = READ_ONLY_CONNECTORS[id]; if (!s) throw new Error('unknown connector'); return s; };

// 보안·정책 검토: which of the connector's tools are opened (exactly the spec's read tools) and which are blocked.
export function reviewTools(spec, tools) {
  const prefix = `${connectorTool(spec.connector)}__`;
  const mine = [...new Set((tools ?? []).filter(t => String(t).startsWith(prefix)))];
  const allow = spec.read.map(t => prefix + t).filter(t => mine.includes(t));
  const deny = mine.filter(t => !allow.includes(t));
  const missing = spec.read.filter(t => !mine.includes(prefix + t));
  const checks = [
    { id: 'read', ok: !missing.length, text: missing.length ? `읽기 도구가 없음: ${missing.join(', ')}` : `검색·읽기 도구 ${allow.length}개만 엶 (${spec.read.join(', ')})` },
    { id: 'names', ok: allow.every(t => !WRITE_WORD.test(t.slice(prefix.length))), text: '연 도구 이름에 만들기·고치기·댓글 성격 없음' },
    { id: 'blocked', ok: deny.length > 0 || mine.length === allow.length, text: `그 밖의 도구 ${deny.length}개(만들기·고치기·댓글·이동·내려받기 등)는 막음` },
    { id: 'policy', ok: true, text: `${spec.name} 내용은 대장 계정의 Claude 구독 실행 안에서만 읽고, 팀은 필요한 만큼 요약해 작업 폴더에 남김. 외부 게시·전송 도구 없음. 회사 문서는 저장소에 올리지 않음(projects/·data/ 는 저장소 제외)` },
  ];
  return { ok: checks.every(c => c.ok), allow, deny, checks, toolCount: mine.length };
}

// One Claude Code run, reading its event stream: the tools it was offered, the tools it called, refusals.
export function readProbe(stdout) {
  const events = String(stdout || '').split('\n').filter(l => l.startsWith('{')).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const init = events.find(e => e.type === 'system' && e.subtype === 'init');
  const uses = new Map();
  for (const e of events) {
    for (const c of (Array.isArray(e.message?.content) ? e.message.content : [])) {
      if (e.type === 'assistant' && c?.type === 'tool_use') uses.set(c.id, { name: c.name, error: null });
      if (e.type === 'user' && c?.type === 'tool_result' && uses.has(c.tool_use_id)) uses.get(c.tool_use_id).error = c.is_error === true;
    }
  }
  const result = events.find(e => e.type === 'result');
  return { tools: init?.tools ?? [], servers: init?.mcp_servers ?? [], calls: [...uses.values()],
    denials: (result?.permission_denials ?? []).map(d => d.tool_name), ok: result ? !result.is_error : false };
}

function runClaude(command, prompt, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(command.file, command.args, { cwd: command.cwd, env: command.env, shell: false, windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', c => { if (out.length < 4_000_000) out += c; });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, stdout: out }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: out }); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// The real probe: small Haiku runs in an empty temporary folder that is removed afterwards. Nothing the runs read
// is kept — only tool names, counts and whether calls succeeded.
export function cliProbe({ bins, sentinel = null, timeoutMs = 180_000 }) {
  const inTemp = async (fn) => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'hq-connector-'));
    try { return await fn(cwd); } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* temp folder */ } }
  };
  return {
    // 발견: what the connector offers (no tool is opened, so nothing can be called).
    discover: ({ connector, knownConnectors, plugins }) => inTemp(async (cwd) => {
      const command = buildCommand('claude', { cwd, model: 'haiku', access: 'read', bins, knownConnectors, plugins,
        readOnly: [{ name: connector, allow: [], deny: [] }] });
      return readProbe((await runClaude(command, 'Reply with the single word OK. Do not use any tools.', timeoutMs)).stdout);
    }),
    // 격리 시험: the team's real settings (read tools only, the rest denied, Sentinel on) and one search.
    trial: ({ connector, knownConnectors, plugins, allow, deny, search }) => inTemp(async (cwd) => {
      const log = path.join(cwd, '.hq-sentinel.jsonl');
      const command = buildCommand('claude', { cwd, model: 'haiku', access: 'read', bins, knownConnectors, plugins,
        readOnly: [{ name: connector, allow, deny }],
        ...(sentinel ? { sentinel: { ...sentinel, log, project: 'connector-trial', team: 'research', webMode: 'ask' } } : {}) });
      const probe = readProbe((await runClaude(command, `${search} 도구를 정확히 한 번 써서 "AGENT HQ" 를 검색하라. `
        + '찾은 내용은 옮겨 적지 말고 결과 개수만 숫자 하나로 답하라. 다른 도구는 쓰지 않는다.', timeoutMs)).stdout);
      let sentinelLog = [];
      try { sentinelLog = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).map(e => ({ tool: e.tool, decision: e.decision })); } catch { /* no line */ }
      return { ...probe, sentinelLog };
    }),
  };
}

// 격리 시험 판정: the read tools were offered and the search worked; no other tool of the connector was offered.
export function judgeTrial(spec, review, probe) {
  const prefix = `${connectorTool(spec.connector)}__`;
  const offered = probe.tools.filter(t => t.startsWith(prefix));
  const search = review.allow[0];
  const call = probe.calls.find(c => c.name === search);
  const checks = [
    { id: 'offered', ok: review.allow.every(t => offered.includes(t)), text: `읽기 도구 ${review.allow.length}개가 팀에게 보임` },
    { id: 'hidden', ok: offered.every(t => review.allow.includes(t)), text: offered.some(t => !review.allow.includes(t))
      ? `막아야 할 도구가 보임: ${offered.filter(t => !review.allow.includes(t)).map(t => t.slice(prefix.length)).slice(0, 5).join(', ')}` : '만들기·고치기·댓글 도구는 팀에게 보이지 않음' },
    { id: 'search', ok: !!call && call.error === false, text: call ? (call.error ? '검색 호출이 실패함' : '검색 1회 성공 (내용은 저장하지 않음)') : '검색을 호출하지 않음' },
    { id: 'denials', ok: !probe.denials.includes(search), text: probe.denials.length ? `권한 거부 ${probe.denials.length}건` : '권한 거부 없음' },
    { id: 'only', ok: probe.calls.every(c => review.allow.includes(c.name)), text: '읽기 도구 밖의 호출 없음' },
  ];
  return { ok: checks.every(c => c.ok), checks, calls: probe.calls.length };
}

export class ConnectorGate {
  constructor({ store, clock = { now: () => Date.now() }, probe = null, snapshot = () => null, plugins = () => null }) {
    Object.assign(this, { store, clock, probe, snapshot, plugins, busy: new Set() });
  }
  get(id) { specOf(id); return this.store.getSettings()[KEY(id)] ?? null; }
  save(id, state) { this.store.setSetting(KEY(id), state); return state; }
  step(id, state, stage, detail = {}) {
    const at = new Date(this.clock.now()).toISOString();
    return this.save(id, { ...state, stage, updatedAt: at, history: [...(state.history ?? []), { stage, at, ...detail }].slice(-30) });
  }
  connected(spec) { return (this.snapshot()?.connectors ?? []).some(c => c.name === spec.connector && c.status === 'connected'); }

  // 발견 → 검토 → 격리 시험, then the request waits in 승인함. A new check revokes an earlier connection.
  async check(id) {
    const spec = specOf(id);
    if (this.busy.has(id)) throw new Error('connector check already running');
    if (!this.probe) throw new Error('connector checks need real execution');
    if (!this.connected(spec)) throw new Error(`${spec.name} is not connected in claude.ai`);
    const plugins = this.plugins();
    if (!Array.isArray(plugins)) throw new Error('connector check refused: the installed plugin list is unknown or another MCP server would start');
    const knownConnectors = (this.snapshot()?.connectors ?? []).map(c => c.name);
    this.busy.add(id);
    this.offTeams(spec);
    let state = this.save(id, { id, stage: null, history: [], startedAt: new Date(this.clock.now()).toISOString() });
    try {
      const found = await this.probe.discover({ connector: spec.connector, knownConnectors, plugins });
      const prefix = `${connectorTool(spec.connector)}__`;
      const tools = found.tools.filter(t => t.startsWith(prefix));
      if (!tools.length) return this.step(id, state, 'failed', { at_stage: 'discovered', reason: `${spec.name} 도구가 실행에 보이지 않음` });
      state = this.step(id, state, 'discovered', { tools: tools.length });
      const review = reviewTools(spec, tools);
      state = this.step(id, { ...state, review }, review.ok ? 'reviewed' : 'failed', review.ok ? {} : { at_stage: 'reviewed', reason: review.checks.filter(c => !c.ok).map(c => c.text).join(' · ') });
      if (!review.ok) return state;
      const probe = await this.probe.trial({ connector: spec.connector, knownConnectors, plugins, allow: review.allow, deny: review.deny, search: spec.read[0] });
      const trial = { ...judgeTrial(spec, review, probe), sentinel: probe.sentinelLog ?? [] };
      return this.step(id, { ...state, trial }, trial.ok ? 'tested' : 'failed', trial.ok ? {} : { at_stage: 'tested', reason: trial.checks.filter(c => !c.ok).map(c => c.text).join(' · ') });
    } catch (error) {
      return this.step(id, state, 'failed', { reason: String(error.message).slice(0, 300) });
    } finally { this.busy.delete(id); }
  }
  approve(id, { confirm } = {}) {
    const state = this.get(id);
    if (confirm !== true || state?.stage !== 'tested' || !state.trial?.ok) throw new Error('connector approval needs a passed isolated trial');
    return this.step(id, { ...state, approvedAt: new Date(this.clock.now()).toISOString() }, 'connected', { by: '대장' });
  }
  refuse(id, note = '') {
    const state = this.get(id);
    if (state?.stage !== 'tested') throw new Error('no connector request waiting');
    return this.step(id, state, 'refused', { by: '대장', note: String(note ?? '').slice(0, 300) });
  }
  revoke(id) {
    const spec = specOf(id), state = this.get(id);
    if (state?.stage !== 'connected') throw new Error('connector is not connected');
    this.offTeams(spec);
    return this.step(id, state, 'revoked', { by: '대장' });
  }
  offTeams(spec) { for (const team of spec.teams) if (this.store.getSettings()[teamKey(spec.id, team)] === true) this.store.setSetting(teamKey(spec.id, team), false); }
  // 대장 turns a team on only after the connection was approved.
  canTurnOn(key) {
    const m = /^connectors\.([a-z]+)\.([a-z]+)$/.exec(key);
    if (!m) return true;
    const spec = specOf(m[1]);
    if (!spec.teams.includes(m[2])) throw new Error('this team cannot use this connector');
    if (this.get(m[1])?.stage !== 'connected') throw new Error(`${spec.name} 연결이 승인되지 않았습니다`);
    return true;
  }
  // What a team's step gets: [{ name, allow, deny }] for each approved, connected connector 대장 turned on for it.
  readOnlyFor(team) {
    const settings = this.store.getSettings();
    return Object.values(READ_ONLY_CONNECTORS).flatMap(spec => {
      const state = settings[KEY(spec.id)];
      if (state?.stage !== 'connected' || settings[teamKey(spec.id, team)] !== true || !this.connected(spec)) return [];
      return [{ name: spec.connector, label: spec.name, allow: state.review.allow, deny: state.review.deny }];
    });
  }
  view() {
    const settings = this.store.getSettings();
    return Object.values(READ_ONLY_CONNECTORS).map(spec => {
      const state = settings[KEY(spec.id)] ?? null;
      return { id: spec.id, name: spec.name, what: spec.what, docs: spec.docs, read: spec.read, stage: state?.stage ?? null,
        running: this.busy.has(spec.id), available: this.connected(spec), state,
        teams: spec.teams.map(team => ({ team, name: TEAMS[team].name, on: settings[teamKey(spec.id, team)] === true })) };
    });
  }
  requests() { return this.view().filter(v => v.stage === 'tested' && v.state?.trial?.ok); }
}
