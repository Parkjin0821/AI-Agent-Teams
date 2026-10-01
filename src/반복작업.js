import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { lastDue } from './요약.js';
import { listWorkspaceFiles } from './완료근거.js';

// 반복 실행 (routines): a project runs again on a schedule — every day or on one weekday at HH:MM. Each round is a new
// goal with the project's last objective and criteria plus one engine-checked criterion that this round actually
// updated its results (so last round's files cannot pass for today's). A round is skipped while the previous one is
// still open; after the PC was off, only the latest missed time runs, once. Usage limits and the daily step limit
// apply as for any goal.
const KEY = 'routines';
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const WEEKDAY_L = { sun: '일', mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토' };
export const FRESH_CRITERION = '이번 회차에 결과 파일을 새로 갱신했다';
const OPEN = ['scheduled', 'running', 'review_required', 'model_wait', 'retry_wait', 'paused', 'blocked', 'recovery_required'];
const pad = n => String(n).padStart(2, '0');

export const routineLabel = r => r.kind === 'weekly' ? `매주 ${WEEKDAY_L[r.weekday]}요일 ${r.time}` : `매일 ${r.time}`;

export class Routines {
  constructor({ store, scheduler, workspaces, clock = { now: () => Date.now() } }) {
    Object.assign(this, { store, scheduler, workspaces, clock });
  }

  all() { return this.store.getSettings()[KEY] ?? {}; }
  get(projectId) { return this.all()[projectId] ?? null; }
  save(map) { this.store.setSetting(KEY, map); }

  // The goal a round copies: the project's newest goal.
  source(projectId) {
    return this.store.listGoals().filter(g => g.projectId === projectId && g.kind === 'team' && !g.lane)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null;
  }

  set(projectId, input = {}) {
    const src = this.source(projectId);
    if (!src) throw new Error('project not found');
    if (typeof input.enabled !== 'boolean') throw new Error('routine needs enabled true or false');
    const map = this.all();
    if (!input.enabled) {
      if (map[projectId]) { map[projectId] = { ...map[projectId], enabled: false }; this.save(map); this.note(src, '반복 실행 끔'); }
      return map[projectId] ?? null;
    }
    const kind = input.kind === 'weekly' ? 'weekly' : input.kind === 'daily' ? 'daily' : null;
    if (!kind) throw new Error('routine kind must be daily or weekly');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.time ?? ''))) throw new Error('routine time must be HH:MM');
    if (kind === 'weekly' && !WEEKDAYS.includes(input.weekday)) throw new Error('routine weekday must be sun..sat');
    const now = this.clock.now();
    // Starts counting from now: a time already past today does not fire at once.
    const routine = { projectId, enabled: true, kind, time: input.time, ...(kind === 'weekly' ? { weekday: input.weekday } : {}),
      round: map[projectId]?.round ?? 0, lastRunAt: new Date(now).toISOString(), lastResult: map[projectId]?.lastResult ?? null,
      setAt: new Date(now).toISOString() };
    map[projectId] = routine;
    this.save(map);
    this.note(src, `반복 실행 켬 · ${routineLabel(routine)}`);
    return routine;
  }

  note(goal, text) {
    this.scheduler.update(goal, { messages: this.scheduler.withControl(goal, text) });
  }

  nextRunAt(r, now = this.clock.now()) {
    if (!r?.enabled) return null;
    // the first due time after now: look one day (or a week) ahead
    const ahead = lastDue(r.kind, { time: r.time, weekday: r.weekday }, now + (r.kind === 'weekly' ? 7 : 1) * 86_400_000);
    return ahead ? new Date(ahead).toISOString() : null;
  }

  view(projectId) {
    const r = this.get(projectId);
    return r ? { ...r, label: routineLabel(r), nextRunAt: this.nextRunAt(r) } : null;
  }

  async tick(now = this.clock.now()) {
    const started = [];
    for (const r of Object.values(this.all())) {
      if (!r.enabled) continue;
      const due = lastDue(r.kind, { time: r.time, weekday: r.weekday }, now);
      if (due && due > Date.parse(r.lastRunAt ?? 0)) started.push(await this.run(r.projectId, { due }));
    }
    return started;
  }

  // One round now (on schedule, or 대장's "지금 한 번 실행").
  async run(projectId, { due = this.clock.now(), manual = false } = {}) {
    const map = this.all(), r = map[projectId];
    if (!r && !manual) return null;
    const src = this.source(projectId);
    if (!src) throw new Error('project not found');
    const at = new Date(this.clock.now()).toISOString();
    const open = this.store.listGoals().some(g => g.projectId === projectId && OPEN.includes(g.status));
    if (open) {
      if (manual) throw new Error('the previous round is still open');
      map[projectId] = { ...r, lastRunAt: new Date(due).toISOString(), lastResult: `건너뜀 · 이전 회차가 아직 진행 중 (${at.slice(0, 16).replace('T', ' ')})` };
      this.save(map);
      await this.store.emit({ type: 'routine.skipped', projectId, reason: 'previous round open' });
      return { skipped: true };
    }
    const round = (r?.round ?? 0) + 1;
    const d = new Date(this.clock.now());
    const stamp = `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const base = String(src.objective).replace(/\n\n\[반복 실행 [\s\S]*$/, '');
    const criteria = [...src.completionCriteria.filter(c => c !== FRESH_CRITERION), FRESH_CRITERION];
    const goal = this.scheduler.addGoal({ projectId, kind: 'team', autoRun: true, title: src.title,
      objective: `${base}\n\n[반복 실행 ${round}회차 · ${stamp}] 이전 회차 결과를 오늘 기준으로 다시 확인하고, 결과 파일을 새로 갱신한다.`,
      completionCriteria: criteria });
    this.scheduler.update(goal, { routine: { round, startedAt: at, baseline: this.baseline(projectId) },
      messages: this.scheduler.withControl(goal, `반복 실행 ${round}회차 시작${manual ? ' (대장이 지금 실행)' : ` · ${routineLabel(r)}`}`) });
    map[projectId] = { ...(r ?? { projectId, enabled: false, kind: 'daily', time: '09:00' }), round, lastRunAt: new Date(due).toISOString(),
      lastResult: `${round}회차 시작 (${stamp})` };
    this.save(map);
    await this.store.emit({ type: 'routine.started', projectId, goalId: goal.id, round, manual });
    return { goalId: goal.id, round };
  }

  // Fingerprints of the work folder when a round starts (what file_updated compares with).
  baseline(projectId) {
    const cwd = this.workspaces.resolve(projectId), out = {};
    for (const f of listWorkspaceFiles(cwd, 2000)) {
      const full = path.join(cwd, f);
      try { if (statSync(full).size <= 2_000_000) out[f] = createHash('sha256').update(readFileSync(full)).digest('hex'); } catch { /* gone */ }
    }
    return out;
  }
}
