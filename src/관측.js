import { readFileSync } from 'node:fs';
import { CAUSE_L, failureCause } from './모델수준.js';
import { TEAMS } from './팀.js';

// 관측 (9차 6번): how the engine has been doing over the last days, counted from its own records only (runs, events,
// the Sentinel log) — no model call, no estimate. Shown on the dashboard's 관측 page.
export function observe({ goals = [], runsOf = () => [], events = [], sentinelLog = null, now = Date.now(), days = 7 }) {
  const since = now - days * 86_400_000;
  const inWindow = iso => Date.parse(iso) >= since;
  const runs = goals.flatMap(g => runsOf(g.id).map(r => ({ ...r, projectId: g.projectId }))).filter(r => r.startedAt && inWindow(r.startedAt) && !r.simulated);
  const teams = {};
  for (const r of runs) {
    const t = teams[r.team ?? 'task'] ??= { team: r.team ?? 'task', name: TEAMS[r.team]?.name ?? '단일 작업', steps: 0, modelCalls: 0, engineOnly: 0, interrupted: 0, ms: 0, timed: 0 };
    t.steps++;
    if (r.actualModel) t.modelCalls++;
    if (typeof r.answer === 'string' && r.answer.startsWith('엔진 단독 검증')) t.engineOnly++;
    if (r.status === 'interrupted') t.interrupted++;
    const ms = Date.parse(r.finishedAt) - Date.parse(r.startedAt);
    if (Number.isFinite(ms) && ms >= 0) { t.ms += ms; t.timed++; }
  }
  const causes = {};
  for (const r of runs.filter(r => r.team === 'qa' && r.status === 'finished')) {
    const c = failureCause(r);
    if (c !== 'none') causes[c] = (causes[c] ?? 0) + 1;
  }
  const ev = events.filter(e => e.at && inWindow(e.at));
  const count = type => ev.filter(e => e.type === type).length;
  const sentinel = { allow: 0, deny: 0, ask: 0 };
  if (sentinelLog) {
    let lines = [];
    try { lines = readFileSync(sentinelLog, 'utf8').split('\n').filter(Boolean).slice(-20000); } catch { /* none yet */ }
    for (const l of lines) { try { const e = JSON.parse(l); if (e.at && inWindow(e.at) && sentinel[e.decision] !== undefined) sentinel[e.decision]++; } catch { /* bad line */ } }
  }
  const projects = [...new Set(goals.map(g => g.projectId))];
  const topGoals = goals.filter(g => !g.parentGoalId);
  return {
    days, since: new Date(since).toISOString(),
    steps: runs.length, modelCalls: runs.filter(r => r.actualModel).length,
    engineOnly: runs.filter(r => typeof r.answer === 'string' && r.answer.startsWith('엔진 단독 검증')).length,
    teams: Object.values(teams).map(t => ({ ...t, avgMinutes: t.timed ? Math.round(t.ms / t.timed / 6000) / 10 : null })).sort((a, b) => b.steps - a.steps),
    causes: Object.entries(causes).map(([id, n]) => ({ id, label: CAUSE_L[id] ?? id, n })).sort((a, b) => b.n - a.n),
    recovery: { interrupted: runs.filter(r => r.status === 'interrupted').length, resumed: count('goal.resumed_after_restart'), heldForDaejang: count('goal.recovery_required') },
    evidence: { stale: count('goal.evidence_stale') },
    workbench: { steps: count('workbench.used'), calls: ev.filter(e => e.type === 'workbench.used').reduce((n, e) => n + (e.calls ?? 0), 0) },
    publish: { sent: count('publish.sent'), failed: count('publish.failed') + count('publish.unknown') },
    sentinel,
    projects: { total: projects.length, verified: topGoals.filter(g => g.status === 'verified').length,
      waitingForDaejang: topGoals.filter(g => g.status === 'review_required').length, running: topGoals.filter(g => g.status === 'running').length,
      // 10차 2번: of those, the ones whose work finished on its own and wait only for 대장's final look
      ownerApproval: topGoals.filter(g => g.status === 'review_required' && g.reason === 'owner_approval').length },
  };
}
