import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TEAMS, WORKERS } from './팀.js';

// 정기 요약 (Muse-style daily check-in and weekly report). The engine writes it from its own records
// (goals, runs, approval requests), so it never calls a model and costs no subscription usage.
// 아침 요약 (2026-10-02): the one summary 대장 reads first each morning — what finished since the last one, what waits
// for 대장, what stopped and why, usage left, and a 자율 시험 result if one ended. Saved as Markdown too.
export const DIGEST_KINDS = Object.freeze({ daily: '오늘 요약', weekly: '주간 보고', morning: '아침 요약' });
export const MORNING_TIME = '08:00';
const KEY = 'digest.items';
const KEEP = 30;
const DAY = 24 * 3600_000;
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const STATUS_L = { scheduled: '다음 단계 대기', running: '진행 중', retry_wait: '다시 시도 대기', model_wait: '모델 대기', verified: '완료',
  review_required: '대장 결정 대기', blocked: '멈춤', recovery_required: '복구 필요', paused: '일시정지' };
const REASON_L = { needs_decision: '팀 질문에 답 필요', approval_required: '감시 에이전트 승인 필요', trust_review: '결과 확인 필요 (신뢰 쌓기)',
  criteria_approval_required: '완료 조건 승인 필요', daily_cap: '오늘 단계 한도 도달' };
const teamName = id => TEAMS[id]?.name ?? id;
// Waits only 대장 can end (the scheduler's HELD_FOR_DAEJANG).
const HELD = ['needs_decision', 'approval_required', 'trust_review', 'criteria_approval_required'];
const STOP_L = { no_progress: '3번 연속 진전 없음', awaiting_review: '엔진이 확인 못 한 조건이 남음', unclear_plan: '기획팀이 다음 작업을 못 정함',
  unclear_review: '검토 결과를 읽지 못함', rule_violation: '대장 규칙에 걸리는 변경', interrupted_by_restart: '서버 재시작으로 단계가 끊김',
  test_fix_exhausted: '테스트 수정 2번에도 실패', network_retries_exhausted: '네트워크 오류가 계속됨', auth_error: '로그인 필요 (CLI 인증 오류)',
  limit_error: '구독 사용 한도', permission_error: '권한 오류', unclassified_error: '알 수 없는 오류', invalid_result_error: '실행 결과를 읽지 못함',
  usage_unavailable_or_limited: '사용량 확인 불가 또는 중단 기준', pinned_model_unavailable: '고정한 모델을 쓸 수 없음', lane_wait: '병렬 작업 끝나기를 기다림',
  no_verified_capable_assignment: '쓸 수 있는 모델·도구가 없음', criteria_not_derived: '완료 조건을 정하지 못함' };
