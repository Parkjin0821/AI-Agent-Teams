import { PACKAGE_DIR, kindsOf } from './결과패키지.js';

// 목표 중심 측정 (자율 작업 조율 6번): six measures of how well a project was understood, split, handed out, handed
// over and finished — not only whether it ended verified. Nothing here takes a team's word for anything: each measure
// reads the engine's own records (task graph, runs, events, evidence), checks the files in the work folder, or compares
// with an evaluation rubric written before the run (rubric = { requirements, goalChecks }). 대장's own review, when
// given, is shown beside the measured goal score, never mixed into it.
//   requirements: [{ name, match: RegExp, teams: ['research' | 'dev' | 'design', ...] }] — what the goal needs done;
//     match is tried on each task's title, outputs and the criteria it serves.
//   goalChecks: [{ name, file: RegExp, contains?: RegExp, min?: number, sources?: boolean }] — what the result must
//     contain for the original goal (at least `min` matching files, or `min` matches of `contains` in them).
export const METRICS = [
  ['decomposition', '업무 분해 정확도'],
  ['assignment', '팀 배정 적합도'],
  ['handoff', '인계 완전성'],
  ['rework', '재작업 비율'],
  ['package', '산출물 정리 완성도'],
  ['goal', '실제 목표 달성률'],
];
const WORK = ['research', 'dev', 'design'];
const PACKAGE_FILES = ['PROJECT_SUMMARY.md', 'TASK_MANIFEST.json', 'DECISIONS.md', 'OPEN_ISSUES.md', 'HANDOFF.md', 'evidence/evidence.json'];
const ENGINE_FILE = /^(reports\/|\.hq)/;
const ratio = (a, b) => (b ? a / b : null);

const taskText = (t, criteria) => [t.title, ...(t.outputs ?? []), ...(t.criteria ?? []).map(n => criteria[n - 1] ?? '')].join(' ');

// 1. Every requirement of the rubric is covered by some task of the graph (no graph: nothing was split).
export function decomposition(goal, rubric) {
  const tasks = goal.taskPlan?.tasks ?? [];
  const reqs = rubric?.requirements ?? [];
  if (!reqs.length) return { score: null, basis: '평가 기준 없음', misses: [] };
  if (!tasks.length) return { score: 0, basis: '작업 그래프 없음 (기획팀이 단계마다 다음 팀만 고름)', misses: reqs.map(r => r.name) };
  const crit = goal.completionCriteria ?? [];
  const misses = reqs.filter(r => !tasks.some(t => r.match.test(taskText(t, crit)))).map(r => r.name);
  return { score: ratio(reqs.length - misses.length, reqs.length), basis: `작업 ${tasks.length}개 · 평가 기준 요구사항 ${reqs.length}개 대조`, misses };
}

// 2. The tasks covering a requirement belong to a team the rubric allows; and the team that really ran a task (engine
// record task.assigned) is the one the graph named.
export function assignment(goal, rubric, events = []) {
  const tasks = goal.taskPlan?.tasks ?? [];
  const crit = goal.completionCriteria ?? [];
  const judged = (rubric?.requirements ?? []).filter(r => r.teams?.length).map(r => ({ r, mine: tasks.filter(t => r.match.test(taskText(t, crit))) })).filter(x => x.mine.length);
  const misses = judged.filter(x => !x.mine.some(t => x.r.teams.includes(t.team))).map(x => `${x.r.name} → ${[...new Set(x.mine.map(t => t.team))].join('·')} (기대: ${x.r.teams.join('·')})`);
  const byId = new Map(tasks.map(t => [t.id, t]));
  const ran = events.filter(e => e.type === 'task.assigned' && byId.has(e.task));
  const wrong = ran.filter(e => e.team !== byId.get(e.task).team).map(e => `${e.task} 를 ${e.team} 가 실행 (계획: ${byId.get(e.task).team})`);
  const total = judged.length + ran.length;
  if (!total) return { score: null, basis: tasks.length ? '판단할 작업 없음' : '작업 그래프 없음', misses: [] };
  return { score: ratio(total - misses.length - wrong.length, total), basis: `요구사항 ${judged.length}개의 담당 팀 · 실행 기록 ${ran.length}건`, misses: [...misses, ...wrong] };
}

// 3. A task others wait for, once worked on, handed over: the files it lists exist (checked by the engine when the
// handoff came in) and it says what the next team should know.
export function handoff(goal) {
  const tasks = goal.taskPlan?.tasks ?? [];
  const needed = tasks.filter(t => tasks.some(o => o.dependsOn?.includes(t.id)) && (t.status === 'done' || (t.attempts ?? 0) > 0));
  if (!needed.length) return { score: null, basis: tasks.length ? '이어받을 작업이 아직 없음' : '작업 그래프 없음', misses: [] };
  const misses = needed.map(t => {
    const h = t.handoff;
    const why = !h ? '인계 없음' : !h.made?.length ? '만든 것 목록 없음' : h.made.some(m => !m.ok) ? `엔진이 못 찾은 파일: ${h.made.filter(m => !m.ok).map(m => m.path).join(', ')}` : !h.forNext ? '다음 팀에게 남긴 말 없음' : null;
    return why && `${t.id} ${t.title}: ${why}`;
  }).filter(Boolean);
  return { score: ratio(needed.length - misses.length, needed.length), basis: `후속 작업이 있는 작업 ${needed.length}개의 인계 기록`, misses };
}

