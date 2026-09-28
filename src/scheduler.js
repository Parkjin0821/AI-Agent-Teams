import { randomUUID } from 'node:crypto';
import { validateCriteria } from './domain.js';
import { resolveModel, validateExecutor } from './models.js';
import { DEFAULT_POLICY } from './policy.js';
import { nextTeam, TEAMS } from './teams.js';
import { validateProjectId } from './workspaces.js';

export const GoalStatus = Object.freeze({
  SCHEDULED: 'scheduled', RUNNING: 'running', RETRY_WAIT: 'retry_wait', VERIFIED: 'verified', MODEL_WAIT: 'model_wait',
  REVIEW_REQUIRED: 'review_required', BLOCKED: 'blocked', RECOVERY_REQUIRED: 'recovery_required', PAUSED: 'paused',
});
const DUE = [GoalStatus.SCHEDULED, GoalStatus.RETRY_WAIT, GoalStatus.MODEL_WAIT];
const RESUMABLE = [GoalStatus.REVIEW_REQUIRED, GoalStatus.BLOCKED, GoalStatus.RECOVERY_REQUIRED];
const NON_RETRYABLE = ['auth', 'limit', 'permission'];
const iso = ms => new Date(ms).toISOString();
const nextMidnight = ms => { const d = new Date(ms); d.setHours(24, 0, 0, 0); return d.getTime(); };
const sameLocalDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const mergeEvidence = (list, confirmed = []) => [
  ...(list ?? []).filter(e => !(confirmed ?? []).some(c => c.criterion === e.criterion)),
  ...(confirmed ?? []).map(({ criterion, proof }) => ({ criterion, proof })),
];

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
    // team = the AI team works it in rotation until done; task = one-off; research/improvement repeat on a timer.
    const intervals = { team: null, task: null, research: this.policy.researchIntervalMs, improvement: this.policy.improvementIntervalMs };
    if (!Object.hasOwn(intervals, input?.kind)) throw new Error('kind must be team, task, research or improvement');
    if (!input.objective?.trim()) throw new Error('objective is required');
    if (!input.completionCriteria?.length) throw new Error('Goal requires explicit completion criteria');
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (title.length > 100) throw new Error('title must be at most 100 characters');
    const modelOverride = input.modelOverride ?? { mode: 'inherit' };
    if (!['inherit', 'pinned'].includes(modelOverride.mode) || (modelOverride.mode === 'pinned' && !modelOverride.model)) {
      throw new Error('modelOverride must be inherit or pinned with a model');
    }
    const now = iso(this.clock.now());
    const goal = {
      id: randomUUID(), projectId: validateProjectId(input.projectId ?? 'default'), kind: input.kind, title,
      executor: validateExecutor(input.executor ?? 'claude-code'),
      modelOverride: modelOverride.mode === 'pinned' ? { mode: 'pinned', model: modelOverride.model } : { mode: 'inherit' },
      activeModel: null,
      objective: input.objective.trim(), completionCriteria: validateCriteria(input.completionCriteria),
      intervalMs: intervals[input.kind], status: GoalStatus.SCHEDULED, reason: null,
      round: 0, attempt: 0, nextRunAt: now, evidence: [],
      testFixAttempts: 0, noProgressRounds: 0, bestCriteriaMet: 0, recentDiffs: [],
      autoRun: input.autoRun === true, question: null, proposal: null,
      team: input.kind === 'team' ? { step: 'plan', task: '', feedback: '', cycle: 1 } : null,
      createdAt: now, updatedAt: now,
    };
    this.store.saveGoal(goal);
    void this.store.emit({ type: 'goal.created', goalId: goal.id, projectId: goal.projectId });
    return goal;
  }

  // 대장's own confirmation of a criterion the engine could not check. It is recorded as human evidence,
  // kept across later rounds, and finishes the goal once every criterion has evidence.
  confirmCriterion(goalId, criterion, note = '') {
    const goal = this.store.getGoal(goalId);
    if (!goal || goal.status === GoalStatus.RUNNING) throw new Error('goal cannot be confirmed now');
    if (!goal.completionCriteria.includes(criterion)) throw new Error('unknown criterion');
    const text = String(note || '').trim().slice(0, 300);
    const confirmed = [...(goal.confirmed ?? []).filter(c => c.criterion !== criterion),
      { criterion, proof: `대장 확인${text ? ` · ${text}` : ''}`, by: 'human', at: iso(this.clock.now()) }];
    const evidence = mergeEvidence(goal.evidence, confirmed);
    const done = goal.completionCriteria.every(c => evidence.some(e => e.criterion === c));
    this.update(goal, { confirmed, evidence, ...(done ? { status: GoalStatus.VERIFIED, nextRunAt: null, reason: null } : {}) });
    void this.store.emit({ type: done ? 'goal.verified' : 'goal.confirmed', goalId, criterion });
    return goal;
  }

  // 시작: the team keeps working this goal on its own (the automatic tick only runs started goals).
  start(goalId) {
    const goal = this.store.getGoal(goalId);
    if (!goal) throw new Error('goal not found');
    if (goal.status === GoalStatus.VERIFIED) throw new Error('goal is already verified');
    const changes = { autoRun: true, pauseRequested: false };
    if (goal.status === GoalStatus.PAUSED) Object.assign(changes, { status: goal.pausedFrom ?? GoalStatus.SCHEDULED, pausedFrom: null });
    else if (RESUMABLE.includes(goal.status) && goal.reason !== 'needs_decision') {
      Object.assign(changes, { status: GoalStatus.SCHEDULED, reason: null, attempt: 0, testFixAttempts: 0, noProgressRounds: 0, nextRunAt: iso(this.clock.now()) });
    }
    this.update(goal, changes);
    void this.store.emit({ type: 'goal.started', goalId });
    return goal;
  }

  // 멈춤: no further rounds start; a round already running finishes and is saved first.
  stop(goalId) {
    const goal = this.store.getGoal(goalId);
    if (!goal) throw new Error('goal not found');
    const changes = { autoRun: false };
    if (goal.status === GoalStatus.RUNNING) changes.pauseRequested = true;
    else if (DUE.includes(goal.status)) Object.assign(changes, { status: GoalStatus.PAUSED, pausedFrom: goal.status });
    this.update(goal, changes);
    void this.store.emit({ type: 'goal.stopped', goalId });
    return goal;
  }

  // 대장's answer to the planning team's question; planning continues with it.
  answer(goalId, text) {
    const goal = this.store.getGoal(goalId);
    if (!goal || goal.reason !== 'needs_decision') throw new Error('goal is not waiting for an answer');
    const reply = String(text || '').trim().slice(0, 1000);
    if (!reply) throw new Error('answer is empty');
    this.update(goal, { status: GoalStatus.SCHEDULED, reason: null, question: null, autoRun: true, nextRunAt: iso(this.clock.now()),
      team: { ...goal.team, step: 'plan', feedback: `질문 · ${goal.question}\n대장 답변 · ${reply}` } });
    void this.store.emit({ type: 'goal.answered', goalId });
    return goal;
  }

  // Improvements proposed after completion become a new goal only when 대장 accepts them.
  acceptProposal(goalId) {
    const goal = this.store.getGoal(goalId);
    if (goal?.proposal?.status !== 'pending') throw new Error('no pending proposal');
    const next = this.addGoal({ projectId: goal.projectId, kind: 'team', autoRun: true, title: goal.title,
      objective: `${goal.objective} — 개선: ${goal.proposal.items.join(', ')}`.slice(0, 2000), completionCriteria: goal.proposal.items });
    this.update(goal, { proposal: { ...goal.proposal, status: 'accepted', nextGoalId: next.id } });
    return next;
  }

  dismissProposal(goalId) {
    const goal = this.store.getGoal(goalId);
    if (goal?.proposal?.status !== 'pending') throw new Error('no pending proposal');
    return this.update(goal, { proposal: { ...goal.proposal, status: 'dismissed' } });
  }

  // A running round is never cut off: the pause takes effect once that round is saved.
  pause(goalId) {
    const goal = this.store.getGoal(goalId);
    if (goal?.status === GoalStatus.RUNNING) {
      this.update(goal, { pauseRequested: true });
    } else if (goal && DUE.includes(goal.status)) {
      this.update(goal, { status: GoalStatus.PAUSED, pausedFrom: goal.status });
    } else {
      throw new Error('only waiting or running goals can be paused');
    }
    void this.store.emit({ type: 'goal.pause_requested', goalId });
    return goal;
  }

  resume(goalId) {
    const goal = this.store.getGoal(goalId);
    if (goal?.status === GoalStatus.PAUSED) {
      this.update(goal, { status: goal.pausedFrom ?? GoalStatus.SCHEDULED, pausedFrom: null });
      void this.store.emit({ type: 'goal.resumed', goalId });
      return goal;
    }
    if (!goal || !RESUMABLE.includes(goal.status)) throw new Error('goal is not paused, awaiting review or recovery');
    this.update(goal, { status: GoalStatus.SCHEDULED, reason: null, attempt: 0, testFixAttempts: 0,
      noProgressRounds: 0, nextRunAt: iso(this.clock.now()) });
    void this.store.emit({ type: 'goal.resumed', goalId });
    return goal;
  }

  // autoOnly: only goals 대장 started (used when real execution is on).
  // Concurrency is enforced here: total, per execution tool, and one round per project at a time.
  async tick({ autoOnly = false } = {}) {
    const now = this.clock.now();
    const goals = this.store.listGoals();
    const running = goals.filter(g => g.status === GoalStatus.RUNNING);
    const cap = { 'claude-code': this.policy.providerConcurrent?.claude ?? 2, codex: this.policy.providerConcurrent?.codex ?? 1 };
    const busy = { total: running.length, 'claude-code': 0, codex: 0, projects: new Set(running.map(g => g.projectId)) };
    running.forEach(g => { busy[this.stepExecutor(g)]++; });
    const claimed = [];
    for (const goal of goals) {
      if (!DUE.includes(goal.status) || Date.parse(goal.nextRunAt) > now || (autoOnly && !goal.autoRun)) continue;
      const executor = this.stepExecutor(goal);
      if (busy.total >= (this.policy.maxConcurrent ?? 2) || busy[executor] >= cap[executor] || busy.projects.has(goal.projectId)) continue;
      const run = this.claim(goal.id, now);
      if (!run) continue;
      claimed.push(run);
      busy.total++; busy[executor]++; busy.projects.add(goal.projectId);
    }
    await Promise.all(claimed.map(run => this.execute(run)));
  }

  stepExecutor(goal) {
    return goal.kind === 'team' ? TEAMS[goal.team?.step ?? 'plan'].executor : (goal.executor ?? 'claude-code');
  }

  roundsToday(projectId, now) {
    return this.store.listGoals().filter(g => g.projectId === projectId)
      .reduce((n, g) => n + this.store.listRuns(g.id).filter(r => sameLocalDay(Date.parse(r.startedAt), now)).length, 0);
  }

  // Manual "run one round now" for a single goal: ignores the schedule but not pause, model waits or
  // finished states. Used when real execution is on and automatic ticking is off.
  async runGoal(goalId) {
    const goal = this.store.getGoal(goalId);
    if (!goal || !DUE.includes(goal.status)) throw new Error('goal cannot run now: it is not waiting for a round');
    const run = this.claim(goalId, this.clock.now(), { ignoreSchedule: true });
    if (run) await this.execute(run);
    return run;
  }

  // Re-checks the goal inside a write transaction; the runs UNIQUE constraint backs this up across processes.
  claim(goalId, now, { ignoreSchedule = false } = {}) {
    try {
      return this.store.transaction(() => {
        const goal = this.store.getGoal(goalId);
        if (!goal || !DUE.includes(goal.status) || (!ignoreSchedule && Date.parse(goal.nextRunAt) > now)) return null;
        // Team projects that used up today's rounds continue tomorrow (the daily token guard).
        if (goal.kind === 'team' && this.roundsToday(goal.projectId, now) >= (this.policy.maxRoundsPerDay ?? 10)) {
          if (goal.reason !== 'daily_cap') {
            this.update(goal, { reason: 'daily_cap', nextRunAt: iso(nextMidnight(now)) });
            void this.store.emit({ type: 'goal.daily_cap', goalId, projectId: goal.projectId });
          }
          return null;
        }
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
          status: 'running', startedAt: iso(now), executor: this.stepExecutor(goal),
          team: goal.team?.step ?? null, access: goal.kind === 'team' ? TEAMS[goal.team.step].access : 'write',
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
    await this.store.emit({ type: 'goal.run_started', goalId: goal.id, round: run.round, attempt: run.attempt, team: run.team });
    let result;
    try {
      result = await this.runner.run(structuredClone(goal),
        { round: run.round, attempt: run.attempt, executor: run.executor, model: run.requestedModel, team: run.team, access: run.access });
    }
    catch (error) { result = { outcome: 'error', errorKind: error.kind }; }
    await this.settle(run, result ?? {});
  }

  async settle(run, result) {
    const now = this.clock.now();
    const goal = this.store.getGoal(run.goalId);
    const roundEvidence = this.evidenceFor(goal, result.evidence);
    // A planning round checks nothing, so it keeps the evidence gathered so far.
    const evidence = run.team === 'plan' ? (goal.evidence ?? []) : mergeEvidence(roundEvidence, goal.confirmed);
    // Only the tool's own report says which model actually ran; the requested model is not proof.
    const actualModel = typeof result.model === 'string' && result.model ? result.model : null;
    // Raw provider output is not persisted. The final answer is kept (capped) because it is the result
    // the user asked for; the per-criterion claims are what the tool said, not evidence.
    this.store.saveRun({ ...run, status: 'finished', finishedAt: iso(now), outcome: result.outcome ?? 'invalid_result',
      errorKind: result.errorKind ?? null, diffHash: result.diffHash ?? null, evidence: roundEvidence, actualModel,
      simulated: result.simulated === true,
      answer: typeof result.answer === 'string' ? result.answer.slice(0, 4000) : null,
      claims: Array.isArray(result.claims) ? result.claims.slice(0, 20) : [] });
    if (goal.status !== GoalStatus.RUNNING) return;
    const decided = goal.kind === 'team' && result.outcome === 'completed'
      ? this.decideTeam(goal, result, evidence, now) : this.decide(goal, result, evidence, now);
    const next = { ...decided, activeModel: actualModel };
    if (goal.pauseRequested) {
      next.pauseRequested = false;
      if (DUE.includes(next.status)) Object.assign(next, { pausedFrom: next.status, status: GoalStatus.PAUSED });
    }
    this.update(goal, next);
    await this.store.emit({ type: `goal.${goal.status}`, goalId: goal.id, round: run.round, reason: goal.reason, team: run.team });
  }

  // One step of the team rotation. The next step starts right away (no timer) until the goal is proven,
  // the planning team needs 대장, development stops making progress, or a limit is hit.
  decideTeam(goal, result, evidence, now) {
    const step = goal.team.step;
    const team = { ...goal.team };
    const proven = goal.completionCriteria.every(c => evidence.some(e => e.criterion === c));
    const review = (reason, extra = {}) => ({ evidence, ...extra, team, status: GoalStatus.REVIEW_REQUIRED, reason, nextRunAt: null });
    const advance = (extra = {}) => ({ evidence, ...extra, reason: null, question: null, status: GoalStatus.SCHEDULED,
      nextRunAt: iso(now), team: { ...team, step: nextTeam(step) } });
    const finish = (improvements) => ({ evidence, team, status: GoalStatus.VERIFIED, reason: null, nextRunAt: null, autoRun: false,
      proposal: improvements.length ? { items: improvements, status: 'pending', at: iso(now) } : null });

    if (step === 'plan') {
      const plan = result.plan;
      if (!plan) return review('unclear_plan');
      if (plan.needsDecision) return review('needs_decision', { question: plan.needsDecision });
      if (plan.allDone && proven) return finish([]);
      team.task = plan.allDone ? '완료 여부 최종 확인' : plan.nextTask;
      if (plan.allDone) return { ...advance(), team: { ...team, step: 'qa' } };
      return advance();
    }
    if (step === 'dev') {
      // Progress means new evidence or a workspace change not seen before; only development rounds count.
      const diffIsNew = Boolean(result.diffHash) && !goal.recentDiffs.includes(result.diffHash);
      const progressed = evidence.length > goal.bestCriteriaMet || diffIsNew;
      const extra = { bestCriteriaMet: Math.max(evidence.length, goal.bestCriteriaMet),
        recentDiffs: diffIsNew ? [...goal.recentDiffs, result.diffHash].slice(-20) : goal.recentDiffs,
        noProgressRounds: progressed ? 0 : goal.noProgressRounds + 1 };
      if (extra.noProgressRounds >= this.policy.maxNoProgress) return review('no_progress', extra);
      return advance(extra);
    }
    const findings = result.findings ?? { feedback: '', improvements: [] };
    team.feedback = findings.feedback;
    if (proven) return finish(findings.improvements ?? []);
    team.cycle = (team.cycle ?? 1) + 1;
    return advance();
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
    // A one-off task that is not fully proven stops here for 대장 instead of spending another round.
    if (goal.kind === 'task') return review('awaiting_review', { ...base, testFixAttempts: 0 });
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
    const executor = this.stepExecutor(goal);
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
    return { executor: this.stepExecutor(goal), requested: run?.requestedModel ?? null, actual: goal.activeModel ?? null,
      next: next.model, nextState: next.state,
      changePending: Boolean(run) && (next.state !== 'ready' || next.model !== run.requestedModel) };
  }

  update(goal, changes) {
    Object.assign(goal, changes, { updatedAt: iso(this.clock.now()) });
    return this.store.saveGoal(goal);
  }
}
