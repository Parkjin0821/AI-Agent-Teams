import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 아키텍처 가드 (AGENT_HQ_CONSTITUTION.md): the multi-model structure — Claude Code and Codex sharing work, reviewing
// each other and handing work over under the engine's control — must not disappear quietly, whoever edits the code.
// Every check loads the real module and calls it (a comment that only mentions Codex proves nothing). It runs in
// `npm test` (test/아키텍처가드.test.js), before each commit (.githooks/pre-commit) and by hand
// (`node scripts/아키텍처-검사.mjs`).
export const POLICY_FILE = 'architecture-policy.json';
export const CONSTITUTION_FILE = 'AGENT_HQ_CONSTITUTION.md';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
// Line endings follow the checkout (git may write CRLF on Windows); the fingerprint is of the text itself.
export const fingerprint = text => createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex');

export function readPolicy(root = ROOT) {
  return JSON.parse(readFileSync(path.join(root, POLICY_FILE), 'utf8'));
}
const loader = root => rel => import(pathToFileURL(path.join(root, ...rel.split('/'))).href);
const today = () => new Date().toISOString().slice(0, 10);

// Each check returns null when the structure is there, or what is missing (Korean, one line).
const CHECKS = [
  ['헌장', '헌장 문서가 있고 정책에 적힌 지문과 같다', async ({ root, policy }) => {
    const file = path.join(root, CONSTITUTION_FILE);
    if (!existsSync(file)) return `${CONSTITUTION_FILE} 이 없다`;
    return fingerprint(readFileSync(file, 'utf8')) === policy.constitution?.sha256 ? null
      : '헌장 내용이 정책의 지문과 다르다 (헌장 변경은 대장이 직접 하고 지문을 갱신한다)';
  }],
  ['실행 도구', 'Claude Code와 Codex 두 실행 도구가 모두 등록돼 있다', async ({ load, policy }) => {
    const { EXECUTORS } = await load('src/모델.js');
    const missing = ['claude-code', 'codex'].filter(e => !EXECUTORS?.[e] || !policy.executors?.includes(e));
    return missing.length ? `실행 도구 ${missing.join(', ')} 가 빠졌다` : null;
  }],
  ['Codex 실행 어댑터', 'Codex로 팀 단계를 실행하는 명령을 만들 수 있다 (격리 샌드박스·사용자 설정 무시)', async ({ load }) => {
    const { buildCommand, CliAgentAdapter } = await load('src/실행어댑터.js');
    const bins = { claude: { file: 'claude', prefix: [] }, codex: { file: 'codex', prefix: [] } };
    const codex = buildCommand('codex', { cwd: 'C:/w', bins });
    const claude = buildCommand('claude', { cwd: 'C:/w', bins });
    if (codex?.file !== 'codex' || codex.args[0] !== 'exec' || !codex.args.includes('--sandbox') || !codex.args.includes('--ignore-user-config')) return 'Codex 실행 명령이 없거나 격리 옵션이 빠졌다';
    if (claude?.file !== 'claude') return 'Claude Code 실행 명령이 없다';
    return typeof CliAgentAdapter === 'function' ? null : '실행 어댑터(CliAgentAdapter)가 없다';
  }],
  ['교차 검토', '검토·검증은 작업한 도구와 다른 도구에게 맡길 수 있다 (excludeExecutor)', async ({ load }) => {
    const { selectAssignment } = await load('src/작업배정.js');
    const catalog = ['claude-code', 'codex'].map((executor, i) => ({ id: `m${i}`, executor, tier: 2, capabilities: ['text', 'code'],
      efforts: ['medium'], available: true, supportEvidence: { url: 'https://example.org', checkedAt: '2026-10-18' }, accountCheckedAt: '2026-10-18' }));
    const toCodex = selectAssignment({ catalog, team: 'qa', excludeExecutor: 'claude-code' });
    const toClaude = selectAssignment({ catalog, team: 'qa', excludeExecutor: 'codex' });
    return toCodex?.executor === 'codex' && toClaude?.executor === 'claude-code' ? null : '작업자와 다른 도구로 검토를 배정하지 못한다';
  }],
  ['모델 수준', '작업 난이도별로 Codex 모델도 고를 수 있다', async ({ load }) => {
    const { LEVELS, levelChoice } = await load('src/모델수준.js');
    if (!LEVELS?.length || LEVELS.some(l => !l.codex?.model)) return '난이도 단계에 Codex 모델이 빠졌다';
    const pick = levelChoice('codex', LEVELS[0], { codexModels: [{ id: LEVELS[0].codex.model, efforts: ['low', 'medium', 'high'] }] });
    return pick?.model === LEVELS[0].codex.model ? null : 'Codex 모델을 고르지 못한다';
  }],
  ['사용량·동시 실행', 'Codex 사용량을 따로 읽고, Codex 몫의 동시 실행 자리가 있다', async ({ load }) => {
    const { readCodexUsage } = await load('src/사용량.js');
    const { DEFAULT_POLICY, STOP_AT_REMAINING_BY } = await load('src/정책.js');
    if (typeof readCodexUsage !== 'function' || !STOP_AT_REMAINING_BY?.codex) return 'Codex 사용량 읽기·중단 기준이 없다';
    return (DEFAULT_POLICY?.providerConcurrent?.codex ?? 0) >= 1 ? null : 'Codex 동시 실행 자리가 0이다';
  }],
  ['도구 간 전환·배정', '스케줄러가 작업을 도구에 배정하고, 한도에 걸리면 다른 도구로 넘기고, 교차 검토를 배정한다', async ({ load }) => {
    const { GoalScheduler } = await load('src/작업스케줄러.js');
    const missing = ['stepExecutor', 'plannedExecutor', 'limitSwitch', 'collaborativeAssignment'].filter(m => typeof GoalScheduler?.prototype?.[m] !== 'function');
    return missing.length ? `스케줄러에서 ${missing.join(', ')} 가 빠졌다` : null;
  }],
  ['작업 인계', '중요한 작업은 Codex로, 막히면 다른 도구로 넘기는 인계가 있다', async ({ load }) => {
    const { chooseProvider, buildHandoff } = await load('src/업무도메인.js');
    if (typeof buildHandoff !== 'function') return '도구 간 인계(buildHandoff)가 없다';
    const both = { claude: 'available', codex: 'available' };
    return chooseProvider({ critical: true }, both) === 'codex' && chooseProvider({ critical: true }, { ...both, codex: 'limited' }) === 'claude'
      ? null : '중요 작업을 Codex로 보내거나 막히면 Claude로 넘기지 못한다';
  }],
  ['격리 실행', 'Codex 격리 샌드박스(엔진 검사용)가 있다', async ({ load }) => {
    const { SandboxRunner } = await load('src/격리환경.js');
    return typeof SandboxRunner === 'function' ? null : '격리 실행기(SandboxRunner)가 없다';
  }],
  ['대장 승인', '핵심 설계 변경은 어떤 자율 수준에서도 자동 승인되지 않는다', async ({ load }) => {
    const { autonomyDecision, LEVELS } = await load('src/자율정책.js');
    const auto = LEVELS.filter(level => autonomyDecision('architecture', { level }).decision !== 'ask');
    return auto.length ? `자율 수준 ${auto.join(', ')} 에서 핵심 설계 변경이 자동 승인된다` : null;
  }],
  ['Codex 실행 상태', 'Codex로 일하는 팀이 없으면 그것은 기록된 "일시 중지"이고 복원 계획이 있다', async ({ load, policy }) => {
    const { TEAMS } = await load('src/팀.js');
    const s = policy.codexTeamExecution ?? {};
    const codexTeams = Object.values(TEAMS ?? {}).filter(t => t.executor === 'codex').length;
    if (!['active', 'suspended'].includes(s.state)) return 'Codex 실행 상태(active | suspended)가 정책에 없다';
    if (!codexTeams && s.state !== 'suspended') return 'Codex로 일하는 팀이 없는데 정책은 active 라고 적혀 있다';
    if (s.state === 'suspended' && (!s.reason || !s.since || !s.restorePlan?.length || !s.reviewBy)) return 'Codex 일시 중지에 이유·시작일·복원 계획·재검토일이 모두 있어야 한다 (영구 제외 금지)';
    return null;
  }],
  ['회귀 테스트', 'Codex 협업 구조를 확인하는 테스트 파일이 있다', async ({ root, policy }) => {
    const missing = (policy.requiredTests ?? []).filter(f => !existsSync(path.join(root, ...f.split('/'))));
    return !policy.requiredTests?.length ? '정책에 필수 테스트 목록이 없다' : missing.length ? `테스트가 없다: ${missing.join(', ')}` : null;
  }],
  ['서명 승인', '대장 서명 키가 등록돼 있으면 보호 파일이 서명 승인된 내용과 같다', async ({ load, root, policy }) => {
    const { signingMode, checkProtected, protectedHashes } = await load('src/승인서명.js');
    if (signingMode(root) !== 'enforced') return null;
    const r = checkProtected({ files: protectedHashes({ root, policy }), root });
    return r.ok ? null : r.problems.join(' / ');
  }],
  ['보호 파일', '헌장·정책·가드·커밋 검사 파일이 있다', async ({ root, policy }) => {
    const missing = (policy.protectedFiles ?? []).filter(f => !existsSync(path.join(root, ...f.split('/'))));
    return !policy.protectedFiles?.length ? '정책에 보호 파일 목록이 없다' : missing.length ? `보호 파일이 없다: ${missing.join(', ')}` : null;
  }],
];
export const CHECK_NAMES = CHECKS.map(([name]) => name);

