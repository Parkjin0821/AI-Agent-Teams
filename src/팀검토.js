import { createHash } from 'node:crypto';
import { clipTask } from './팀.js';
const EFFECTS = ['install', 'publish', 'payment', 'credentials', 'delete', 'external_write'];
export function taskProfile(input = {}) {
  return { complexity: ['simple', 'normal', 'complex'].includes(input.complexity) ? input.complexity : 'normal',
    risk: ['low', 'normal', 'high'].includes(input.risk) ? input.risk : 'normal',
    effects: EFFECTS.filter(e => Array.isArray(input.effects) && input.effects.includes(e)),
    ...(typeof input.taskType === 'string' && ['planning','coding','research','ui','image','connector','security','policy','verification'].includes(input.taskType) ? { taskType: input.taskType } : {}),
    ...(typeof input.evalTaskId === 'string' && typeof input.conditionsKey === 'string' ? { evalTaskId: input.evalTaskId.slice(0,100), conditionsKey: input.conditionsKey.slice(0,100) } : {}),
    ...(Array.isArray(input.requiredCapabilities) ? { requiredCapabilities: input.requiredCapabilities.filter(c => typeof c === 'string' && c.length > 0 && c.length <= 50).slice(0,10) } : {}),
    ...(typeof input.proposedModel === 'string' ? { proposedModel: input.proposedModel.slice(0,100), proposalReason: String(input.proposalReason ?? '').slice(0,500) } : {}) };
}
export function requiredReviews(worker, requested = []) {
  return ['security', 'policy'].filter(r => ['dev', 'design', 'research'].includes(worker) || requested.includes(r));
}
// 반복 검토 생략 (자율 시험 2026-10-02: every fix ran security AND policy again, plan → worker → security → policy → qa,
// five steps a round, and a slides project spent the day's steps in three rounds; telling planning not to call them
// did not help, since every worker step adds both). A review team is skipped when its latest review of this goal
// passed (pass, or issues that did not block, fully checked, no question for 대장) and nothing changed since in its
// field, judged from the engine's own snapshots: the one the review started from against the newest one.
//   security: dependency files, config/secret-like names, a network call added to code
//   policy: dependency files, a network call added, a personal-data pattern added, anything under attachments/ or sources/
// Returns the note for the thread, or null when the review must run. No usable snapshot means it runs.
const DEPENDENCY = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|Gemfile|go\.(mod|sum)|Cargo\.toml|\.npmrc|\.yarnrc[^/]*)$|(^|\/)[^/]*([-.]lock(\.[^/]+)?|\.lockb?)$/i;
const CONFIG = /(^|\/)(\.env[^/]*|[^/]*\.config\.[^/]+|[^/]*(settings|credential|secret|passw|api[_-]?key|access[_-]?token|private[_-]?key|설정|비밀|인증|계정)[^/]*|[^/]*\.(pem|key|p12|pfx))$/i;
const REVIEW_NAME = { security: ['보안팀', '보안'], policy: ['정책팀', '정책'] };
const usable = s => Boolean(s?.signatures && s.signals && Array.isArray(s.files) && s.files.length < 2000);
export function reviewSkip(runs, team, { sourcesSaved = false } = {}) {
  if (!REVIEW_NAME[team]) return null;
  const at = (runs ?? []).findLastIndex(r => r.team === team && r.review);
  if (at < 0) return null;
  const v = runs[at].review;
  if (v.blocking || v.needsDecision || v.checked !== 'done' || !['pass', 'issues'].includes(v.verdict)) return null;
  const from = runs[at].checkpoint?.before, to = runs.slice(at).findLast(r => r.checkpoint?.after)?.checkpoint.after;
  if (!usable(from) || !usable(to)) return null;
  const changed = [...new Set([...Object.keys(from.signatures), ...Object.keys(to.signatures)])].filter(f => from.signatures[f] !== to.signatures[f]);
  const rose = (f, i) => (to.signals[f]?.[i] ?? 0) > (from.signals[f]?.[i] ?? 0);
  const touches = f => DEPENDENCY.test(f) || rose(f, 0)
    || (team === 'security' ? CONFIG.test(f) : rose(f, 1) || /^(attachments|sources)\//.test(f));
  if ((team === 'policy' && sourcesSaved) || changed.some(touches)) return null;
  const [name, area] = REVIEW_NAME[team];
  return `${name} 검토 생략 · ${changed.length ? `이전 통과 뒤 바뀐 파일 ${changed.length}개가 ${area} 영역을 건드리지 않음` : '이전 통과 뒤 바뀐 파일 없음'}`;
}

export function normalizeRequests(raw, from) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 5).flatMap(r => {
    if (!['dev', 'design', 'research'].includes(r?.team) || typeof r.task !== 'string' || !r.task.trim()
      || !Array.isArray(r.criteria) || !r.criteria.length || r.criteria.length > 20
      || r.criteria.some(c => typeof c !== 'string' || !c.trim() || c.length > 500)) return [];
    const task = clipTask(r.task.trim()), criteria = r.criteria.map(c => c.trim());
    const id = createHash('sha256').update(JSON.stringify([r.team, task, criteria])).digest('hex').slice(0, 24);
    return [{ id, from, team: r.team, task, criteria, ...taskProfile(r), status: 'proposed' }];
  });
}
export function enqueueRequests(existing = [], requests = []) {
  const ids = new Set(existing.map(r => r.id));
  return [...existing, ...requests.filter(r => { if (ids.has(r.id)) return false; ids.add(r.id); return true; })].slice(0, 50);
}
