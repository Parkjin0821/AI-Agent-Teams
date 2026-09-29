import { isUsable } from './models.js';

const EXECUTOR_CAPABILITIES = { 'claude-code': ['text','code','web','connectors'], codex: ['text','code'] };
export function selectAssignment({ catalog = [], profile = {}, team, project = {}, override = {}, capacity = null,
  excludeExecutor = null, evaluations = [], runtimeCapabilities = EXECUTOR_CAPABILITIES }) {
  const taskType = profile.taskType || ({ plan: 'planning', dev: 'coding', research: 'research', design: 'ui', security: 'security', policy: 'policy', qa: 'verification' })[team];
  const needs = [...new Set(['text', ...(team === 'research' ? ['web'] : []),
    ...(team === 'dev' || taskType === 'coding' || taskType === 'ui' ? ['code'] : []),
    ...(profile.requiredCapabilities ?? []), ...(taskType === 'image' ? ['image'] : []), ...(taskType === 'connector' ? ['connectors'] : [])])];
  const high = profile.risk === 'high' || profile.complexity === 'complex' || ['security','policy'].includes(team);
  const tier = high ? 2 : profile.complexity === 'simple' ? 0 : 1;
  const desired = high ? 'high' : profile.complexity === 'simple' ? 'low' : 'medium';
  const pin = override.mode === 'pinned' ? override.model : project.mode === 'pinned' ? project.model : null;
  const viable = catalog.filter(e => isUsable(e) && e.executor !== excludeExecutor
    && (!pin || e.id === pin || project.allowFallback === true)
    && Number.isInteger(e.tier) && e.tier >= tier && Array.isArray(e.efforts) && e.efforts.includes(desired)
    && Array.isArray(e.capabilities) && needs.every(c => e.capabilities.includes(c) && runtimeCapabilities[e.executor]?.includes(c))
    && (!capacity || capacity(e.executor)));
  const candidates = viable.map(e => {
    // Compare only project measurements of this exact task and condition set, never public scores.
    const measured = profile.evalTaskId && profile.conditionsKey ? evaluations.filter(r => r.source === 'project'
      && r.model === e.id && r.executor === e.executor && r.evalTaskId === profile.evalTaskId
      && r.conditionsKey === profile.conditionsKey && r.reasoning === desired && r.metrics?.violations === 0
      && Number.isFinite(r.metrics?.criteriaPassRate) && r.metrics.criteriaPassRate >= 0 && r.metrics.criteriaPassRate <= 1) : [];
    return { entry: e, score: measured.length ? measured.reduce((n,r) => n + r.metrics.criteriaPassRate, 0) / measured.length : null,
      samples: measured.length, proposed: e.id === profile.proposedModel };
  });
  candidates.sort((a,b) => (pin ? Number(b.entry.id === pin) - Number(a.entry.id === pin) : 0)
    || Number(b.score !== null) - Number(a.score !== null) || (b.score ?? 0) - (a.score ?? 0)
    || Number(b.proposed) - Number(a.proposed) || a.entry.tier - b.entry.tier
    || a.entry.executor.localeCompare(b.entry.executor) || a.entry.id.localeCompare(b.entry.id));
  const chosen = candidates[0];
  const comparison = candidates.map(c => ({ model: c.entry.id, executor: c.entry.executor, score: c.score, samples: c.samples, proposed: c.proposed }));
  if (!chosen) return { state: 'waiting', model: null, executor: null, effort: null,
    reason: 'no_verified_capable_assignment', taskType, needs, comparison };
  return { state: 'ready', model: chosen.entry.id, executor: chosen.entry.executor, effort: desired,
    source: 'collaborative_assignment', reason: chosen.samples ? 'comparable_project_evaluation' : chosen.proposed ? 'validated_team_proposal' : 'capability_match_no_performance_data',
    proposalReason: profile.proposalReason ?? null, taskType, needs, comparison };
}