// → { ok, results: [{ name, about, ok, problem }], warnings }
export async function checkArchitecture({ root = ROOT, policy = null, load = null, now = today() } = {}) {
  let pol = policy;
  try { pol ??= readPolicy(root); } catch (error) {
    return { ok: false, results: [{ name: '정책', about: `${POLICY_FILE} 을 읽는다`, ok: false, problem: `${POLICY_FILE} 을 읽지 못했다: ${error.message}` }], warnings: [] };
  }
  const ctx = { root, policy: pol, load: load ?? loader(root) };
  const results = [];
  for (const [name, about, run] of CHECKS) {
    let problem;
    try { problem = await run(ctx); } catch (error) { problem = `확인 중 오류: ${String(error?.message ?? error).slice(0, 200)}`; }
    results.push({ name, about, ok: !problem, problem: problem ?? null });
  }
  const s = pol.codexTeamExecution ?? {};
  const warnings = s.state === 'suspended' && s.reviewBy && s.reviewBy < now
    ? [`Codex 일시 중지가 재검토일(${s.reviewBy})을 넘겼다 · 격리 환경 복원 진행 상황을 대장에게 보고하고 날짜를 다시 정한다`] : [];
  try {
    const { signingMode } = await ctx.load('src/승인서명.js');
    if (signingMode(root) !== 'enforced') warnings.push('대장 서명 키가 등록되지 않았다 · 보호 파일 승인은 환경변수 표시뿐이라 신원을 보장하지 못한다 (node scripts/승인-서명.mjs --setup)');
  } catch { /* 승인서명.js missing is caught by the protected-file check */ }
  return { ok: results.every(r => r.ok), results, warnings };
}

