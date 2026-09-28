import { randomUUID } from 'node:crypto';
import { validateCriteria } from './domain.js';
import { resolveModel, validateExecutor } from './models.js';
import { DEFAULT_POLICY } from './policy.js';
import { validateProjectId } from './workspaces.js';

export const GoalStatus = Object.freeze({
  SCHEDULED: 'scheduled', RUNNING: 'running', RETRY_WAIT: 'retry_wait', VERIFIED: 'verified', MODEL_WAIT: 'model_wait',
  REVIEW_REQUIRED: 'review_required', BLOCKED: 'blocked', RECOVERY_REQUIRED: 'recovery_required',
});
const DUE = [GoalStatus.SCHEDULED, GoalStatus.RETRY_WAIT, GoalStatus.MODEL_WAIT];
const RESUMABLE = [GoalStatus.REVIEW_REQUIRED, GoalStatus.BLOCKED, GoalStatus.RECOVERY_REQUIRED];
const NON_RETRYABLE = ['auth', 'limit', 'permission'];
const iso = ms => new Date(ms).toISOString();

// Drives repeated rounds toward a goal. Time comes only from the injected clock and all state lives in
// SQLite, so the scheduler holds nothing that a restart could lose. It never resumes interrupted work itself.
// The model is resolved only when a round is claimed, i.e. after the previous round's run record (the
// checkpoint) is saved; a policy change during a round therefore takes effect from the next round.
export class GoalScheduler {
  constructor({ store, runner, clock = { now: () => Date.now() }, policy = DEFAULT_POLICY, registry = null }) {
    Object.assign(this, { store, runner, clock, policy, registry });
    for (const goal of store.listGoals().filter(g => g.status === GoalStatus.RUNNING)) {
      for (const run of store.listRuns(goal.id).filter(r => r.status === 'running')) store.saveRun({ ...run, status: 'interrupted' });
      this.update(goal, { status: GoalStatus.RECOVERY_REQUIRED, reason: 'interrupted_by_restart', nextRunAt: null });
      void store.emit({ type: 'goal.recovery_required', goalId: goal.id, round: goal.round });
    }
  }

  addGoal(input) {
    const intervals = { research: this.policy.researchIntervalMs, improvement: this.policy.improvementIntervalMs };
    if (!Object.hasOwn(intervals, input?.kind)) throw new Error('kind must be research or improvement');
    if (!input.objective?.trim()) throw new Error('objective is required');
    if (!input.completionCriteria?.length) throw new Error('Goal requires explicit completion criteria');
    const modelOverride = input.modelOverride ?? { mode: 'inherit' };
    if (!['inherit', 'pinned'].includes(modelOverride.mode) || (modelOverride.mode === 'pinned' && !modelOverride.model)) {
      throw new Error('modelOverride must be inherit or pinned with a model');
    }
    const now = iso(this.clock.now());
    const goal = {
      id: randomUUID(), projectId: validateProjectId(input.projectId ?? 'default'), kind: input.kind,
      executor: validateExecutor(input.executor ?? 'claude-code'),
      modelOverride: modelOverride.mode === 'pinned' ? { mode: 'pinned', model: modelOverride.model } : { mode: 'inherit' },
      activeModel: null,
      objective: input.objective.trim(), completionCriteria: validateCriteria(input.completionCriteria),
      intervalMs: intervals[input.kind], status: GoalStatus.SCHEDULED, reason: null,
      round: 0, attempt: 0, nextRunAt: now, evidence: [],
      testFixAttempts: 0, noProgressRounds: 0, bestCriteriaMet: 0, recentDiffs: [],
      createdAt: now, updatedAt: now,
    };
    this.store.saveGoal(goal);
    void this.store.emit({ type: 'goal.created', goalId: goal.id, projectId: goal.projectId });
    return goal;
  }