const KIND_L = { web: '사이트', connector: '연결 도구', path: '파일 경로' };
const oneLine = (text, n = 90) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const p2 = n => String(n).padStart(2, '0');
// Local time as 대장 reads it: "09:25", or with the date "10. 2. 09:25".
const localTime = (iso, withDate = false) => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '?';
  return `${withDate ? `${d.getMonth() + 1}. ${d.getDate()}. ` : ''}${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
// What a finished project left: the 한글 documents the engine made first, then files the work teams added or changed
// (not the engine's previews, read-backs, captures, attachments or saved web originals).
function resultFiles(runs, n = 4) {
  const docs = [], other = [];
  for (const r of runs ?? []) {
    for (const d of r.documents ?? []) if (d?.path && !docs.includes(d.path)) docs.push(d.path);
    if (!WORKERS.includes(r.team)) continue;
    for (const f of [...(r.checkpoint?.added ?? []), ...(r.checkpoint?.modified ?? [])]) {
      if (/^(attachments|sources)\/|(^|\/)\./.test(f) || /\.(hwpx|xlsx)\.(md|svg|html)$/i.test(f) || other.includes(f)) continue;
      other.push(f);
    }
  }
  const all = [...docs, ...other.filter(f => !docs.includes(f))];
  return all.length > n ? [...all.slice(0, n), `외 ${all.length - n}개`] : all;
}
const PROVIDER_L = { claude: 'Claude', codex: 'Codex' };
const PERIOD_L = { five_hour: '5시간', weekly: '주간' };
// "Claude · 5시간 62% 남음 (13:40 초기화) · 주간 86% 남음 (10. 8. 21:00 초기화)" from the last usage reading.
function usageLines(quota) {
  return (quota?.items ?? []).map(q => {
    const parts = (q.windows ?? []).filter(w => Number.isFinite(w.remaining)).map(w =>
      `${PERIOD_L[w.period] ?? w.period} ${w.remaining}% 남음${w.resetAt ? ` (${localTime(w.resetAt, w.period !== 'five_hour')} 초기화)` : ''}${w.blocked ? ' · 중단 기준 아래' : ''}`);
    return parts.length ? `${PROVIDER_L[q.provider] ?? q.provider} · ${parts.join(' · ')}${q.stale ? ' · 오래된 값' : ''}` : null;
  }).filter(Boolean);
}

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
  // usage(): the last subscription reading ({ items }); waitWhy(goal): the engine's reason a waiting goal's tool may not
  // start now; measureDir: where 자율 시험 results are written; saveDir: where 아침 요약 Markdown files go.
  constructor({ store, approvals = null, clock = { now: () => Date.now() }, setting, usage = () => null, waitWhy = () => null, measureDir = null, saveDir = null }) {
    Object.assign(this, { store, approvals, clock, setting, usage, waitWhy, measureDir, saveDir });
  }

  list() { return this.store.getSettings()[KEY] ?? []; }
  schedule() {
    return { time: this.setting('digest.time', '09:00'), daily: this.setting('digest.daily', true), weekly: this.setting('digest.weekly', 'mon'),
      morning: this.setting('digest.morning', true), morningTime: this.morningTime() };
  }
  // 08:00 unless 대장 set the summary time (digest.time) themselves.
  morningTime() { return this.store.getSettings()['digest.time'] ?? MORNING_TIME; }

  build(kind, now = this.clock.now()) {
    if (!Object.hasOwn(DIGEST_KINDS, kind)) throw new Error('unknown digest kind');
    if (kind === 'morning') return this.buildMorning(now);
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
    const digest = this.saveMarkdown(this.build(kind, now));
    this.store.setSetting(KEY, [digest, ...this.list()].slice(0, KEEP));
    void this.store.emit?.({ type: 'digest.created', kind, digestId: digest.id });
    return digest;
  }

  // 아침 요약: since the previous one (at most a week back), from the engine's own records only.
  buildMorning(now) {
    const prevAt = this.setting('digest.last.morning', null) ?? this.list().find(d => d.kind === 'morning')?.at;
    const from = Math.max(prevAt ? Date.parse(prevAt) : now - DAY, now - 7 * DAY);
    const inWindow = at => at && Date.parse(at) > from && Date.parse(at) <= now;
    const goals = this.store.listGoals().filter(g => !g.lane);
    const titleOf = g => g.title || oneLine(g.objective, 40);
    const ref = (g, extra) => ({ goalId: g.id, projectId: g.projectId, title: titleOf(g), status: g.status, statusL: REASON_L[g.reason] ?? STATUS_L[g.status] ?? g.status,
      steps: 0, teams: [], proven: (g.evidence ?? []).length, total: (g.completionCriteria ?? []).length, ...extra });

    const finished = goals.filter(g => g.status === 'verified' && inWindow(g.updatedAt))
      .map(g => ref(g, { files: resultFiles(this.store.listRuns(g.id)) }));
    const waiting = goals.filter(g => g.status !== 'verified' && (g.criteriaApprovalPending || (g.status === 'review_required' && HELD.includes(g.reason))))
      .map(g => ref(g, { why: g.criteriaApprovalPending ? REASON_L.criteria_approval_required : REASON_L[g.reason],
        ask: g.criteriaApprovalPending ? `완료 조건 ${(g.completionCriteria ?? []).length}개를 확인하고 승인` : g.reason === 'trust_review' ? '바뀐 파일을 보고 계속할지 결정'
          : g.reason === 'approval_required' ? '감시 에이전트가 멈춘 동작 (아래 승인 요청)' : oneLine(g.question, 110) }));
    const pending = (this.approvals?.pending() ?? []).map(a => ({ kind: a.kind, target: oneLine(a.target, 80), team: teamName(a.team),
      project: titleOf(goals.find(g => g.projectId === a.project) ?? { objective: a.project }) }));
    const stopped = goals.filter(g => g.reason === 'daily_cap' || ['model_wait', 'blocked', 'recovery_required'].includes(g.status)
      || (g.status === 'review_required' && !HELD.includes(g.reason) && !g.criteriaApprovalPending))
      .map(g => ref(g, { why: g.reason === 'daily_cap' ? '오늘 단계 한도 도달 · 자정 뒤 이어서'
        : g.status === 'model_wait' ? `모델 대기 · ${this.waitWhy(g) ?? STOP_L[g.reason] ?? g.reason ?? '사용량 확인 중'}`
        : `멈춤 · ${STOP_L[g.reason] ?? g.reason ?? '이유 기록 없음'}` }));
    const usage = usageLines(this.usage());
    const measure = this.measurement(inWindow);

    const counts = `완료 ${finished.length}개 · 대장 결정 대기 ${waiting.length + pending.length}건 · 멈춤 ${stopped.length}개`;
    const cap = (list, f, n = 8) => [...list.slice(0, n).map(f), ...(list.length > n ? [`외 ${list.length - n}개`] : [])];
    const sections = [
      { id: 'finished', title: '밤사이 끝난 일', lines: finished.length ? cap(finished, p => `${p.title} · 조건 ${p.proven}/${p.total}${p.files.length ? ` · 결과 ${p.files.join(', ')}` : ''}`)
        : ['지난 요약 뒤로 끝난 프로젝트는 없습니다.'] },
      { id: 'waiting', title: '대장을 기다리는 일', lines: waiting.length || pending.length
        ? [...cap(waiting, p => `${p.title} · ${p.why}${p.ask ? ` · ${p.ask}` : ''}`), ...cap(pending, a => `감시 에이전트 승인 · ${a.project} · ${a.team} · ${KIND_L[a.kind] ?? a.kind} ${a.target}`, 5)]
        : ['대장이 결정할 일은 없습니다.'] },
      { id: 'stopped', title: '멈춘 일과 이유', lines: stopped.length ? cap(stopped, p => `${p.title} · ${p.why}`) : ['멈춘 프로젝트는 없습니다.'] },
      { id: 'usage', title: '남은 사용량', lines: usage.length ? usage : ['확인된 사용량이 없습니다.'] },
      ...(measure ? [{ id: 'measure', title: '자율 시험 결과', lines: measure.lines }] : []),
    ];
    const lines = [counts, ...(waiting.length || pending.length ? [`먼저 볼 것: ${waiting[0] ? `${waiting[0].title} · ${waiting[0].why}` : `감시 에이전트 승인 ${pending.length}건`}`] : []),
      ...usage.slice(0, 2), ...(measure ? [measure.lines[0]] : [])];
    return { id: randomUUID(), kind: 'morning', title: DIGEST_KINDS.morning, at: new Date(now).toISOString(), from: new Date(from).toISOString(),
      lines, sections, projects: [...waiting, ...stopped, ...finished].slice(0, 12),
      totals: { finished: finished.length, decisions: waiting.length, approvalsWaiting: pending.length, stopped: stopped.length } };
  }

  // The newest 자율 시험 record that ended in the window: "자율 완료 N/M" as scripts/자율시험.mjs counts it (no 대장 step
  // other than the final judgement it was built to leave).
  measurement(inWindow) {
    if (!this.measureDir || !existsSync(this.measureDir)) return null;
    const recs = readdirSync(this.measureDir).filter(f => /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(f)).sort().reverse();
    for (const f of recs) {
      let rec;
      try { rec = JSON.parse(readFileSync(path.join(this.measureDir, f), 'utf8')); } catch { continue; }
      if (!inWindow(rec?.endedAt) || !Array.isArray(rec.items)) continue;
      const real = it => (it.interventions ?? []).filter(x => !x.final);
      const alone = rec.items.filter(it => !real(it).length && (it.status === 'verified' || (it.interventions ?? []).some(x => x.final))).length;
      return { file: f, alone, total: rec.items.length, lines: [`자율 완료 ${alone}/${rec.items.length} (${localTime(rec.startedAt)} 시작 · ${localTime(rec.endedAt)} 끝)`,
        ...rec.items.map(it => `${it.kind} · ${STATUS_L[it.status] ?? it.status ?? '?'}${it.reason ? ` (${REASON_L[it.reason] ?? STOP_L[it.reason] ?? it.reason})` : ''} · 조건 ${it.met ?? 0}/${it.total ?? 0}${real(it).length ? ` · 대장 개입 ${real(it).length}번` : ''}`)] };
    }
    return null;
  }

  // 아침 요약 as a Markdown file under saveDir (data, not committed), so it can be opened later.
  saveMarkdown(digest) {
    if (digest.kind !== 'morning' || !this.saveDir) return digest;
    try {
      mkdirSync(this.saveDir, { recursive: true });
      const d = new Date(digest.at), p = n => String(n).padStart(2, '0');
      const file = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-아침요약.md`;
      const md = [`# 아침 요약 · ${localTime(digest.at, true)}`, '', `지난 요약 뒤로 (${localTime(digest.from, true)}부터) 엔진 기록으로 작성 · AI 호출 없음`, '',
        `**${digest.lines[0]}**`, '', ...digest.sections.flatMap(s => [`## ${s.title}`, '', ...s.lines.map(l => `- ${l}`), ''])].join('\n');
      writeFileSync(path.join(this.saveDir, file), md, 'utf8');
      return { ...digest, file };
    } catch { return digest; }
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
    const { time, daily, weekly, morning, morningTime } = this.schedule();
    const made = [];
    for (const kind of ['morning', 'daily', 'weekly']) {
      if (kind === 'morning' && morning !== true) continue;
      if (kind === 'daily' && daily !== true) continue;
      if (kind === 'weekly' && !WEEKDAYS.includes(weekly)) continue;
      const due = lastDue(kind === 'weekly' ? 'weekly' : 'daily', { time: kind === 'morning' ? morningTime : time, weekday: weekly }, now);
      if (due === null) continue;
      const lastAt = this.setting(`digest.last.${kind}`, null) ?? this.list().find(d => d.kind === kind && d.scheduled)?.at;
      if (lastAt && Date.parse(lastAt) >= due) continue;
      const digest = this.saveMarkdown({ ...this.build(kind, now), scheduled: true });
      this.store.setSetting(KEY, [digest, ...this.list()].slice(0, KEEP));
      this.store.setSetting(`digest.last.${kind}`, digest.at);
      void this.store.emit?.({ type: 'digest.created', kind, digestId: digest.id });
      made.push(digest);
    }
    return made;
  }
}
