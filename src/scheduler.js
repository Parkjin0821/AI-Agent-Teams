import { randomUUID } from 'node:crypto';
import { validateCriteria } from './domain.js';
import { DEFAULT_POLICY } from './policy.js';
import { validateProjectId } from './workspaces.js';

export const GoalStatus = Object.freeze({
  SCHEDULED: 'scheduled', RUNNING: 'running', RETRY_WAIT: 'retry_wait', VERIFIED: 'verified',
  REVIEW_REQUIRED: 'review_required', BLOCKED: 'blocked', RECOVERY_REQUIRED: 'recovery_required',
});
const DUE = [GoalStatus.SCHEDULED, GoalStatus.RETRY_WAIT];
const RESUMABLE = [GoalStatus.REVIEW_REQUIRED, GoalStatus.BLOCKED, GoalStatus.RECOVERY_REQUIRED];
const NON_RETRYABLE = ['auth', 'limit', 'permission'];
const iso = ms => new Date(ms).toISOString();

// Drives repeated rounds toward a goal. Time comes only from the injected clock and all state lives in
// SQLite, so the scheduler holds nothing that a restart could lose. It never resumes interrupted work itself.
export class GoalScheduler {
  constructor({ store, runner, clock = { now: () => Date.now() }, policy = DEFAULT_POLICY }) {
    Object.assign(this, { store, runner, clock, policy });
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
    const now = iso(this.clock.now());
    const goal = {
      id: randomUUID(), projectId: validateProjectId(input.projectId ?? 'default'), kind: input.kind,
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
        if (goal.status === GoalStatus.RETRY_WAIT) goal.attempt++;
        else { goal.round++; goal.attempt = 0; }
        const run = this.store.insertRun({ id: randomUUID(), goalId, round: goal.round, attempt: goal.attempt,
          status: 'running', startedAt: iso(now) });
        this.update(goal, { status: GoalStatus.RUNNING });
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
    try { result = await this.runner.run(structuredClone(goal), { round: run.round, attempt: run.attempt }); }
    catch (error) { result = { outcome: 'error', errorKind: error.kind }; }
    await this.settle(run, result ?? {});
  }

  async settle(run, result) {
    const now = this.clock.now();
    const goal = this.store.getGoal(run.goalId);
    const evidence = this.evidenceFor(goal, result.evidence);
    // Provider messages and logs are not persisted: they may carry secrets and are not evidence.
    this.store.saveRun({ ...run, status: 'finished', finishedAt: iso(now), outcome: result.outcome ?? 'invalid_result',
      errorKind: result.errorKind ?? null, diffHash: result.diffHash ?? null, evidence });
    if (goal.status !== GoalStatus.RUNNING) return;
    this.update(goal, this.decide(goal, result, evidence, now));
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

  update(goal, changes) {
    Object.assign(goal, changes, { updatedAt: iso(this.clock.now()) });
    return this.store.saveGoal(goal);
  }
}