// 4. Steps spent again because a plan or a piece of work was wrong: a task's second and later tries, and each re-plan.
// rate = those steps / all steps (lower is better; score = 1 - rate).
export function rework(goal, runs = [], events = []) {
  const steps = runs.filter(r => !r.simulated).length;
  if (!steps) return { score: null, rate: null, basis: '실행 단계 없음', misses: [] };
  const tries = events.filter(e => e.type === 'task.assigned' && ((e.attempt ?? (e.again ? 2 : 1)) > 1));
  const replans = events.filter(e => e.type === 'task.replanned' && (e.version ?? 1) > 1);
  const again = tries.length + replans.length;
  const rate = Math.min(1, again / steps);
  return { score: 1 - rate, rate, basis: `전체 ${steps}단계 중 다시 한 작업 ${tries.length} · 재계획 ${replans.length}`,
    misses: [...tries.map(e => `${e.task} ${e.attempt ?? '?'}번째 시도`), ...replans.map(e => `재계획 ${e.version}판`)] };
}

// 5. The result package is complete and honest: its files exist, every planned output exists, it says how to use what
// was made, the evidence file lists every criterion, and it says 완료 only for a verified project.
export function packageCheck(goal, files, read) {
  const at = f => `${PACKAGE_DIR}/${f}`;
  const checks = [];
  for (const f of PACKAGE_FILES) checks.push([`패키지 파일 ${f}`, files.includes(at(f))]);
  const mine = files.filter(f => !ENGINE_FILE.test(f));
  const outputs = (goal.taskPlan?.tasks ?? []).flatMap(t => t.outputs);
  for (const o of outputs) checks.push([`계획된 산출물 ${o}`, mine.some(f => f === o || f.startsWith(o.replace(/\/?$/, '/')))]);
  const summary = read(at('PROJECT_SUMMARY.md')) ?? '';
  const kinds = kindsOf(mine);
  if (kinds.code) checks.push(['실행 방법(테스트) 안내', /테스트: /.test(summary)]);
  if (kinds.web) checks.push(['실행 방법(화면) 안내', /화면: /.test(summary)]);
  let ev = null;
  try { ev = JSON.parse(read(at('evidence/evidence.json')) ?? 'null'); } catch { ev = null; }
  checks.push(['모든 완료 조건의 근거 기록', !!ev && (goal.completionCriteria ?? []).every(c => ev.criteria?.some(x => x.criterion === c))]);
  const claims = /완료 · 엔진 검증 통과/.test(summary);
  checks.push(['완료 표시가 검증 결과와 일치', !claims || goal.status === 'verified']);
  const misses = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return { score: ratio(checks.length - misses.length, checks.length), basis: `점검 ${checks.length}개 (패키지 파일·산출물·안내·근거·정직성)`, misses };
}

// 6. The original goal, checked on the files themselves against the rubric (not the engine's own criteria).
export function goalCheck(files, read, rubric) {
  const checks = rubric?.goalChecks ?? [];
  if (!checks.length) return { score: null, basis: '평가 기준 없음', misses: [] };
  const mine = files.filter(f => !ENGINE_FILE.test(f));
  const misses = [];
  for (const c of checks) {
    const pool = mine.filter(f => c.file.test(f) && (c.sources || !f.startsWith('sources/')));
    const min = c.min ?? 1;
    let ok;
    if (!c.contains) ok = pool.length >= min;
    else {
      const re = new RegExp(c.contains.source, c.contains.flags.includes('g') ? c.contains.flags : c.contains.flags + 'g');
      ok = pool.reduce((n, f) => n + ((read(f) ?? '').match(re)?.length ?? 0), 0) >= min;
    }
    if (!ok) misses.push(c.name);
  }
  return { score: ratio(checks.length - misses.length, checks.length), basis: `평가 기준 ${checks.length}개를 결과 파일에서 직접 확인`, misses };
}

// All six for one project. read(rel) gives a file's text (null when missing or not text).
export function measureGoal({ goal, runs = [], events = [], files = [], read = () => null, rubric = null }) {
  const mine = events.filter(e => !e.goalId || e.goalId === goal.id);
  return {
    decomposition: decomposition(goal, rubric),
    assignment: assignment(goal, rubric, mine),
    handoff: handoff(goal),
    rework: rework(goal, runs, mine),
    package: packageCheck(goal, files, read),
    goal: goalCheck(files, read, rubric),
  };
}

// The averages over a set of projects (projects with no value for a measure are left out of it).
export function summarize(list) {
  const out = {};
  for (const [key] of METRICS) {
    const vals = list.map(m => (key === 'rework' ? m?.[key]?.rate : m?.[key]?.score)).filter(v => typeof v === 'number');
    out[key] = vals.length ? { value: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length } : { value: null, n: 0 };
  }
  return out;
}

export const pct = v => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '—');
