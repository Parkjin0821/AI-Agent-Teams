// 자율 정책 (10차 이후 개편): what a project may do on its own, decided by fixed rules — never by a model. 대장 sets a
// project's autonomy level once (at creation or in its settings); inside it the engine approves what the level allows
// and records every automatic approval with the rule that allowed it (event policy.auto). Everything else still waits
// for 대장. No team can change a level: it is set only through 대장's own screen, and teams cannot reach the engine's
// local address (the Sentinel blocks local addresses).
export const LEVELS = ['L0', 'L1', 'L2', 'L3'];
export const DEFAULT_LEVEL = 'L2';
export const LEVEL_INFO = {
  L0: { name: '수동 관리', short: '모든 승인을 대장이', detail: '완료 조건·결과 확인·처음 여는 사이트까지 대장이 승인합니다 (지금까지의 방식).' },
  L1: { name: '보조 자율', short: '확실한 것만 자동', detail: '완료 조건이 모두 엔진이 증명할 수 있는 것이면 자동 확정하고, 공개 사이트는 바로 엽니다. 결과 확인(신뢰 쌓기)은 그대로.' },
  L2: { name: '감독형 자율', short: '추천 · 검증되면 자동', detail: '엔진 사전 점검을 통과한 완료 조건을 자동 확정하고, 결과 확인 없이 다음 팀으로 넘깁니다. 주관적 판단·질문·위험한 동작만 대장에게.' },
  L3: { name: '확장 자율', short: '검증된 프로젝트용', detail: 'L2 에 더해, 사전 점검에서 남은 점이 있어도 기획팀이 한 번 고쳐 쓴 뒤 자동 확정합니다.' },
};
const rank = level => Math.max(0, LEVELS.indexOf(level));
export const normalizeLevel = level => LEVELS.includes(level) ? level : null;

// kind:
//   criteria — the completion criteria planning derived (ctx.criteria, ctx.issues: the pre-check findings still left,
//              ctx.ownerJudged: how many wait for 대장 by design, ctx.rewritten: planning already rewrote them once)
//   trust    — the 신뢰 쌓기 look at a work team's result
//   web      — opening a public https site for the first time
//   architecture — a change to the multi-model structure (AGENT_HQ_CONSTITUTION.md): never automatic, at any level
//   everything else (question, owner_check, risky_connector, path_rule, external_publish, github, delete, payment,
//   new_permission, policy_change) always waits for 대장, at every level.
// → { decision: 'auto' | 'ask', rule }
export function autonomyDecision(kind, { level, criteria = [], issues = [], ownerJudged = 0, rewritten = false } = {}) {
  // 헌장: checked first and on its own, so no later rule for another kind can ever let it through.
  if (kind === 'architecture') return { decision: 'ask', rule: '핵심 설계 변경 · 항상 대장 승인 (헌장)' };
  const r = rank(normalizeLevel(level) ?? 'L0');
  if (kind === 'criteria') {
    if (!criteria.length) return { decision: 'ask', rule: '완료 조건이 없음' };
    if (r >= 3 && (issues.length === 0 || rewritten)) return { decision: 'auto', rule: issues.length ? 'L3 · 한 번 고쳐 쓴 뒤 자동 확정' : 'L3 · 사전 점검 통과' };
    if (r >= 2 && issues.length === 0) return { decision: 'auto', rule: 'L2 · 사전 점검 통과' };
    if (r >= 1 && issues.length === 0 && ownerJudged === 0) return { decision: 'auto', rule: 'L1 · 모두 엔진이 증명할 수 있는 조건' };
    return { decision: 'ask', rule: r === 0 ? 'L0 · 대장 승인' : issues.length ? '사전 점검에서 남은 점이 있음' : 'L1 · 대장이 판단할 조건이 있음' };
  }
  if (kind === 'trust') return r >= 2 ? { decision: 'auto', rule: `${LEVELS[r]} · 결과 확인 없이 다음 팀으로` } : { decision: 'ask', rule: `${LEVELS[r]} · 신뢰 쌓기 설정대로` };
  if (kind === 'web') return r >= 1 ? { decision: 'auto', rule: `${LEVELS[r]} · 공개 https 사이트` } : { decision: 'ask', rule: 'L0 · 처음 여는 사이트는 승인' };
  return { decision: 'ask', rule: '항상 대장 승인' };
}
