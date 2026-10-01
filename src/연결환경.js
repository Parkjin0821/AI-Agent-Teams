import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { childEnv } from './실행어댑터.js';
import { MISSING_BINS } from './검사도구.js';

// Where each team's work can run, how it is paid for, and whether it is connected on this machine.
// Only official connection paths are listed; statuses come from the tools' own commands.
export const ENVIRONMENTS = [
  { id: 'claude-code', name: 'Claude Code', kind: '구독 CLI', billing: 'Claude 구독', usedBy: ['기획팀', '조사팀', '개발팀', '디자인팀', '정책팀'],
    docs: 'https://code.claude.com/docs/en/cli-usage', how: 'claude auth login' },
  { id: 'codex', name: 'Codex', kind: '구독 CLI', billing: 'ChatGPT 구독', usedBy: ['보안팀', '검증팀'],
    docs: 'https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan', how: 'Codex 앱에서 로그인' },
  { id: 'sandbox', name: '격리 실행 (Codex 샌드박스)', kind: 'Codex 내장 명령', billing: '사용량 없음 (모델을 부르지 않음)', usedBy: ['검증팀'],
    docs: 'https://learn.chatgpt.com/docs/developer-commands?surface=cli',
    note: '엔진이 테스트를 여기서 돌립니다. 이 컴퓨터에서 확인: 프로젝트 폴더 밖 쓰기·홈 폴더 읽기·네트워크 차단.' },
  { id: 'npm-audit', name: 'npm audit (의존성 취약점 조회)', kind: '공식 조회 도구', setting: 'tools.npmAudit', billing: '무료', usedBy: ['보안팀'],
    docs: 'https://docs.npmjs.com/cli/commands/npm-audit',
    note: '켜면 의존성 이름·버전 목록을 npm 공식 저장소(registry.npmjs.org)로 보내 알려진 취약점을 조회합니다.' },
  { id: 'web', name: '웹 검색 · 웹 읽기', kind: 'Claude Code 내장 도구', billing: '구독 안 (추가 비용 없음)', usedBy: ['조사팀'],
    docs: 'https://code.claude.com/docs/en/tools-reference' },
  { id: 'figma', name: 'Figma', kind: 'claude.ai 커넥터', connector: 'Figma', setting: 'design.figma', billing: 'Figma 계정', usedBy: ['디자인팀'],
    docs: 'https://help.figma.com/hc/en-us/articles/39888612464151-Claude-Code-and-Figma-Set-up-the-MCP-server',
    note: '켜면 디자인팀이 대장의 Figma 계정에 파일을 만들 수 있습니다.' },
  { id: 'canva', name: 'Canva', kind: 'claude.ai 커넥터', connector: 'Canva', setting: 'design.canva', billing: 'Canva 계정', usedBy: ['디자인팀'],
    docs: 'https://www.canva.com/help/mcp-agent-setup/', note: '켜면 디자인팀이 대장의 Canva 계정에 디자인을 만들 수 있습니다.' },
  { id: 'higgsfield', name: 'Higgsfield (이미지·영상 생성)', kind: 'claude.ai 커넥터', connector: 'higgsfield', setting: 'design.higgsfield',
    billing: 'Higgsfield 크레딧 소모', usedBy: ['디자인팀'], docs: 'https://higgsfield.ai/mcp', note: '켜면 이미지·영상을 만들 때마다 크레딧이 쓰입니다.' },
  { id: 'perplexity', name: 'Perplexity API', kind: '종량제 API', key: 'PERPLEXITY_API_KEY', billing: '쓴 만큼 과금', usedBy: ['조사팀 (예정)'],
    docs: 'https://docs.perplexity.ai/docs/sonar/quickstart', note: '키를 넣고 월 상한을 정해야 연결합니다. 연결 기능은 아직 없습니다.' },
  { id: 'openai-images', name: 'OpenAI 이미지 API', kind: '종량제 API', key: 'OPENAI_API_KEY', billing: '쓴 만큼 과금 (이미지당 약 $0.02~$0.19)',
    usedBy: ['디자인팀 (예정)'], docs: 'https://developers.openai.com/api/docs/pricing',
    note: '종량제 이미지 API는 차단합니다. 구독 이미지 생성은 이 엔진에 아직 연결되지 않았으며, 수동 생성 결과를 사용할 수 있습니다.' },
  { id: 'midjourney', name: 'Midjourney', kind: '연결 불가', billing: '—', usedBy: [], unavailable: true,
    docs: 'https://docs.midjourney.com/hc/en-us', note: '공식 API가 없고 자동화는 이용약관으로 금지되어 연결하지 않습니다.' },
];

