import { CLAUDE_CHOICES } from './model-choices.js';

// 제어팀 (AI 없이 엔진이 직접): how heavy a model each step needs, from what the planning team itself reported about
// the work (complexity, risk) and how it has gone so far. Only models and reasoning levels from each tool's official
// list are used (Claude Code: model-config docs; Codex: this account's app-server list). A team 대장 picked a model
// for keeps that pick; this only fills in teams with no pick.
// Codex models by this account's own list descriptions (read 2026-09-30): GPT-6-Luna "Fast and affordable model for
// easier tasks", GPT-6.1-Sol "Latest workhorse model for coding and everyday work.", GPT-6-Astra "Frontier intelligence for the most
// demanding work". Astra is never picked automatically: on a Plus plan it uses the weekly allowance too fast (대장).
// 대장's ranges: Luna at medium–high, Sol at low–medium; Sonnet 5.5 at high (가벼움) and xhigh (보통), since its usage
// barely differs between reasoning levels (대장).
export const LEVELS = Object.freeze([
  { id: 'light', label: '가벼움', claude: { model: 'claude-sonnet-5-5', effort: 'high' }, codex: { model: 'gpt-6-luna', effort: 'medium' } },
  { id: 'normal', label: '보통', claude: { model: 'claude-sonnet-5-5', effort: 'xhigh' }, codex: { model: 'gpt-6-luna', effort: 'high' } },
  { id: 'deep', label: '깊게', claude: { model: 'claude-opus-5-5', effort: 'high' }, codex: { model: 'gpt-6.1-sol', effort: 'low' } },
  { id: 'max', label: '최고', claude: { model: 'claude-fable-5-1', effort: 'high' }, codex: { model: 'gpt-6.1-sol', effort: 'medium' } },
]);
const REVIEWERS = ['plan', 'security', 'policy', 'qa'];

// profile: the planning team's { complexity, risk } for this cycle (none before the first plan).
export function levelFor({ team, profile = null, failures = 0 }) {
  const complexity = profile?.complexity ?? 'normal', risk = profile?.risk ?? 'normal';
  let n = complexity === 'simple' ? 0 : complexity === 'complex' ? 2 : 1;
  const why = [complexity === 'simple' ? '간단한 작업' : complexity === 'complex' ? '복잡한 작업' : '보통 작업'];
  if (!profile) why[0] = '계획 전이라 보통으로';
  if (risk === 'high' && n < 2) { n = 2; why.push('위험도 높음'); }
  // Planning, reviews and verification judge other work: never below "보통".
  if (REVIEWERS.includes(team) && n < 1) { n = 1; why.push('판단하는 팀이라 보통 이상'); }
  if (failures >= 2) { n = Math.min(3, n + 1); why.push(`진전 없음·실패 ${failures}번이라 한 단계 올림`); }
  return { ...LEVELS[n], why: why.join(' · ') };
}

// The model and reasoning level for one step on one tool, or null when the tool's list is not known yet.
// codexModels: this account's Codex list [{ id, isDefault, efforts }]. A level's Codex model that the account does not
// list gives no choice (the step then runs as if 제어팀 were off), never a guessed substitute.
export function levelChoice(executor, level, { codexModels = [] } = {}) {
  if (executor === 'claude-code') {
    const m = CLAUDE_CHOICES.models.find(x => x.id === level.claude.model);
    if (!m || !m.efforts.includes(level.claude.effort)) return null;
    return { model: m.id, effort: level.claude.effort };
  }
  const m = codexModels.find(x => x.id === level.codex.model);
  if (!m || !m.efforts?.length) return null;
  const order = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  const want = order.indexOf(level.codex.effort);
  // The listed level closest to the wanted one, preferring the lighter side.
  const effort = [...m.efforts].sort((a, b) => Math.abs(order.indexOf(a) - want) - Math.abs(order.indexOf(b) - want)
    || order.indexOf(a) - order.indexOf(b))[0];
  return { model: m.id, effort };
}
