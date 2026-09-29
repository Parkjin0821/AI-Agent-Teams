// Execution tools and models are separate: a team runs a tool (Claude Code / Codex), and the tool runs a model.
// Models are never assumed: an entry is usable only with official support evidence and a check on this account.
export const EXECUTORS = Object.freeze({ 'claude-code': 'Claude Code', codex: 'Codex' });
export const UNVERIFIED_LABEL = '확인 필요';

export function validateExecutor(executor) {
  if (!Object.hasOwn(EXECUTORS, executor)) throw new Error(`unknown executor: ${executor}`);
  return executor;
}

export function isUsable(entry) {
  return Boolean(entry?.supportEvidence?.url && entry.supportEvidence.checkedAt && entry.accountCheckedAt && entry.available !== false);
}

export function formatAssignment({ team, executor, model }) {
  return `${team} · ${EXECUTORS[validateExecutor(executor)]} · ${isUsable(model) ? model.label : UNVERIFIED_LABEL}`;
}

// project: { mode: 'auto'|'pinned', model?, allowFallback?, autoDefaults?: { [executor]: modelId } }
// task:    { mode: 'inherit'|'pinned', model? }
// model: null means "let the tool use its own default" (no --model flag); it is shown as 확인 필요.
export function resolveModel({ executor, project = {}, task, catalog = [], context = {} }) {
  validateExecutor(executor);
  const usable = id => catalog.some(entry => entry.executor === executor && entry.id === id && isUsable(entry));
  const pin = task?.mode === 'pinned' ? { model: task.model, source: 'task_pin' }
    : project.mode === 'pinned' ? { model: project.model, source: 'project_pin' } : null;
  if (pin) {
    if (usable(pin.model)) return { state: 'ready', model: pin.model, source: pin.source };
    if (!project.allowFallback) return { state: 'waiting', reason: 'pinned_model_unavailable', model: pin.model };
    return { ...autoModel(executor, project, usable), fallbackFrom: pin.model };
  }
  if (project.strategy === 'adaptive') {
    const deep = context.critical || context.failures >= 2 || ['security','policy'].includes(context.team);
    const tier = deep ? 2 : context.simple ? 0 : 1;
    const candidates = catalog.filter(e => e.executor === executor && isUsable(e) && Number.isInteger(e.tier)
      && e.tier >= tier && Array.isArray(e.efforts) && e.efforts.length);
    candidates.sort((a,b) => a.tier - b.tier || (b.verifiedPassRate ?? 0) - (a.verifiedPassRate ?? 0) || a.id.localeCompare(b.id));
    const entry = candidates[0];
    if (!entry) return { state: 'waiting', model: null, reason: 'verified_model_profile_required' };
    const desired = deep ? 'high' : context.simple ? 'low' : 'medium';
    const effort = entry.efforts.includes(desired) ? desired : entry.efforts[0];
    return { state: 'ready', model: entry.id, effort, source: 'adaptive', reason: deep ? 'risk_or_repeated_failure' : 'normal_work' };
  }
  return autoModel(executor, project, usable);
}

function autoModel(executor, project, usable) {
  const approved = project.autoDefaults?.[executor];
  return approved && usable(approved)
    ? { state: 'ready', model: approved, source: 'approved_default' }
    : { state: 'ready', model: null, source: 'executor_default' };
}