// 변경 제안 판정: a proposal (a team's lesson, an improvement, a plan) read against the constitution.
//   violation — removes the multi-model structure for good (거부)
//   core      — touches it (pausing Codex, changing model choice, review or hand-off): only with 대장's approval
//   ok        — does not touch it
// Wording rules, not a model: it flags, and the people and the guard above decide.
const CORE = /codex|코덱스|멀티 ?모델|다중 ?모델|두 모델|교차 ?(검증|검토)|독립 ?(검증|검토)|실행 ?어댑터|실행 ?도구|모델 ?(선택|배정)|작업 ?인계|인계 ?구조/i;
const SINGLE = /claude ?(code ?)?(전용|만으로|만 ?(쓰|사용|운영))|claude-only|claude only|단일 ?모델|한 ?모델만|codex ?(없이|빼고|를? ?제외|는? ?쓰지 ?않)|without codex/i;
const REMOVE = /삭제|제거|없애|없앤|폐기|철거|걷어|빼(고|기|자|버)|영구|drop|remov|delet|rip out/i;
const TEMP = /일시|임시|잠시|당분간|한시적|격리|복원|되살|다시 ?(켜|쓰|연결|살)|재개|temporar|restore/i;
export function judgeChange(text) {
  const t = String(text ?? '');
  const single = SINGLE.test(t), touches = single || CORE.test(t);
  if (!touches) return { verdict: 'ok', reasons: [] };
  const removes = single || REMOVE.test(t), temporary = TEMP.test(t) && !/영구/.test(t);
  if (removes && !temporary) {
    return { verdict: 'violation', reasons: [single ? 'Claude 전용·단일 모델로 바꾸는 제안' : '멀티 모델 구조(Codex·교차 검토·인계)를 없애는 제안',
      '헌장 원칙 1·4: Codex 문제는 일시 중지와 격리 환경 복원으로만 다룬다'] };
  }
  return { verdict: 'core', reasons: [removes ? '멀티 모델 구조를 일시적으로 바꾸는 제안 (복원 계획 필요)' : '모델 선택·교차 검토·인계 구조를 건드리는 제안', '핵심 설계 변경 · 대장 승인 필요'] };
}
