import { randomUUID } from 'node:crypto';
import { attachmentNote } from './attachments.js';
import { validateCriteria } from './domain.js';
import { isUsable, resolveModel, validateExecutor } from './models.js';
import { levelChoice, levelFor } from './model-levels.js';
import { DEFAULT_POLICY } from './policy.js';
import { nextStep, REVIEWS, TEAMS, WORKERS } from './teams.js';
import { validateProjectId } from './workspaces.js';
import { enqueueRequests, taskProfile } from './team-governance.js';
import { selectAssignment } from './assignment.js';
import { DEFAULT_CLAUDE_MODEL } from './model-choices.js';

export const GoalStatus = Object.freeze({
  SCHEDULED: 'scheduled', RUNNING: 'running', RETRY_WAIT: 'retry_wait', VERIFIED: 'verified', MODEL_WAIT: 'model_wait',
  REVIEW_REQUIRED: 'review_required', BLOCKED: 'blocked', RECOVERY_REQUIRED: 'recovery_required', PAUSED: 'paused',
});
const DUE = [GoalStatus.SCHEDULED, GoalStatus.RETRY_WAIT, GoalStatus.MODEL_WAIT];
const RESUMABLE = [GoalStatus.REVIEW_REQUIRED, GoalStatus.BLOCKED, GoalStatus.RECOVERY_REQUIRED];
const NON_RETRYABLE = ['auth', 'limit', 'permission'];
// Waits only 대장's own answer may end: "start"/"resume" never skip them.
const HELD_FOR_DAEJANG = ['needs_decision', 'trust_review', 'approval_required', 'criteria_approval_required'];
const iso = ms => new Date(ms).toISOString();
const nextMidnight = ms => { const d = new Date(ms); d.setHours(24, 0, 0, 0); return d.getTime(); };
const sameLocalDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
// A Claude round never runs on an unnamed default: an older Claude Code maps its default to an older
// model (2.1.265 ran Opus 5), so the listed default is passed by its full ID.
const namedModel = (executor, result) => (executor === 'claude-code' && result.state === 'ready' && !result.model
  ? { ...result, model: DEFAULT_CLAUDE_MODEL, source: result.source === 'team_choice' ? 'team_choice' : 'listed_default' } : result);
const mergeEvidence = (list, confirmed = []) => [
  ...(list ?? []).filter(e => !(confirmed ?? []).some(c => c.criterion === e.criterion)),
  ...(confirmed ?? []).map(({ criterion, proof }) => ({ criterion, proof })),
];

// Drives repeated rounds toward a goal. Time comes only from the injected clock and all state lives in
// SQLite, so the scheduler holds nothing that a restart could lose. It never resumes interrupted work itself.
// The model is resolved only when a round is claimed, i.e. after the previous round's run record (the
// checkpoint) is saved; a policy change during a round therefore takes effect from the next round.
export class GoalScheduler {
  constructor({ store, runner, clock = { now: () => Date.now() }, policy = DEFAULT_POLICY, registry = null, capacity = null, capabilities = null, dailyCap = null,
    trust = null, autoSwitch = () => true, autoLevels = () => true, codexModels = () => [] }) {
    Object.assign(this, { store, runner, clock, policy, registry, capacity, capabilities, dailyCap, trust, autoSwitch, autoLevels, codexModels });
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
    if (!input.completionCriteria?.length && !(input.kind === 'team' && input.conversation === true)) throw new Error('Goal requires explicit completion criteria');
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
      objective: input.objective.trim(), completionCriteria: input.completionCriteria?.length ? validateCriteria(input.completionCriteria) : [],
      conversation: input.conversation === true, messages: input.conversation ? [{ role: 'user', text: input.objective.trim(), at: now }] : [],
      intervalMs: intervals[input.kind], status: GoalStatus.SCHEDULED, reason: null,
      round: 0, attempt: 0, nextRunAt: now, evidence: [],
      testFixAttempts: 0, noProgressRounds: 0, bestCriteriaMet: 0, recentDiffs: [],
      autoRun: input.autoRun === true, question: null, proposal: null,
      collaboration: [], autonomy: { enabled: false, remaining: 0 },
      team: input.kind === 'team' ? { step: 'plan', task: '', feedback: '', cycle: 1, worker: 'dev', reviews: [], reviewNotes: [] } : null,
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
    // In a team project 대장 confirms only what the verification team looked at and the engine could not prove.
    if (goal.kind === 'team' && !(this.store.listRuns?.(goalId) ?? []).some(r => r.team === 'qa' && r.status === 'finished'
      && r.outcome === 'completed' && !r.simulated)) throw new Error('verification team has not checked this project yet');
    const text = String(note || '').trim().slice(0, 300);
    const confirmed = [...(goal.confirmed ?? []).filter(c => c.criterion !== criterion),
      { criterion, proof: `대장 확인${text ? ` · ${text}` : ''}`, by: 'human', at: iso(this.clock.now()) }];
    const evidence = mergeEvidence(goal.evidence, confirmed);
    const all = goal.completionCriteria.every(c => evidence.some(e => e.criterion === c));
    // A team project finishes here only when the verification just before asked 대장 to judge the rest (no engine
    // finding was open then, and nothing has run since); otherwise the next verification counts the confirmation.
    const judged = goal.kind === 'team' && goal.status === GoalStatus.REVIEW_REQUIRED && goal.reason === 'needs_decision'
      && Array.isArray(goal.team?.awaitingJudgement) && goal.team.awaitingJudgement.length > 0;
    const done = all && (goal.kind !== 'team' || judged);
    const at = iso(this.clock.now());
    this.update(goal, { confirmed, evidence, ...(done ? { status: GoalStatus.VERIFIED, nextRunAt: null, reason: null } : {}),
      ...(!(done && judged) ? { messages: this.withControl(goal, `조건 확인 · ${criterion}${text ? ` · ${text}` : ''}`) } : {}),
      ...(done && judged ? { question: null, autoRun: false, autoRunBeforeFinish: goal.autoRun, team: { ...goal.team, awaitingJudgement: null },
        messages: [...(goal.messages ?? []), { role: 'team', kind: 'question', text: String(goal.question ?? ''), at },
          { role: 'user', kind: 'approval', text: `남은 조건을 대장이 확인했습니다 · ${goal.team.awaitingJudgement.join(' · ')}`, at }].slice(-100) } : {}) });
    void this.store.emit({ type: done ? 'goal.verified' : 'goal.confirmed', goalId, criterion });
    if (done && judged) this.dispatchFollowup(goal);
    return goal;
  }

