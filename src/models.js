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
export function resolveModel({ executor, project = {}, task, catalog = [] }) {
  validateExecutor(executor);
  const usable = id => catalog.some(entry => entry.executor === executor && entry.id === id && isUsable(entry));
  const pin = task?.mode === 'pinned' ? { model: task.model, source: 'task_pin' }
    : project.mode === 'pinned' ? { model: project.model, source: 'project_pin' } : null;
  if (pin) {
    if (usable(pin.model)) return { state: 'ready', model: pin.model, source: pin.source };
    if (!project.allowFallback) return { state: 'waiting', reason: 'pinned_model_unavailable', model: pin.model };
    return { ...autoModel(executor, project, usable), fallbackFrom: pin.model };
  }
  return autoModel(executor, project, usable);
}

function autoModel(executor, project, usable) {
  const approved = project.autoDefaults?.[executor];
  return approved && usable(approved)
    ? { state: 'ready', model: approved, source: 'approved_default' }
    : { state: 'ready', model: null, source: 'executor_default' };
}
