import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { lastDue } from './요약.js';
import { listWorkspaceFiles } from './완료근거.js';
import { ATTACH_DIR, attachmentKind, attachmentNote, attachmentProblem, checkAttachments, DEFAULT_MAX_MB } from './첨부파일.js';

// 반복 실행 (routines): a project runs again on a schedule — every day or on one weekday at HH:MM. Each round is a new
// goal with the project's last objective and criteria plus one engine-checked criterion that this round actually
// updated its results (so last round's files cannot pass for today's). A round is skipped while the previous one is
// still open; after the PC was off, only the latest missed time runs, once. Usage limits and the daily step limit
// apply as for any goal.
// 첨부 계기 (kind 'files'): a round starts when new files land in the project's attachments/ folder (dropped there in
// Explorer, synced in, …) instead of at a time. A file must have stopped changing for SETTLE_MS, and passes the same
// checks as an upload (type, content matches type, size, no secret in text); the engine's own Markdown conversions
// next to documents never count. Files that arrive while a round is open wait for it to end; files 대장 attaches in the
// conversation belong to that conversation and never start a round (markSeen).
const KEY = 'routines';
export const SETTLE_MS = 15_000;
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const WEEKDAY_L = { sun: '일', mon: '월', tue: '화', wed: '수', thu: '목', fri: '금', sat: '토' };
export const FRESH_CRITERION = '이번 회차에 결과 파일을 새로 갱신했다';
const OPEN = ['scheduled', 'running', 'review_required', 'model_wait', 'retry_wait', 'paused', 'blocked', 'recovery_required'];
const pad = n => String(n).padStart(2, '0');
// Local wall-clock time as 대장 reads it ("2026. 10. 2. 09:48"); an ISO slice showed UTC ("00:48") in the real test.
const localStamp = ms => { const d = new Date(ms); return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}. ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export const routineLabel = r => r.kind === 'files' ? '첨부 폴더에 새 파일이 들어오면'
  : r.kind === 'weekly' ? `매주 ${WEEKDAY_L[r.weekday]}요일 ${r.time}` : `매일 ${r.time}`;

// attachments/ as the trigger sees it: { name: "size:mtime" } for each plain file, without the engine's conversions
// (x.hwp.md beside x.hwp) and hidden files. Links and folders are skipped.
export function attachmentListing(cwd) {
  const dir = path.join(cwd, ATTACH_DIR), out = {};
  let names = [];
  try { if (lstatSync(dir).isSymbolicLink()) return out; names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    if (/\.md$/i.test(name) && attachmentKind(name.slice(0, -3)) === 'document' && names.includes(name.slice(0, -3))) continue;
    try { const s = lstatSync(path.join(dir, name)); if (s.isFile()) out[name] = `${s.size}:${Math.floor(s.mtimeMs)}`; } catch { /* gone */ }
  }
  return out;
}

