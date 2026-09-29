import { createHash } from 'node:crypto';
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
export function normalizeRequests(raw, from) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 5).flatMap(r => {
    if (!['dev', 'design', 'research'].includes(r?.team) || typeof r.task !== 'string' || !r.task.trim()
      || !Array.isArray(r.criteria) || !r.criteria.length || r.criteria.length > 20
      || r.criteria.some(c => typeof c !== 'string' || !c.trim() || c.length > 500)) return [];
    const task = r.task.trim().slice(0, 1000), criteria = r.criteria.map(c => c.trim());
    const id = createHash('sha256').update(JSON.stringify([r.team, task, criteria])).digest('hex').slice(0, 24);
    return [{ id, from, team: r.team, task, criteria, ...taskProfile(r), status: 'proposed' }];
  });
}
export function enqueueRequests(existing = [], requests = []) {
  const ids = new Set(existing.map(r => r.id));
  return [...existing, ...requests.filter(r => { if (ids.has(r.id)) return false; ids.add(r.id); return true; })].slice(0, 50);
}
