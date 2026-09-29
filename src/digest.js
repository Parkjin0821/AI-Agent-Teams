import { randomUUID } from 'node:crypto';
import { TEAMS } from './teams.js';

// 정기 요약 (Muse-style daily check-in and weekly report). The engine writes it from its own records
// (goals, runs, approval requests), so it never calls a model and costs no subscription usage.
export const DIGEST_KINDS = Object.freeze({ daily: '오늘 요약', weekly: '주간 보고' });
const KEY = 'digest.items';
const KEEP = 30;
const DAY = 24 * 3600_000;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const STATUS_L = { scheduled: '다음 단계 대기', running: '진행 중', retry_wait: '다시 시도 대기', model_wait: '모델 대기', verified: '완료',
  review_required: '대장 결정 대기', blocked: '멈춤', recovery_required: '복구 필요', paused: '일시정지' };
const REASON_L = { needs_decision: '팀 질문에 답 필요', approval_required: '감시 에이전트 승인 필요', trust_review: '결과 확인 필요 (신뢰 쌓기)',
  criteria_approval_required: '완료 조건 승인 필요', daily_cap: '오늘 단계 한도 도달' };
const teamName = id => TEAMS[id]?.name ?? id;

// When the latest scheduled digest of this kind was due, at or before `now` (local time).
export function lastDue(kind, { time, weekday }, now) {
  const m = /^(\d{2}):(\d{2})$/.exec(time ?? '');
  if (!m) return null;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (kind === 'daily') { if (d.getTime() > now) d.setDate(d.getDate() - 1); return d.getTime(); }
  const want = WEEKDAYS.indexOf(weekday);
  if (want < 0) return null;
  d.setDate(d.getDate() - ((d.getDay() - want + 7) % 7));
  if (d.getTime() > now) d.setDate(d.getDate() - 7);
  return d.getTime();
}

export class Digests {
  constructor({ store, approvals = null, clock = { now: () => Date.now() }, setting }) {
    Object.assign(this, { store, approvals, clock, setting });
  }

  list() { return this.store.getSettings()[KEY] ?? []; }
  schedule() {
    return { time: this.setting('digest.time', '09:00'), daily: this.setting('digest.daily', true), weekly: this.setting('digest.weekly', 'mon') };
  }

  build(kind, now = this.clock.now()) {
    if (!Object.hasOwn(DIGEST_KINDS, kind)) throw new Error('unknown digest kind');
    const from = now - (kind === 'weekly' ? 7 : 1) * DAY;
    const inWindow = at => at && Date.parse(at) >= from && Date.parse(at) <= now;
    const projects = [];
    let steps = 0, done = 0, failed = 0;
    const byTeam = {};
    for (const goal of this.store.listGoals()) {
      const runs = this.store.listRuns(goal.id).filter(r => inWindow(r.finishedAt ?? r.startedAt) && !r.simulated);
      for (const r of runs) {
        steps += 1;
        if (r.outcome === 'completed') done += 1; else if (r.status === 'finished') failed += 1;
        if (r.team) byTeam[r.team] = (byTeam[r.team] ?? 0) + 1;
      }
      const verifiedNow = goal.status === 'verified' && inWindow(goal.updatedAt);
      const waiting = goal.status === 'review_required' || goal.status === 'blocked' || goal.status === 'recovery_required';
      if (!runs.length && !verifiedNow && !waiting) continue;
      const proven = (goal.evidence ?? []).length, total = (goal.completionCriteria ?? []).length;
      projects.push({ goalId: goal.id, projectId: goal.projectId, title: goal.title || String(goal.objective ?? '').slice(0, 40),
        status: goal.status, statusL: REASON_L[goal.reason] ?? STATUS_L[goal.status] ?? goal.status, waiting,
        steps: runs.length, teams: [...new Set(runs.map(r => r.team).filter(Boolean))].map(teamName),
        task: goal.team?.task ? String(goal.team.task).slice(0, 160) : null, proven, total, verified: goal.status === 'verified' });
    }
    const approvalsWaiting = this.approvals ? this.approvals.pending().length : 0;
    const decisions = projects.filter(p => p.waiting).length;
    const period = kind === 'weekly' ? '지난 7일' : '지난 24시간';
    const lines = [
      steps ? `${period} 동안 실제 단계 ${steps}번 (완료 ${done} · 문제 ${failed})` + (Object.keys(byTeam).length
        ? ` · ${Object.entries(byTeam).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${teamName(t)} ${n}`).join(' · ')}` : '')
        : `${period} 동안 실제로 실행한 단계가 없습니다.`,
      ...projects.filter(p => p.verified).map(p => `완료: ${p.title} (조건 ${p.proven}/${p.total})`),
      decisions || approvalsWaiting ? `대장 결정 대기: 프로젝트 ${decisions}개${approvalsWaiting ? ` · 감시 에이전트 승인 요청 ${approvalsWaiting}건` : ''}` : '대장이 결정할 일은 없습니다.',
    ];
    return { id: randomUUID(), kind, title: DIGEST_KINDS[kind], at: new Date(now).toISOString(), from: new Date(from).toISOString(),
      lines, projects, totals: { steps, done, failed, decisions, approvalsWaiting } };
  }

  make(kind, now = this.clock.now()) {
    const digest = this.build(kind, now);
    this.store.setSetting(KEY, [digest, ...this.list()].slice(0, KEEP));
    void this.store.emit?.({ type: 'digest.created', kind, digestId: digest.id });
    return digest;
  }

  // 대장 can delete a summary (or all of them). The schedule remembers its last run separately,
  // so deleting today's scheduled summary does not make the engine write it again.
  remove(id) {
    const items = this.list();
    if (!items.some(d => d.id === id)) throw new Error('digest not found');
    this.store.setSetting(KEY, items.filter(d => d.id !== id));
    return { removed: id };
  }
  clear() {
    const n = this.list().length;
    this.store.setSetting(KEY, []);
    return { removed: n };
  }

  // Called by the engine timer: writes each kind at most once per scheduled time. A time that passed while
  // the server was off is written once on the next start (not repeated for every missed day).
  tick(now = this.clock.now()) {
    const { time, daily, weekly } = this.schedule();
    const made = [];
    for (const kind of ['daily', 'weekly']) {
      if (kind === 'daily' && daily !== true) continue;
      if (kind === 'weekly' && !WEEKDAYS.includes(weekly)) continue;
      const due = lastDue(kind, { time, weekday: weekly }, now);
      if (due === null) continue;
      const lastAt = this.setting(`digest.last.${kind}`, null) ?? this.list().find(d => d.kind === kind && d.scheduled)?.at;
      if (lastAt && Date.parse(lastAt) >= due) continue;
      const digest = { ...this.build(kind, now), scheduled: true };
      this.store.setSetting(KEY, [digest, ...this.list()].slice(0, KEEP));
      this.store.setSetting(`digest.last.${kind}`, digest.at);
      void this.store.emit?.({ type: 'digest.created', kind, digestId: digest.id });
      made.push(digest);
    }
    return made;
  }
}