// Settings 대장 can change from the dashboard. Design connectors are off until turned on.
export const SETTINGS = Object.freeze({
  'design.figma': { type: 'boolean', default: false },
  'design.canva': { type: 'boolean', default: false },
  'design.higgsfield': { type: 'boolean', default: false },
  'tools.npmAudit': { type: 'boolean', default: false },
  // Steps per project per day (all projects). Usage stops (5h 20% / weekly 10%) still apply on top.
  'limits.maxRoundsPerDay': { type: 'number', default: 10, min: 1, max: 100 },
  // 한도 자동 전환: a step whose tool hit its usage stop runs on the other subscription when that one has room.
  'limits.autoSwitch': { type: 'boolean', default: true },
  // 제어팀: teams with no model pick get a model and reasoning level sized to the work.
  'models.auto': { type: 'boolean', default: true },
  // 완료 보고서: the engine writes a report (and 한글 document) when a team project finishes.
  'reports.auto': { type: 'boolean', default: true },
  // 병렬 작업: planning may start one independent lane beside the main work (its own folder).
  'parallel.enabled': { type: 'boolean', default: true },
  // 권한 모드: 'auto' (알아서) — no 신뢰 쌓기 reviews and public https sites open without asking; 'careful' (꼼꼼히) —
  // sentinel.web and trust.required below apply. Either way the fixed safety rules, 대장 규칙, criteria approval and
  // delete/share/publish/send/payment tool actions still stop for 대장. A project can override it (model policy).
  'permissions.mode': { type: 'string', default: 'auto', values: ['auto', 'careful'] },
  // 감시 에이전트: 'ask' — a public site needs 대장's approval before a team opens it; 'open' — any public https site.
  'sentinel.web': { type: 'string', default: 'ask', values: ['ask', 'open'] },
  // 신뢰 쌓기: how many results of each kind of work 대장 reviews before it runs on its own (0 = off).
  'trust.required': { type: 'number', default: 3, min: 0, max: 10 },
  // 정기 요약: written by the engine from its own records (no model call). Time is local "HH:MM".
  'digest.time': { type: 'string', default: '09:00', pattern: /^([01]\d|2[0-3]):[0-5]\d$/ },
  'digest.daily': { type: 'boolean', default: true },
  'digest.weekly': { type: 'string', default: 'mon', values: ['off', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
  // Largest file 대장 can attach in the project conversation (MB).
  'attach.maxMB': { type: 'number', default: 30, min: 1, max: 100 },
});

export function validateSetting(key, value) {
  const spec = SETTINGS[key];
  if (!spec) throw new Error(`unknown setting: ${key}`);
  if (typeof value !== spec.type) throw new Error(`${key} must be a ${spec.type}`);
  if (spec.type === 'number' && (!Number.isInteger(value) || value < spec.min || value > spec.max)) throw new Error(`${key} must be a whole number from ${spec.min} to ${spec.max}`);
  if (spec.values && !spec.values.includes(value)) throw new Error(`${key} must be one of ${spec.values.join(', ')}`);
  if (spec.pattern && !spec.pattern.test(value)) throw new Error(`${key} has the wrong format`);
  if (key === 'design.higgsfield' && value === true) throw new Error('subscription-only: paid image credits are blocked');
  return value;
}

// "claude.ai Figma: https://mcp.figma.com/mcp - ✔ Connected" → { name: 'Figma', status: 'connected' }
export function parseMcpList(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = /^claude\.ai (.+?): \S+ - (.+)$/.exec(line.trim());
    if (!m) continue;
    const status = /connected/i.test(m[2]) && !/needs/i.test(m[2]) ? 'connected' : /auth/i.test(m[2]) ? 'needs-auth' : 'other';
    out.push({ name: m[1], status });
  }
  return out;
}

export function designConnectors(snapshot, settings) {
  const connected = new Set((snapshot?.connectors ?? []).filter(c => c.status === 'connected').map(c => c.name));
  return ENVIRONMENTS.filter(e => e.id !== 'higgsfield' && e.connector && settings?.[e.setting] === true && connected.has(e.connector)).map(e => e.connector);
}

export function environmentView(snapshot, settings = {}) {
  return ENVIRONMENTS.map(env => {
    let statusL = '확인 전', tone = 'idle', enabled = null;
    if (env.key || env.id === 'higgsfield') { statusL = '구독 전용 정책으로 차단'; tone = 'stop'; enabled = false; }
    else if (env.unavailable) { statusL = '연결 불가'; tone = 'stop'; }
    else if (snapshot) {
      if (env.id === 'claude-code' || env.id === 'codex') {
        const s = snapshot[env.id === 'codex' ? 'codex' : 'claude'];
        [statusL, tone] = !s?.installed ? ['설치 안 됨', 'stop'] : s.loggedIn ? ['연결됨', 'done'] : ['로그인 필요', 'attn'];
      } else if (env.id === 'sandbox') {
        [statusL, tone] = snapshot.sandbox?.available ? ['사용 가능', 'done'] : ['쓸 수 없음 · 테스트 실행 안 함', 'attn'];
      } else if (env.id === 'npm-audit') {
        enabled = settings[env.setting] === true;
        [statusL, tone] = enabled ? ['켜짐 · 보안팀 사용', 'done'] : ['꺼짐', 'idle'];
      } else if (env.id === 'web') {
        [statusL, tone] = snapshot.claude?.loggedIn ? ['사용 가능', 'done'] : ['Claude Code 로그인 필요', 'attn'];
      } else if (env.connector) {
        const c = (snapshot.connectors ?? []).find(x => x.name === env.connector);
        enabled = settings[env.setting] === true;
        if (!c) [statusL, tone] = ['claude.ai에 연결 안 됨', 'idle'];
        else if (c.status !== 'connected') [statusL, tone] = ['claude.ai 인증 필요', 'attn'];
        else [statusL, tone] = [enabled ? '연결됨 · 디자인팀 사용' : '연결됨 · 꺼짐', enabled ? 'done' : 'idle'];
      } else if (env.key) {
        [statusL, tone] = snapshot.apiKeys?.[env.key] ? ['API 키 있음 · 연결 준비 중', 'wait'] : ['API 키 없음', 'idle'];
      }
    }
    return { ...env, statusL, tone, enabled };
  });
}

// Runs the tools' own status commands. Never reads API key values — only whether they are set.
export class EnvironmentMonitor {
  constructor({ bins, run = runCommand, env = process.env, clock = { now: () => Date.now() } }) {
    Object.assign(this, { bins, run, env, clock, snapshot: null, pending: null });
  }

  refresh() {
    this.pending ??= this.collect().finally(() => { this.pending = null; });
    return this.pending;
  }

  async refreshAuthentication() {
    const base = childEnv(this.env);
    const call = async (bin, args) => {
      try { return await this.run(bin.file, [...bin.prefix, ...args], base); }
      catch { return { code: -1, stdout: '' }; }
    };
    const [claude, codex] = await Promise.all([
      call(this.bins.claude, ['auth', 'status']), call(this.bins.codex, ['login', 'status']),
    ]);
    let auth = {};
    try { auth = JSON.parse(claude.stdout); } catch {}
    const checkedAt = new Date(this.clock.now()).toISOString();
    this.snapshot = { ...this.snapshot,
      claude: { installed: claude.code !== -1, loggedIn: auth.loggedIn === true,
        subscription: claude.code === 0 && auth.loggedIn === true && auth.authMethod === 'claude.ai', checkedAt },
      codex: { installed: codex.code !== -1, loggedIn: codex.code === 0 && /logged in/i.test(`${codex.stdout}\n${codex.stderr ?? ''}`),
        subscription: codex.code === 0 && /logged in using ChatGPT/i.test(`${codex.stdout}\n${codex.stderr ?? ''}`), checkedAt },
    };
    return this.snapshot;
  }

  async collect() {
    const base = childEnv(this.env);
    const call = (bin, args, extra = {}) => this.run(bin.file, [...bin.prefix, ...args], { ...base, ...extra }).catch(() => ({ code: -1, stdout: '' }));
    const lookup = (name) => this.run(process.platform === 'win32' ? 'where.exe' : 'which', [name], base).catch(() => ({ code: -1 }));
    const [auth, mcp, codex, sandbox, ...found] = await Promise.all([
      call(this.bins.claude, ['auth', 'status']),
      call(this.bins.claude, ['mcp', 'list'], { ENABLE_CLAUDEAI_MCP_SERVERS: 'true' }),
      call(this.bins.codex, ['login', 'status']),
      // A harmless program run inside the sandbox: it must start and print its marker.
      call(this.bins.codex, ['sandbox', '-P', ':workspace', '-C', tmpdir(), '--', process.execPath, '-e', 'process.stdout.write("AGENT_HQ_SANDBOX_OK")']),
      ...MISSING_BINS.map(lookup),
    ]);
    let claudeAuth = {};
    try { claudeAuth = JSON.parse(auth.stdout); } catch { /* not logged in or not installed */ }
    this.snapshot = {
      checkedAt: new Date(this.clock.now()).toISOString(),
      claude: { installed: auth.code !== -1, loggedIn: claudeAuth.loggedIn === true,
        subscription: claudeAuth.loggedIn === true && claudeAuth.authMethod === 'claude.ai' },
      // codex prints its login status on stderr
      codex: { installed: codex.code !== -1, loggedIn: codex.code === 0 && /logged in/i.test(`${codex.stdout}\n${codex.stderr ?? ''}`),
        subscription: codex.code === 0 && /logged in using ChatGPT/i.test(`${codex.stdout}\n${codex.stderr ?? ''}`) },
      connectors: parseMcpList(mcp.stdout),
      sandbox: { available: sandbox.code === 0 && String(sandbox.stdout).includes('AGENT_HQ_SANDBOX_OK') },
      programs: Object.fromEntries(MISSING_BINS.map((bin, i) => [bin, found[i].code === 0])),
      apiKeys: { PERPLEXITY_API_KEY: Boolean(this.env.PERPLEXITY_API_KEY), OPENAI_API_KEY: Boolean(this.env.OPENAI_API_KEY) },
    };
    return this.snapshot;
  }
}

export function runCommand(file, args, env, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    const child = spawn(file, args, { env, shell: false, windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', c => { if (stdout.length < 200_000) stdout += c; });
    child.stderr.setEncoding('utf8').on('data', c => { if (stderr.length < 20_000) stderr += c; });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: '' }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