  resume(goalId) {
    const goal = this.store.getGoal(goalId);
    if (!goal || !RESUMABLE.includes(goal.status)) throw new Error('goal is not awaiting review or recovery');
    this.update(goal, { status: GoalStatus.SCHEDULED, reason: null, attempt: 0, testFixAttempts: 0,
      noProgressRounds: 0, nextRunAt: iso(this.clock.now()) });
    void this.store.emit({ type: 'goal.resumed', goalId });
    return goal;
  }

  async tick() {
    const now = this.clock.now();
    const runs = this.store.listGoals()
      .filter(g => DUE.includes(g.status) && Date.parse(g.nextRunAt) <= now)
      .map(g => this.claim(g.id, now)).filter(Boolean);
    await Promise.all(runs.map(run => this.execute(run)));
  }

  // Re-checks the goal inside a write transaction; the runs UNIQUE constraint backs this up across processes.
  claim(goalId, now) {
    try {
      return this.store.transaction(() => {
        const goal = this.store.getGoal(goalId);
        if (!goal || !DUE.includes(goal.status) || Date.parse(goal.nextRunAt) > now) return null;
        const model = this.resolveFor(goal);
        if (model.state === 'waiting') {
          // Never swap in another model on our own; wait until the pinned one is usable or fallback is allowed.
          if (goal.status !== GoalStatus.MODEL_WAIT) {
            this.update(goal, { status: GoalStatus.MODEL_WAIT, waitingFrom: goal.status, reason: model.reason });
            void this.store.emit({ type: 'goal.model_wait', goalId, model: model.model, reason: model.reason });
          }
          return null;
        }
        const from = goal.status === GoalStatus.MODEL_WAIT ? goal.waitingFrom : goal.status;
        if (from === GoalStatus.RETRY_WAIT) goal.attempt++;
        else { goal.round++; goal.attempt = 0; }
        const run = this.store.insertRun({ id: randomUUID(), goalId, round: goal.round, attempt: goal.attempt,
          status: 'running', startedAt: iso(now), executor: goal.executor ?? 'claude-code',
          requestedModel: model.model, modelSource: model.source, fallbackFrom: model.fallbackFrom ?? null,
          policyVersion: model.policyVersion });
        this.update(goal, { status: GoalStatus.RUNNING, waitingFrom: null, reason: null });
        return run;
      });
    } catch (error) {
      if (/UNIQUE/.test(error.message)) return null;
      throw error;
    }
  }

  async execute(run) {
    const goal = this.store.getGoal(run.goalId);
    await this.store.emit({ type: 'goal.run_started', goalId: goal.id, round: run.round, attempt: run.attempt });
    let result;
    try {
      result = await this.runner.run(structuredClone(goal),
        { round: run.round, attempt: run.attempt, executor: run.executor, model: run.requestedModel });
    }
    catch (error) { result = { outcome: 'error', errorKind: error.kind }; }
    await this.settle(run, result ?? {});
  }

  async settle(run, result) {
    const now = this.clock.now();
    const goal = this.store.getGoal(run.goalId);
    const evidence = this.evidenceFor(goal, result.evidence);
    // Only the tool's own report says which model actually ran; the requested model is not proof.
    const actualModel = typeof result.model === 'string' && result.model ? result.model : null;
    // Provider messages and logs are not persisted: they may carry secrets and are not evidence.
    this.store.saveRun({ ...run, status: 'finished', finishedAt: iso(now), outcome: result.outcome ?? 'invalid_result',
      errorKind: result.errorKind ?? null, diffHash: result.diffHash ?? null, evidence, actualModel });
    if (goal.status !== GoalStatus.RUNNING) return;
    this.update(goal, { ...this.decide(goal, result, evidence, now), activeModel: actualModel });
    await this.store.emit({ type: `goal.${goal.status}`, goalId: goal.id, round: run.round, reason: goal.reason });
  }