export class Routines {
  // convert(cwd, rel): the engine's document conversion (kordoc), so a dropped .hwp gets its Markdown like an upload.
  constructor({ store, scheduler, workspaces, clock = { now: () => Date.now() }, convert = null, maxMB = () => DEFAULT_MAX_MB }) {
    Object.assign(this, { store, scheduler, workspaces, clock, convert, maxMB });
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
    const kind = ['daily', 'weekly', 'files'].includes(input.kind) ? input.kind : null;
    if (!kind) throw new Error('routine kind must be daily, weekly or files');
    if (kind !== 'files' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.time ?? ''))) throw new Error('routine time must be HH:MM');
    if (kind === 'weekly' && !WEEKDAYS.includes(input.weekday)) throw new Error('routine weekday must be sun..sat');
    const now = this.clock.now();
    // Starts counting from now: a time already past today does not fire at once, and files already in attachments/ do not.
    const routine = { projectId, enabled: true, kind, ...(kind === 'files' ? { seen: attachmentListing(this.workspaces.resolve(projectId)) } : { time: input.time }),
      ...(kind === 'weekly' ? { weekday: input.weekday } : {}),
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
    if (!r?.enabled || r.kind === 'files') return null;
    // the first due time after now: look one day (or a week) ahead
    const ahead = lastDue(r.kind, { time: r.time, weekday: r.weekday }, now + (r.kind === 'weekly' ? 7 : 1) * 86_400_000);
    return ahead ? new Date(ahead).toISOString() : null;
  }

  view(projectId) {
    const r = this.get(projectId);
    if (!r) return null;
    // "최근" shows how the last round ended once it has (2026-10-02 routine test: the card kept "1회차 시작" after the
    // round was verified). A later skip note is left as it is.
    const g = r.round && String(r.lastResult ?? '').startsWith(`${r.round}회차 시작`)
      ? this.store.listGoals().find(x => x.projectId === projectId && !x.lane && x.routine?.round === r.round) : null;
    const ended = g?.status === 'verified' ? `${r.round}회차 완료 (${localStamp(Date.parse(g.updatedAt))})`
      : g && ['review_required', 'blocked', 'recovery_required'].includes(g.status) ? `${r.round}회차 멈춤 · 대장 확인 필요` : null;
    return { ...r, ...(ended ? { lastResult: ended } : {}), label: routineLabel(r), nextRunAt: this.nextRunAt(r) };
  }

  async tick(now = this.clock.now()) {
    const started = [];
    for (const r of Object.values(this.all())) {
      if (!r.enabled) continue;
      if (r.kind === 'files') { const s = await this.filesTick(r, now); if (s) started.push(s); continue; }
      const due = lastDue(r.kind, { time: r.time, weekday: r.weekday }, now);
      if (due && due > Date.parse(r.lastRunAt ?? 0)) started.push(await this.run(r.projectId, { due }));
    }
    return started;
  }

  // 첨부 계기: new or changed files in attachments/ that have settled start a round with those files.
  async filesTick(r, now) {
    let cwd;
    try { cwd = this.workspaces.resolve(r.projectId); } catch { return null; }
    const listing = attachmentListing(cwd), seen = r.seen ?? {};
    const fresh = Object.keys(listing).filter(n => seen[n] !== listing[n]);
    // still being copied or saved: wait until it stops changing
    const settled = fresh.filter(n => now - Number(listing[n].split(':')[1]) >= SETTLE_MS);
    if (!settled.length) return null;
    const accepted = [], refused = [];
    for (const name of settled) {
      let problem;
      try { problem = attachmentProblem(name, readFileSync(path.join(cwd, ATTACH_DIR, name)), { maxMB: this.maxMB() }); } catch { problem = 'cannot read file'; }
      (problem ? refused : accepted).push(problem ? { name, problem } : name);
    }
    const save = patch => { const map = this.all(); map[r.projectId] = { ...map[r.projectId], ...patch }; this.save(map); };
    // Refused files are recorded once and never retried until they change.
    const markSeen = names => Object.fromEntries(names.map(n => [n, listing[n]]));
    if (!accepted.length) {
      save({ seen: { ...seen, ...markSeen(refused.map(x => x.name)) }, lastResult: `건너뜀 · 받을 수 없는 파일 ${refused.length}개 (${refused.map(x => x.name).join(', ').slice(0, 120)})` });
      await this.store.emit({ type: 'routine.files_refused', projectId: r.projectId, files: refused });
      return null;
    }
    const result = await this.run(r.projectId, { files: accepted.map(n => `${ATTACH_DIR}/${n}`), refused: refused.map(x => x.name) });
    if (result?.waiting) return null;
    // Everything there now has been handed to this round (or refused).
    save({ seen: { ...seen, ...markSeen([...accepted, ...refused.map(x => x.name)]) } });
    return result;
  }

  // Files 대장 attached in the conversation are part of that conversation, not a trigger.
  markSeen(projectId, names = null) {
    const map = this.all(), r = map[projectId];
    if (r?.kind !== 'files') return;
    const listing = attachmentListing(this.workspaces.resolve(projectId));
    const pick = names ? Object.fromEntries(names.filter(n => listing[n]).map(n => [n, listing[n]])) : listing;
    map[projectId] = { ...r, seen: { ...(r.seen ?? {}), ...pick } };
    this.save(map);
  }

  // One round now (on schedule, on new attachments, or 대장's "지금 한 번 실행").
  async run(projectId, { due = this.clock.now(), manual = false, files = null, refused = [] } = {}) {
    const map = this.all(), r = map[projectId];
    if (!r && !manual) return null;
    const src = this.source(projectId);
    if (!src) throw new Error('project not found');
    const at = new Date(this.clock.now()).toISOString();
    // A goal 대장 made and never started is not a round in progress (2026-10-02 real test: a routine set on a new
    // project fired on time and was skipped as "previous round still open" though nothing had ever run). The round
    // takes that goal over instead of leaving it idle beside a new one.
    const openGoals = this.store.listGoals().filter(g => g.projectId === projectId && OPEN.includes(g.status));
    const idle = openGoals.filter(g => g.status === 'scheduled' && g.autoRun !== true && !(g.round > 0) && !g.criteriaApprovalPending
      && !g.lane && (g.completionCriteria ?? []).length > 0 && !(this.store.listRuns?.(g.id) ?? []).length);
    if (openGoals.length > idle.length) {
      if (manual) throw new Error('the previous round is still open');
      // New attachments are not lost: they wait for the open round to end (the note is written once).
      if (files) {
        const note = `대기 · 진행 중인 회차가 끝나면 새 첨부 ${files.length}개로 시작`;
        if (r.lastResult !== note) { map[projectId] = { ...r, lastResult: note }; this.save(map); }
        return { waiting: true };
      }
      map[projectId] = { ...r, lastRunAt: new Date(due).toISOString(), lastResult: `건너뜀 · 이전 회차가 아직 진행 중 (${localStamp(this.clock.now())})` };
      this.save(map);
      await this.store.emit({ type: 'routine.skipped', projectId, reason: 'previous round open' });
      return { skipped: true };
    }
    const round = (r?.round ?? 0) + 1;
    const stamp = localStamp(this.clock.now());
    const base = String(src.objective).replace(/\n\n\[반복 실행 [\s\S]*$/, '');
    const criteria = [...src.completionCriteria.filter(c => c !== FRESH_CRITERION), FRESH_CRITERION];
    let objective = `${base}\n\n[반복 실행 ${round}회차 · ${stamp}] 이전 회차 결과를 오늘 기준으로 다시 확인하고, 결과 파일을 새로 갱신한다.`;
    if (files) {
      const cwd = this.workspaces.resolve(projectId);
      // A dropped 한글·오피스 document gets the engine's Markdown first, as an upload does.
      for (const rel of files) if (attachmentKind(rel) === 'document' && !existsSync(path.join(cwd, `${rel}.md`))) { try { await this.convert?.(cwd, rel); } catch { /* note says 변환본 없음 */ } }
      objective = `${base}\n\n[반복 실행 ${round}회차 · 첨부 계기 · ${stamp}] 첨부 폴더에 새로 들어온 파일을 반영해 결과 파일을 새로 갱신한다.`
        + attachmentNote(checkAttachments(cwd, files.map(p => ({ path: p }))))
        + (refused.length ? `\n(받지 않은 파일 ${refused.length}개는 형식·내용 검사에서 걸러 넣지 않았다: ${refused.join(', ')})` : '');
    }
    const unstarted = idle.find(g => g.id === src.id);
    const goal = unstarted
      ? (this.scheduler.update(unstarted, { objective, completionCriteria: criteria, autoRun: true, nextRunAt: at, reason: null }), unstarted)
      : this.scheduler.addGoal({ projectId, kind: 'team', autoRun: true, title: src.title, objective, completionCriteria: criteria });
    this.scheduler.update(goal, { routine: { round, startedAt: at, baseline: this.baseline(projectId) },
      messages: this.scheduler.withControl(goal, `반복 실행 ${round}회차 시작${manual ? ' (대장이 지금 실행)' : ` · ${routineLabel(r)}`}${files ? ` · ${files.map(f => path.basename(f)).join(', ').slice(0, 160)}` : ''}`) });
    map[projectId] = { ...(r ?? { projectId, enabled: false, kind: 'daily', time: '09:00' }), round, lastRunAt: new Date(due).toISOString(),
      lastResult: `${round}회차 시작 (${stamp})` };
    this.save(map);
    await this.store.emit({ type: 'routine.started', projectId, goalId: goal.id, round, manual, ...(files ? { files } : {}) });
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