  // 시작: the team keeps working this goal on its own (the automatic tick only runs started goals).
  start(goalId) {
    const goal = this.store.getGoal(goalId);
    if (goal?.criteriaApprovalPending) throw new Error('completion criteria approval required');
    if (!goal) throw new Error('goal not found');
    if (goal.status === GoalStatus.VERIFIED) throw new Error('goal is already verified');
    const changes = { autoRun: true, pauseRequested: false, messages: this.withControl(goal, goal.status === GoalStatus.PAUSED ? '다시 시작' : '시작') };
    if (goal.status === GoalStatus.PAUSED) Object.assign(changes, { status: goal.pausedFrom ?? GoalStatus.SCHEDULED, pausedFrom: null });
    else if (RESUMABLE.includes(goal.status) && !HELD_FOR_DAEJANG.includes(goal.reason)) {
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
    const changes = { autoRun: false, messages: this.withControl(goal, goal.status === GoalStatus.RUNNING ? '멈춤 · 지금 단계가 끝나면 멈춥니다' : '멈춤') };
    if (goal.status === GoalStatus.RUNNING) changes.pauseRequested = true;
    else if (DUE.includes(goal.status)) Object.assign(changes, { status: GoalStatus.PAUSED, pausedFrom: goal.status });
    this.update(goal, changes);
    void this.store.emit({ type: 'goal.stopped', goalId });
    return goal;
  }

  // 대장's answer to the planning team's question; planning continues with it.
  answer(goalId, text, attachments = []) {
    const goal = this.store.getGoal(goalId);
    if (goal?.criteriaApprovalPending) throw new Error('completion criteria approval required');
    if (!goal || !['needs_decision', 'rule_violation'].includes(goal.reason)) throw new Error('goal is not waiting for an answer');
    const typed = String(text || '').trim().slice(0, 1000);
    if (!typed && !attachments.length) throw new Error('answer is empty');
    const reply = (typed || '(첨부 파일 참고)') + attachmentNote(attachments);
    const at = iso(this.clock.now());
    // The question and 대장's answer stay in the project conversation, not only in the planning feedback.
    const messages = [...(goal.messages ?? []), { role: 'team', kind: 'question', text: String(goal.question ?? ''), at },
      { role: 'user', kind: 'answer', text: typed, ...(attachments.length ? { attachments } : {}), at }].slice(-100);
    this.update(goal, { status: GoalStatus.SCHEDULED, reason: null, question: null, autoRun: true, nextRunAt: at, messages,
      team: { ...goal.team, step: 'plan', feedback: `질문 · ${goal.question}\n대장 답변 · ${reply}`, criteriaCheck: true, awaitingJudgement: null } });
    void this.store.emit({ type: 'goal.answered', goalId });
    return goal;
  }

  // attachments: already saved in the project's attachments/ folder (checked by the caller); the teams get their paths.
  message(goalId, text, attachments = []) {
    const goal = this.store.getGoal(goalId);
    if (!goal || goal.kind !== 'team') throw new Error('team project not found');
    if (goal.status === GoalStatus.RUNNING) throw new Error('wait for the current checkpoint');
    const typed = String(text ?? '').trim();
    if ((!typed && !attachments.length) || typed.length > 4000) throw new Error('message must be 1 to 4000 characters');
    const reply = (typed || '(첨부 파일 참고)') + attachmentNote(attachments);
    const messages = [...(goal.messages ?? []), { role: 'user', text: typed, ...(attachments.length ? { attachments } : {}), at: iso(this.clock.now()) }].slice(-100);
    const held = [GoalStatus.PAUSED, GoalStatus.RECOVERY_REQUIRED, GoalStatus.BLOCKED].includes(goal.status);
    // Approved criteria and their evidence survive a message ("keep going" must not wipe them); planning proposes
    // a new list only when the message changes what counts as done. A message while criteria still await approval
    // means "derive them again".
    const rederive = goal.criteriaApprovalPending || !goal.completionCriteria.length;
    const criteria = rederive ? { completionCriteria: [], criteriaApprovalPending: false, evidence: [], confirmed: [] } : {};
    return this.update(goal, { conversation: true, messages, ...criteria,
      objective: `${goal.objective}\n대장 추가 요청: ${reply}`.slice(-16000), status: held ? goal.status : GoalStatus.SCHEDULED, reason: held ? goal.reason : null,
      question: held ? goal.question : null, proposal: null, nextRunAt: held ? goal.nextRunAt : iso(this.clock.now()),
      team: { ...goal.team, step: 'plan', feedback: reply, criteriaCheck: !rederive } });
  }

  // 승인 대기 is over for this goal (every request answered): the held step runs again, with any refusals noted.
  releaseApprovals(goalId, refusals = []) {
    const goal = this.store.getGoal(goalId);
    if (!goal || goal.reason !== 'approval_required') return goal;
    const note = refusals.length ? `[대장] 감시 에이전트 요청 거절: ${refusals.join(', ')} · 이것 없이 진행할 방법을 쓰세요.` : '';
    this.update(goal, { status: GoalStatus.SCHEDULED, reason: null, question: null, nextRunAt: iso(this.clock.now()),
      messages: this.withControl(goal, refusals.length ? `감시 에이전트 요청 처리 · 거절 ${refusals.length}건 · 계속` : '감시 에이전트 요청 처리 · 계속'),
      ...(note ? { team: { ...goal.team, feedback: [goal.team?.feedback, note].filter(Boolean).join('\n') } } : {}) });
    void this.store.emit({ type: 'goal.approvals_answered', goalId });
    return goal;
  }

  // 신뢰 쌓기: 대장 looked at a work team's result. Accept counts toward that kind of work running on its own;
  // send back returns the note to planning.
  trustReview(goalId, { accept, note = '', trustFully = false }) {
    const goal = this.store.getGoal(goalId);
    if (!goal || goal.status !== GoalStatus.REVIEW_REQUIRED || goal.reason !== 'trust_review' || !goal.trustReview) throw new Error('goal is not waiting for a result review');
    const { team } = goal.trustReview;
    const at = iso(this.clock.now());
    const text = String(note ?? '').trim().slice(0, 1000);
    const messages = [...(goal.messages ?? []), { role: 'user', kind: 'review', at,
      text: accept ? `${TEAMS[team].name} 결과 확인 · 계속${trustFully ? ' · 이 종류는 이제 믿고 맡김' : ''}${text ? ` · ${text}` : ''}` : `${TEAMS[team].name} 결과 되돌림${text ? ` · ${text}` : ''}` }].slice(-100);
    if (accept) {
      if (trustFully && this.trust?.complete) this.trust.complete(team); else this.trust?.add(team);
      this.update(goal, { status: GoalStatus.SCHEDULED, reason: null, question: null, trustReview: null, nextRunAt: at, messages });
    } else {
      if (!text) throw new Error('say what to fix when sending a result back');
      this.update(goal, { status: GoalStatus.SCHEDULED, reason: null, question: null, trustReview: null, nextRunAt: at, messages,
        team: { ...goal.team, step: 'plan', feedback: `[대장] ${TEAMS[team].name} 결과를 되돌림: ${text}`, cycle: (goal.team?.cycle ?? 1) + 1 } });
    }
    void this.store.emit({ type: 'goal.trust_reviewed', goalId, team, accept: accept === true });
    return goal;
  }

  // Improvements proposed after completion become a new goal only when 대장 accepts them.
  acceptProposal(goalId) {
    const goal = this.store.getGoal(goalId);
    if (goal?.proposal?.status !== 'pending') throw new Error('no pending proposal');
    const next = this.addGoal({ projectId: goal.projectId, kind: 'team', autoRun: true, title: goal.title,
      objective: `${goal.objective} — 개선: ${goal.proposal.items.join(', ')}`.slice(0, 2000), completionCriteria: goal.proposal.items });
    this.update(goal, { proposal: { ...goal.proposal, status: 'accepted', nextGoalId: next.id }, messages: this.withControl(goal, `개선안 승인 · ${goal.proposal.items.length}개를 새 목표로 진행`) });
    return next;
  }

  dismissProposal(goalId) {
    const goal = this.store.getGoal(goalId);
    if (goal?.proposal?.status !== 'pending') throw new Error('no pending proposal');
    return this.update(goal, { proposal: { ...goal.proposal, status: 'dismissed' }, messages: this.withControl(goal, '개선안 보류') });
  }

  setAutonomy(goalId, input) {
    const goal = this.store.getGoal(goalId);
    if (!goal || goal.kind !== 'team' || goal.status === GoalStatus.RUNNING) throw new Error('wait for a team checkpoint');
    if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.remaining) || input.remaining < 0 || input.remaining > 3) throw new Error('autonomy budget must be 0 to 3');
    const updated = this.update(goal, { autonomy: { enabled: input.enabled, remaining: input.remaining },
      messages: this.withControl(goal, input.enabled ? `자율 후속 작업 켬 · 최대 ${input.remaining}번` : '자율 후속 작업 끔') });
    if (!input.enabled) {
      let childId = goal.followupId;
      const seen = new Set();
      while (childId && !seen.has(childId)) {
        seen.add(childId);
        const child = this.store.getGoal(childId);
        if (!child) break;
        this.update(child, { autonomy: { enabled: false, remaining: 0 } });
        this.stop(child.id);
        childId = child.followupId;
      }
    }
    return updated;
  }

  dispatchFollowup(goal) {
    if (!goal.autonomy?.enabled || goal.autonomy.remaining <= 0) return;
    const request = (goal.collaboration ?? []).find(r => r.status === 'proposed' && r.risk === 'low' && !r.effects.length);
    if (!request) return;
    // The parent's budget moves to the child, never multiplies. Daily project limits still apply.
    this.store.transaction(() => {
      const fresh = this.store.getGoal(goal.id);
      if (fresh.followupId || fresh.status !== GoalStatus.VERIFIED) return;
      const child = this.addGoal({ projectId: goal.projectId, kind: 'team', autoRun: goal.autoRunBeforeFinish === true,
        title: goal.title, objective: `기존 프로젝트 내 후속 작업: ${request.task}`, completionCriteria: request.criteria });
      this.update(child, { parentGoalId: goal.id, autonomy: { enabled: true, remaining: goal.autonomy.remaining - 1 },
        team: { ...child.team, step: request.team, worker: request.team, task: request.task,
          profile: taskProfile(request), reviews: ['security', 'policy'] } });
      this.update(fresh, { followupId: child.id, autonomy: { enabled: true, remaining: 0 },
        collaboration: fresh.collaboration.map(r => r.id === request.id ? { ...r, status: 'scheduled', goalId: child.id } : r) });
    });
  }

  // A running round is never cut off: the pause takes effect once that round is saved.
  pause(goalId) {
    const goal = this.store.getGoal(goalId);
    if (goal?.status === GoalStatus.RUNNING) {
      this.update(goal, { pauseRequested: true, messages: this.withControl(goal, '멈춤 · 지금 단계가 끝나면 멈춥니다') });
    } else if (goal && DUE.includes(goal.status)) {
      this.update(goal, { status: GoalStatus.PAUSED, pausedFrom: goal.status, messages: this.withControl(goal, '멈춤') });
    } else {
      throw new Error('only waiting or running goals can be paused');
    }
    void this.store.emit({ type: 'goal.pause_requested', goalId });
    return goal;
  }

  resume(goalId) {
    const goal = this.store.getGoal(goalId);
    if (goal?.criteriaApprovalPending) throw new Error('completion criteria approval required');
    if (goal?.status === GoalStatus.PAUSED) {
      this.update(goal, { status: goal.pausedFrom ?? GoalStatus.SCHEDULED, pausedFrom: null, messages: this.withControl(goal, '다시 시작') });
      void this.store.emit({ type: 'goal.resumed', goalId });
      return goal;
    }
    if (!goal || !RESUMABLE.includes(goal.status)) throw new Error('goal is not paused, awaiting review or recovery');
    if (['trust_review', 'approval_required'].includes(goal.reason) || (goal.reason === 'criteria_approval_required' && goal.criteriaApprovalPending)) {
      throw new Error('this goal waits for 대장: answer it in the approval inbox');
    }
    this.update(goal, { status: GoalStatus.SCHEDULED, reason: null, attempt: 0, testFixAttempts: 0,
      noProgressRounds: 0, nextRunAt: iso(this.clock.now()), messages: this.withControl(goal, '다시 시작') });
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

  // The tool this step runs on: the planned one, or the other subscription when the planned one hit its usage stop.
  stepExecutor(goal) {
    const planned = this.plannedExecutor(goal);
    return this.limitSwitch(goal, planned) ?? planned;
  }

  // 한도 자동 전환: when the team's tool hit its usage stop (5h 20% / weekly 10% left, or a limit reported) and the
  // other subscription has room, the step runs there on that tool's own default model. Never onto Codex for work that
  // needs the web or claude.ai connectors (Codex has neither). 대장 can turn this off (limits.autoSwitch) or per project
  // (allowProviderSwitch: false).
  limitSwitch(goal, planned) {
    if (goal.kind !== 'team' || !this.capacity || this.autoSwitch?.() === false || this.capacity(planned)) return null;
    // High-risk work is never moved for quota: it waits for the tool it was planned on.
    if (goal.team?.profile?.risk === 'high') return null;
    if (this.registry?.getPolicy(`project:${goal.projectId}`).allowProviderSwitch === false) return null;
    const other = planned === 'codex' ? 'claude-code' : 'codex';
    const step = goal.team?.step ?? 'plan';
    if (other === 'codex' && (TEAMS[step]?.web || this.capabilities?.(step)?.['claude-code']?.includes('connectors'))) return null;
    return this.capacity(other) ? other : null;
  }

  plannedExecutor(goal) {
    const collaborative = this.collaborativeAssignment(goal);
    if (collaborative) return collaborative.executor ?? TEAMS[goal.team?.step ?? 'plan'].executor;
    if (goal.kind === 'team' && goal.team?.step === 'dev'
      && this.registry?.getPolicy(`project:${goal.projectId}`).allowProviderSwitch) {
      const preferred = goal.team.profile?.complexity === 'complex' || goal.team.profile?.risk === 'high' ? 'codex' : 'claude-code';
      const other = preferred === 'codex' ? 'claude-code' : 'codex';
      const project = this.registry.getPolicy(`project:${goal.projectId}`);
      if (this.capacity && !this.capacity(preferred) && this.capacity(other) && goal.team.profile?.risk !== 'high'
        && resolveModel({ executor: other, project, task: goal.modelOverride, catalog: this.registry.catalog(),
          context: { critical: goal.team.profile?.complexity === 'complex' } }).state === 'ready') return other;
      return preferred;
    }
    return goal.kind === 'team' ? TEAMS[goal.team?.step ?? 'plan'].executor : (goal.executor ?? 'claude-code');
  }

  // Steps per project per day: 대장's setting when present, else the policy default (10).
  dailyLimit() {
    const set = this.dailyCap?.();
    return Number.isInteger(set) && set >= 1 ? set : (this.policy.maxRoundsPerDay ?? 10);
  }

  // "오늘만 N단계 더": extra steps 대장 grants one project for today only (usage stop rules still apply).
  projectLimit(goal, now = this.clock.now()) {
    const extra = goal.dailyExtra && goal.dailyExtra.day === new Date(now).toDateString() ? goal.dailyExtra.steps : 0;
    return this.dailyLimit() + extra;
  }
  extendToday(goalId, steps) {
    const goal = this.store.getGoal(goalId);
    if (!goal || goal.kind !== 'team') throw new Error('team project not found');
    if (!Number.isInteger(steps) || steps < 1 || steps > 50) throw new Error('extra steps must be a whole number from 1 to 50');
    const now = this.clock.now(), day = new Date(now).toDateString();
    const already = goal.dailyExtra?.day === day ? goal.dailyExtra.steps : 0;
    if (already + steps > 50) throw new Error('at most 50 extra steps per project per day');
    const changes = { dailyExtra: { day, steps: already + steps },
      messages: this.withControl(goal, `오늘만 ${steps}단계 더 · 오늘 한도 ${this.dailyLimit() + already + steps}단계 (기본 ${this.dailyLimit()} + 오늘 추가 ${already + steps})`) };
    // A project held only by today's limit continues at the next tick.
    if (goal.reason === 'daily_cap') Object.assign(changes, { reason: null, nextRunAt: iso(now) });
    void this.store.emit({ type: 'goal.daily_extended', goalId, steps: already + steps });
    return this.update(goal, changes);
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
        const executor = this.stepExecutor(goal);
        const running = this.store.listGoals().filter(g => g.status === GoalStatus.RUNNING);
        const providerCap = executor === 'codex' ? this.policy.providerConcurrent?.codex ?? 1 : this.policy.providerConcurrent?.claude ?? 2;
        if (running.length >= (this.policy.maxConcurrent ?? 2) || running.some(g => g.projectId === goal.projectId)
          || running.filter(g => this.store.listRuns(g.id).at(-1)?.executor === executor).length >= providerCap) return null;
        // Team projects that used up today's rounds continue tomorrow (the daily token guard).
        if (goal.kind === 'team' && this.roundsToday(goal.projectId, now) >= this.projectLimit(goal, now)) {
          if (goal.reason !== 'daily_cap') {
            this.update(goal, { reason: 'daily_cap', nextRunAt: iso(nextMidnight(now)) });
            void this.store.emit({ type: 'goal.daily_cap', goalId, projectId: goal.projectId });
          }
          return null;
        }
        if (this.capacity && !this.capacity(this.stepExecutor(goal))) {
          this.update(goal, { status: GoalStatus.MODEL_WAIT, waitingFrom: goal.waitingFrom ?? goal.status, reason: 'usage_unavailable_or_limited' });
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
          status: 'running', startedAt: iso(now), executor: this.stepExecutor(goal), ...this.switchNote(goal),
          team: goal.team?.step ?? null, access: goal.kind === 'team' ? TEAMS[goal.team.step].access : 'write',
          requestedModel: model.model, modelSource: model.source, fallbackFrom: model.fallbackFrom ?? null,
          requestedEffort: model.effort ?? null, selectionReason: model.reason ?? model.source,
          assignmentComparison: model.comparison ?? [], requiredCapabilities: model.needs ?? [], proposalReason: model.proposalReason ?? null,
          policyVersion: model.policyVersion, ...(model.level ? { level: model.level } : {}) });
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
        { round: run.round, attempt: run.attempt, executor: run.executor, model: run.requestedModel, effort: run.requestedEffort, team: run.team, access: run.access });
    }
    catch (error) { result = { outcome: 'error', errorKind: error.kind }; }
    await this.settle(run, result ?? {});
  }

  async settle(run, result) {
    const now = this.clock.now();
    const goal = this.store.getGoal(run.goalId);
    const roundEvidence = this.evidenceFor(goal, result.evidence);
    // Planning and the read-only reviews (security, policy) check no criteria and cannot change files, so they keep
    // the evidence gathered so far (otherwise the proven count drops to 0 after every review).
    const evidence = run.team === 'plan' || REVIEWS.includes(run.team) ? (goal.evidence ?? []) : mergeEvidence(roundEvidence, goal.confirmed);
    // Only the tool's own report says which model actually ran; the requested model is not proof.
    const actualModel = typeof result.model === 'string' && result.model ? result.model : null;
    // Raw provider output is not persisted. The final answer is kept (capped) because it is the result
    // the user asked for; the per-criterion claims are what the tool said, not evidence.
    this.store.saveRun({ ...run, status: 'finished', finishedAt: iso(now), outcome: result.outcome ?? 'invalid_result',
      errorKind: result.errorKind ?? null, diffHash: result.diffHash ?? null, evidence: roundEvidence, actualModel,
      simulated: result.simulated === true,
      answer: typeof result.answer === 'string' ? result.answer.slice(0, 4000) : null,
      checkpoint: this.store.listRuns(goal.id).find(r => r.id === run.id)?.checkpoint ?? null,
      claims: Array.isArray(result.claims) ? result.claims.slice(0, 20) : [],
      tools: Array.isArray(result.tools) ? result.tools.slice(0, 12) : [],
      // Web originals the engine saved this step (their fingerprints back source_contains checks later).
      ...(Array.isArray(result.sources) ? { sources: result.sources.slice(0, 10) } : {}),
      ...(Array.isArray(result.documents) ? { documents: result.documents.slice(0, 3) } : {}),
      plan: result.plan ? { nextTask: result.plan.nextTask, team: result.plan.team ?? 'dev', reviews: result.plan.reviews ?? [] } : null,
      review: result.review ? { verdict: result.review.verdict, issues: result.review.issues, blocking: result.review.blocking } : null });
    if (goal.status !== GoalStatus.RUNNING) return;
    // 대장 규칙: a step that added or changed a file a 금지 / 승인 필요 path rule covers stops for 대장 (rules.js).
    const violations = Array.isArray(result.ruleViolations) ? result.ruleViolations : [];
    const decided = violations.length
      ? { status: GoalStatus.REVIEW_REQUIRED, reason: 'rule_violation', nextRunAt: null,
        question: `[엔진] ${TEAMS[run.team]?.name ?? '팀'}이 대장 규칙에 걸리는 파일을 바꿨습니다:\n${violations.slice(0, 10)
          .map(v => `- ${v.file} · ${v.rule.action === 'deny' ? '금지' : '승인 필요'} 규칙 “${v.rule.target}”${v.rule.note ? ` (${v.rule.note})` : ''}`).join('\n')}\n`
          + '파일을 확인한 뒤, 괜찮으면 다시 시작하고 아니면 고칠 점을 답으로 보내 주세요.' }
      : goal.kind === 'team' && result.outcome === 'completed'
        ? this.decideTeam(goal, result, evidence, now) : this.decide(goal, result, evidence, now);
    const next = { ...decided, activeModel: actualModel };
    if (next.status === GoalStatus.VERIFIED) next.autoRunBeforeFinish = goal.autoRun;
    if (!result.simulated && Array.isArray(result.requests)) next.collaboration = enqueueRequests(goal.collaboration, result.requests);
    if (goal.pauseRequested) {
      next.pauseRequested = false;
      if (DUE.includes(next.status)) Object.assign(next, { pausedFrom: next.status, status: GoalStatus.PAUSED });
    }
    this.update(goal, next);
    if (goal.status === GoalStatus.VERIFIED && !result.simulated) this.dispatchFollowup(goal);
    await this.store.emit({ type: `goal.${goal.status}`, goalId: goal.id, round: run.round, reason: goal.reason, team: run.team });
  }

  // One step of the team rotation. The next step starts right away (no timer) until the goal is proven,
  // a team needs 대장, the work stops making progress, or a limit is hit.
  //   plan → worker (dev | design) → [security] → [policy] → qa → plan
  decideTeam(goal, result, evidence, now) {
    const step = goal.team.step;
    const team = { worker: 'dev', reviews: [], reviewNotes: [], ...goal.team, awaitingJudgement: null };
    const proven = goal.completionCriteria.length > 0 && goal.completionCriteria.every(c => evidence.some(e => e.criterion === c));
    const review = (reason, extra = {}) => ({ evidence, ...extra, team, status: GoalStatus.REVIEW_REQUIRED, reason, nextRunAt: null });
    const goTo = (next, extra = {}) => ({ evidence, ...extra, reason: null, question: null, status: GoalStatus.SCHEDULED,
      nextRunAt: iso(now), team: { ...team, step: next } });
    const advance = (extra = {}) => goTo(nextStep(team), extra);
    // 승인 대기: the Sentinel held something back for 대장. The same step runs again once 대장 has answered.
    if (result.approvalRequests?.length) {
      return review('approval_required', { question: `감시 에이전트가 대장 승인이 필요한 동작 ${result.approvalRequests.length}건을 멈춰 두었습니다. 승인함에서 범위를 골라 주세요.` });
    }
    const finish = (improvements) => ({ evidence, team, status: GoalStatus.VERIFIED, reason: null, nextRunAt: null, autoRun: false,
      proposal: improvements.length ? { items: improvements, status: 'pending', at: iso(now) } : null });

    if (step === 'plan') {
      const plan = result.plan;
      if (!plan) return review('unclear_plan');
      if (plan.needsDecision) return review('needs_decision', { question: plan.needsDecision });
      if (!goal.completionCriteria.length) {
        if (!plan.completionCriteria?.length) return review('criteria_not_derived');
        this.update(goal, { completionCriteria: validateCriteria(plan.completionCriteria), criteriaApprovalPending: true });
        return review('criteria_approval_required', { question: '도출한 완료 조건을 확인하고 승인해 주세요.' });
      }
      // After 대장's message planning may propose a changed list; only a real change needs approval again.
      if (team.criteriaCheck) {
        team.criteriaCheck = false;
        const next = plan.completionCriteria?.length ? validateCriteria(plan.completionCriteria) : null;
        if (next && JSON.stringify(next) !== JSON.stringify(goal.completionCriteria)) {
          this.update(goal, { completionCriteria: next, criteriaApprovalPending: true, confirmed: [] });
          return review('criteria_approval_required', { evidence: [], question: '대장 메시지에 맞춰 완료 조건을 바꾸자고 제안했습니다. 확인하고 승인해 주세요.' });
        }
      }
      team.worker = WORKERS.includes(plan.team) ? plan.team : 'dev';
      team.profile = taskProfile(plan.profile);
      if (team.profile.effects.length) return review('needs_decision', { question: `승인 범위가 필요한 작업: ${team.profile.effects.join(', ')}. 해당 외부 작업은 아직 실행하지 않았습니다.` });
      team.reviews = plan.allDone ? [...REVIEWS] : REVIEWS.filter(r => (plan.reviews ?? []).includes(r));
      team.reviewNotes = [];
      team.task = plan.allDone ? '완료 여부 최종 확인' : plan.nextTask;
      return plan.allDone ? goTo(team.reviews[0] ?? 'qa') : advance();
    }
    if (REVIEWS.includes(step)) {
      // Reviewers only look. A blocking finding sends the work back to planning; a question stops for 대장.
      const name = TEAMS[step].name;
      const verdict = result.review;
      if (!verdict) return review('unclear_review');
      if (verdict.needsDecision) return review('needs_decision', { question: `[${name}] ${verdict.needsDecision}` });
      team.reviews = team.reviews.filter(r => r !== step);
      if (verdict.blocking) {
        team.feedback = `[${name}] 고쳐야 할 문제:\n- ${verdict.issues.join('\n- ')}`;
        // Planning cannot declare the goal done until verification runs again after the fix.
        team.blockers = verdict.issues.map(i => `[${name}] ${i}`);
        const pendingReviews = [step, ...team.reviews];
        team.reviewNotes = [];
        team.cycle = (team.cycle ?? 1) + 1;
        team.reviews = [...new Set(pendingReviews)];
        return goTo(team.worker);
      }
      team.reviewNotes = [...team.reviewNotes, ...verdict.issues.map(i => `[${name}] ${i}`)];
      return advance();
    }
    if (WORKERS.includes(step)) {
      team.workSinceQa = true;
      team.reviews = [...new Set([...team.reviews, ...(result.requiredReviews ?? [])])].filter(r => REVIEWS.includes(r));
      // Progress means new evidence or a workspace change not seen before; only development rounds count.
      const diffIsNew = Boolean(result.diffHash) && !goal.recentDiffs.includes(result.diffHash);
      const progressed = evidence.length > goal.bestCriteriaMet || diffIsNew;
      const extra = { bestCriteriaMet: Math.max(evidence.length, goal.bestCriteriaMet),
        recentDiffs: diffIsNew ? [...goal.recentDiffs, result.diffHash].slice(-20) : goal.recentDiffs,
        noProgressRounds: progressed ? 0 : goal.noProgressRounds + 1 };
      if (extra.noProgressRounds >= this.policy.maxNoProgress) return review('no_progress', extra);
      // 신뢰 쌓기: the first results of each kind of work wait for 대장 before the rotation moves on.
      const required = this.trust?.required() ?? 0, seen = this.trust?.count(step) ?? 0;
      if (!result.simulated && seen < required) {
        return { ...advance(extra), status: GoalStatus.REVIEW_REQUIRED, reason: 'trust_review', nextRunAt: null,
          trustReview: { team: step, number: seen + 1, required },
          question: `${TEAMS[step].name} 결과 확인 (신뢰 쌓기 ${seen + 1}/${required}) · 결과를 보고 계속하거나 되돌려 보내 주세요.` };
      }
      return advance(extra);
    }
    const findings = result.findings ?? { feedback: '', improvements: [] };
    // Failing tests or a secret the engine found keep the goal open even if every criterion has proof.
    const gate = (findings.blocking ?? []).map(b => `[엔진 검사] ${b}`);
    team.blockers = gate;
    team.feedback = [...gate, findings.feedback, ...team.reviewNotes].filter(Boolean).join('\n');
    team.reviewNotes = [];
    if (proven && !gate.length) return finish(findings.improvements ?? []);
    // The same criteria still unproven at two verifications in a row, with no work step in between: another
    // plan → review → verify round cannot change the answer, so 대장 is asked instead of spending more usage.
    const unproven = goal.completionCriteria.filter(c => !evidence.some(e => e.criterion === c));
    const stalled = !gate.length && unproven.length > 0 && !team.workSinceQa && Array.isArray(team.lastUnproven)
      && team.lastUnproven.length === unproven.length && unproven.every(c => team.lastUnproven.includes(c));
    team.lastUnproven = unproven;
    team.workSinceQa = false;
    // Only criteria that no file or engine check can prove are left (the verifier said so, or the engine proved just the
    // work-folder part): another round cannot prove them either, so 대장 is asked right after this first verification.
    const claimFor = c => (result.claims ?? []).find(k => k.criterion === c);
    const personOnly = !gate.length && unproven.length > 0 && unproven.every(c => claimFor(c)?.person === true || claimFor(c)?.check === 'partial');
    if (personOnly) {
      team.awaitingJudgement = unproven;
      return review('needs_decision', { question: `[검증팀] 남은 조건은 파일이나 엔진 검사로 증명할 수 없어 대장 판단이 필요합니다:\n`
        + unproven.map(c => `- ${c}${claimFor(c)?.check === 'partial' ? ` (${claimFor(c).detail})` : ''}`).join('\n')
        + '\n‘완료로 확인’을 누르거나, 고칠 점을 답으로 보내 주세요. 조건을 바꾸자고 답하면 기획팀이 새 조건을 제안합니다.' });
    }
    if (stalled) {
      team.awaitingJudgement = unproven;
      return review('needs_decision', { question: `[검증팀] 엔진이 확인하지 못한 완료 조건이 두 번 연속 그대로입니다 (그 사이 작업 없음):\n- ${unproven.join('\n- ')}\n`
        + '‘완료로 확인’을 누르거나, 고칠 점을 답으로 보내 주세요. 조건을 바꾸자고 답하면 기획팀이 새 조건을 제안합니다.' });
    }
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
      // A limit hit during a step: with 한도 자동 전환 on, the step waits and the next claim moves it to the other
      // subscription if that one has room (or keeps waiting until either has room), instead of stopping for 대장.
      const switchPolicy = this.registry?.getPolicy(`project:${goal.projectId}`).allowProviderSwitch;
      if (kind === 'limit' && goal.kind === 'team'
        && (switchPolicy === true || (switchPolicy !== false && this.autoSwitch?.() !== false))) {
        return { status: GoalStatus.MODEL_WAIT, waitingFrom: GoalStatus.SCHEDULED,
          reason: 'usage_unavailable_or_limited', nextRunAt: iso(now) };
      }
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
    const collaborative = this.collaborativeAssignment(goal);
    // Waiting for an independent reviewer or a capable tool is never skipped by a team's model pick.
    if (collaborative && collaborative.state !== 'ready') return collaborative;
    const executor = this.stepExecutor(goal);
    if (!this.registry) return { state: 'ready', model: null, source: 'executor_default', policyVersion: null };
    const project = this.registry.getPolicy(`project:${goal.projectId}`);
    // 대장's pick for this team (model · reasoning level), when this round runs on the tool it was picked for.
    const pick = goal.kind === 'team' ? project.teamModels?.[goal.team?.step] : null;
    if (pick && pick.executor === executor) {
      return namedModel(executor, { state: 'ready', model: pick.model, effort: pick.effort, source: 'team_choice', reason: 'team_choice', policyVersion: project.version });
    }
    if (collaborative) return collaborative;
    const auto = this.autoLevel(goal, executor, project);
    if (auto) return auto;
    return namedModel(executor, { ...resolveModel({ executor, project, task: goal.modelOverride, catalog: this.registry.catalog(),
      context: { team: goal.team?.step, critical: goal.team?.profile?.risk === 'high' || goal.team?.profile?.complexity === 'complex',
        simple: goal.team?.profile?.complexity === 'simple', failures: Math.max(goal.noProgressRounds ?? 0, goal.testFixAttempts ?? 0) } }),
      policyVersion: project.version });
  }

  // requested = what the current/last round asked for, actual = what the tool reported, next = what the
  // next round would use. A settings change shows up as changePending, never as a changed actual model.
  modelStatus(goalId) {
    const goal = this.store.getGoal(goalId);
    const run = this.store.listRuns(goalId).at(-1);
    const next = this.resolveFor(goal);
    return { executor: this.stepExecutor(goal), requested: run?.requestedModel ?? null, actual: goal.activeModel ?? null,
      next: next.model, nextState: next.state,
      effort: run?.requestedEffort ?? null, nextEffort: next.effort ?? null, reason: next.reason ?? next.source,
      comparison: next.comparison ?? [], requiredCapabilities: next.needs ?? [], proposalReason: next.proposalReason ?? null,
      changePending: Boolean(run) && (next.state !== 'ready' || next.model !== run.requestedModel) };
  }

  // 제어팀: a team with no model pick gets a model and reasoning level sized to the work (see model-levels.js).
  // Pinned models, 대장's team picks and verified adaptive catalogs come first; turned off with models.auto.
  autoLevel(goal, executor, project) {
    if (goal.kind !== 'team' || this.autoLevels?.() === false) return null;
    if (project.mode === 'pinned' || goal.modelOverride?.mode === 'pinned') return null;
    if (project.strategy === 'adaptive' && this.registry.catalog().some(e => e.executor === executor && isUsable(e))) return null;
    const level = levelFor({ team: goal.team?.step ?? 'plan', profile: goal.team?.profile ?? null,
      failures: Math.max(goal.noProgressRounds ?? 0, goal.testFixAttempts ?? 0) });
    const choice = levelChoice(executor, level, { codexModels: this.codexModels?.() ?? [] });
    if (!choice) return null;
    return { state: 'ready', model: choice.model, effort: choice.effort, source: 'auto_level', reason: 'auto_level',
      level: { id: level.id, label: level.label, why: level.why }, policyVersion: project.version };
  }

  // Recorded on a run that another subscription took over; a review on the worker's own tool is not independent.
  switchNote(goal) {
    const planned = this.plannedExecutor(goal), executor = this.stepExecutor(goal);
    if (planned === executor) return {};
    const step = goal.team?.step;
    const worker = this.store.listRuns(goal.id).slice().reverse().find(r => WORKERS.includes(r.team) && !r.simulated);
    const sameAsWorker = (REVIEWS.includes(step) || step === 'qa') && worker?.executor === executor;
    void this.store.emit({ type: 'goal.provider_switched', goalId: goal.id, team: step, from: planned, to: executor, sameAsWorker });
    return { switchedFrom: planned, ...(sameAsWorker ? { sameAsWorker: true } : {}) };
  }

  // 대장's controls (시작·멈춤·오늘만 N단계 더 …) shown in the project conversation. Display only: team prompts are
  // built from the objective and feedback, never from these lines.
  withControl(goal, text) {
    return [...(goal.messages ?? []), { role: 'user', kind: 'control', text, at: iso(this.clock.now()) }].slice(-100);
  }

  update(goal, changes) {
    Object.assign(goal, changes, { updatedAt: iso(this.clock.now()) });
    return this.store.saveGoal(goal);
  }

  collaborativeAssignment(goal) {
    if (goal.kind !== 'team' || !this.registry) return null;
    const project = this.registry.getPolicy(`project:${goal.projectId}`);
    if (!project.allowProviderSwitch) return null;
    const team = goal.team?.step ?? 'plan';
    const reviewing = REVIEWS.includes(team) || team === 'qa';
    // Legacy development routing stays intact. Other teams can reassign on quota loss,
    // but only through the same verified capability and independent-review filters.
    if (project.strategy !== 'adaptive' && !reviewing && (goal.team?.step === 'dev'
      || !this.capacity || this.capacity(TEAMS[goal.team?.step ?? 'plan'].executor))) return null;
    const workerRun = this.store.listRuns(goal.id).slice().reverse().find(r => WORKERS.includes(r.team) && !r.simulated);
    const profile = WORKERS.includes(team) ? goal.team?.profile ?? {} : {};
    return { ...selectAssignment({ catalog: this.registry.catalog(), profile, team, project,
      override: goal.modelOverride, capacity: this.capacity,
      ...(this.capabilities ? { runtimeCapabilities: this.capabilities(team) } : {}),
      excludeExecutor: REVIEWS.includes(team) || team === 'qa' ? workerRun?.executor ?? null : null,
      evaluations: this.store.listEvals?.() ?? [] }), policyVersion: project.version };
  }
}