  decide(goal, result, evidence, now) {
    const p = this.policy;
    const review = (reason, extra) => ({ ...extra, status: GoalStatus.REVIEW_REQUIRED, reason, nextRunAt: null });
    if (result.outcome !== 'completed' && result.outcome !== 'test_failed') {
      const kind = result.outcome === 'error' ? result.errorKind : 'invalid_result';
      if (kind === 'network' && goal.attempt < p.retryDelaysMs.length) {
        return { status: GoalStatus.RETRY_WAIT, reason: 'network_error', nextRunAt: iso(now + p.retryDelaysMs[goal.attempt]) };
      }
      if (kind === 'network') return review('network_retries_exhausted');
      if (NON_RETRYABLE.includes(kind)) return { status: GoalStatus.BLOCKED, reason: `${kind}_error`, nextRunAt: null };
      return review('unclassified_error');
    }
    // Progress means more criteria evidenced or a workspace diff not seen before; log volume never counts.
    const diffIsNew = Boolean(result.diffHash) && !goal.recentDiffs.includes(result.diffHash);
    const progressed = evidence.length > goal.bestCriteriaMet || diffIsNew;
    const base = {
      evidence, reason: null, bestCriteriaMet: Math.max(evidence.length, goal.bestCriteriaMet),
      recentDiffs: diffIsNew ? [...goal.recentDiffs, result.diffHash].slice(-20) : goal.recentDiffs,
      noProgressRounds: progressed ? 0 : goal.noProgressRounds + 1,
    };
    if (result.outcome === 'completed' && evidence.length === goal.completionCriteria.length) {
      return { ...base, status: GoalStatus.VERIFIED, nextRunAt: null };
    }
    if (base.noProgressRounds >= p.maxNoProgress) return review('no_progress', base);
    if (result.outcome === 'test_failed') {
      if (goal.testFixAttempts >= p.maxTestFixAttempts) return review('test_fix_exhausted', base);
      return { ...base, status: GoalStatus.SCHEDULED, reason: 'test_fix', testFixAttempts: goal.testFixAttempts + 1, nextRunAt: iso(now) };
    }
    return { ...base, status: GoalStatus.SCHEDULED, testFixAttempts: 0, nextRunAt: iso(now + goal.intervalMs) };
  }

  // Only evidence naming one of the goal's own criteria with a non-empty proof counts.
  evidenceFor(goal, list) {
    const byCriterion = new Map();
    for (const item of Array.isArray(list) ? list : []) {
      if (goal.completionCriteria.includes(item?.criterion) && typeof item.proof === 'string' && item.proof.trim()) {
        byCriterion.set(item.criterion, { criterion: item.criterion, proof: item.proof.trim().slice(0, 2000) });
      }
    }
    return [...byCriterion.values()];
  }

  resolveFor(goal) {
    const executor = goal.executor ?? 'claude-code';
    if (!this.registry) return { state: 'ready', model: null, source: 'executor_default', policyVersion: null };
    const project = this.registry.getPolicy(`project:${goal.projectId}`);
    return { ...resolveModel({ executor, project, task: goal.modelOverride, catalog: this.registry.catalog() }),
      policyVersion: project.version };
  }

  // requested = what the current/last round asked for, actual = what the tool reported, next = what the
  // next round would use. A settings change shows up as changePending, never as a changed actual model.
  modelStatus(goalId) {
    const goal = this.store.getGoal(goalId);
    const run = this.store.listRuns(goalId).at(-1);
    const next = this.resolveFor(goal);
    return { executor: goal.executor ?? 'claude-code', requested: run?.requestedModel ?? null, actual: goal.activeModel ?? null,
      next: next.model, nextState: next.state,
      changePending: Boolean(run) && (next.state !== 'ready' || next.model !== run.requestedModel) };
  }

  update(goal, changes) {
    Object.assign(goal, changes, { updatedAt: iso(this.clock.now()) });
    return this.store.saveGoal(goal);
  }
}
