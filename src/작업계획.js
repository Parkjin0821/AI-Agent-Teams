// 작업 계획 (자율 작업 조율 1단계): the planning team turns the goal into a task graph once — each task with its team,
// inputs, outputs, the completion criteria it serves, the tasks it waits for and what to do if it fails — and the
// engine checks the graph before anything runs (every criterion served, no cycle, outputs inside the work folder, real
// teams). Then planning picks the next task by its id, and a task is done when the engine has proven its criteria.
// The completion criteria, the evidence engine, the approval policy and the teams' permissions are unchanged: the graph
// only says who does what in which order.
const TEAMS = ['research', 'dev', 'design'];
const TEAM_L = { research: '조사팀', dev: '개발팀', design: '디자인팀' };
export const MAX_TASKS = 12;
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const cleanPath = p => String(p ?? '').trim().replace(/\\/g, '/').replace(/^\.\//, '');

// The tasks as the planning team wrote them ("tasks" in its plan JSON), normalised. Unknown fields are dropped.
export function parseTasks(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, MAX_TASKS).map((t, i) => ({
    id: /^T\d{1,2}$/.test(String(t?.id ?? '')) ? String(t.id) : `T${i + 1}`,
    title: clip(t?.title, 120),
    team: String(t?.team ?? ''),
    inputs: (Array.isArray(t?.inputs) ? t.inputs : []).map(x => clip(x, 160)).filter(Boolean).slice(0, 8),
    outputs: (Array.isArray(t?.outputs) ? t.outputs : []).map(cleanPath).filter(Boolean).slice(0, 8),
    criteria: (Array.isArray(t?.criteria) ? t.criteria : []).map(Number).filter(n => Number.isInteger(n) && n >= 1).slice(0, 20),
    dependsOn: (Array.isArray(t?.depends_on ?? t?.dependsOn) ? (t.depends_on ?? t.dependsOn) : []).map(String).slice(0, 8),
    onFail: clip(t?.on_fail ?? t?.onFail, 200),
  }));
}

// What is wrong with a graph for these criteria (Korean, one line each). Criteria 대장 judges by design need no task.
export function lintTasks(tasks, criteria, { ownerJudged = () => false } = {}) {
  const issues = [];
  if (!tasks?.length) return ['작업 목록(tasks)이 없다 · 완료 조건을 나눠 맡을 작업을 1~12개로 적는다'];
  const ids = new Set();
  for (const t of tasks) {
    const at = `${t.id}`;
    if (ids.has(t.id)) issues.push(`${at}: 작업 번호가 겹친다`);
    ids.add(t.id);
    if (!t.title) issues.push(`${at}: 작업 이름(title)이 없다`);
    if (!TEAMS.includes(t.team)) issues.push(`${at}: 담당 팀은 research·dev·design 중 하나다 (검토·검증은 엔진이 붙인다)`);
    if (!t.outputs.length) issues.push(`${at}: 산출물(outputs)이 없다 · 이 작업이 만들 파일이나 폴더를 적는다`);
    for (const o of t.outputs) if (o.startsWith('/') || /^[A-Za-z]:/.test(o) || o.split('/').includes('..')) issues.push(`${at}: 산출물 ${o} 은 작업 폴더 안 경로가 아니다`);
    for (const n of t.criteria) if (n > criteria.length) issues.push(`${at}: 없는 완료 조건 ${n}번을 맡았다`);
  }
  for (const t of tasks) for (const d of t.dependsOn) if (!ids.has(d)) issues.push(`${t.id}: 선행 작업 ${d} 가 목록에 없다`);
  if (hasCycle(tasks)) issues.push('선행 작업이 서로 기다리는 순환이 있다 · 순서를 한 방향으로 정한다');
  const served = new Set(tasks.flatMap(t => t.criteria));
  criteria.forEach((c, i) => { if (!served.has(i + 1) && !ownerJudged(c)) issues.push(`완료 조건 ${i + 1}번을 맡은 작업이 없다`); });
  return issues;
}

function hasCycle(tasks) {
  const by = new Map(tasks.map(t => [t.id, t])), state = new Map();
  const visit = id => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2 || !by.has(id)) return false;
    state.set(id, 1);
    const cyc = by.get(id).dependsOn.some(visit);
    state.set(id, 2);
    return cyc;
  };
  return tasks.some(t => visit(t.id));
}

// The graph as the engine keeps it on the goal: each task with a status (pending → running → done | failed).
export function startPlan(tasks, at) {
  return { version: 1, at, tasks: tasks.map(t => ({ ...t, status: 'pending', attempts: 0 })) };
}

// Tasks whose prerequisites are all done and that are not done themselves, in plan order.
export function readyTasks(plan) {
  const done = new Set((plan?.tasks ?? []).filter(t => t.status === 'done').map(t => t.id));
  return (plan?.tasks ?? []).filter(t => t.status !== 'done' && t.dependsOn.every(d => done.has(d)));
}

// After a verification: a task is done once every criterion it serves has evidence (a task that serves none is done
// when its step finished). Returns the new plan (unchanged tasks keep their object).
export function settleTasks(plan, criteria, evidence) {
  if (!plan?.tasks) return plan;
  const proven = new Set((evidence ?? []).map(e => e.criterion));
  return { ...plan, tasks: plan.tasks.map(t => {
    if (t.status === 'done') return t;
    const mine = t.criteria.map(n => criteria[n - 1]).filter(Boolean);
    return mine.length && mine.every(c => proven.has(c)) ? { ...t, status: 'done' } : t;
  }) };
}

// The step a task starts: running, one more attempt.
export function markRunning(plan, id) {
  if (!plan?.tasks) return plan;
  return { ...plan, tasks: plan.tasks.map(t => t.id === id ? { ...t, status: 'running', attempts: (t.attempts ?? 0) + 1 } : t) };
}
// A task with no criteria of its own is done when its work step finished.
export function finishStep(plan, id) {
  if (!plan?.tasks) return plan;
  return { ...plan, tasks: plan.tasks.map(t => t.id === id && !t.criteria.length ? { ...t, status: 'done' } : t.id === id && t.status === 'running' ? { ...t, status: 'pending' } : t) };
}

// For the prompts: the whole graph with status (planning), or one task in full (the team doing it).
export function planText(plan) {
  if (!plan?.tasks?.length) return '';
  const ready = new Set(readyTasks(plan).map(t => t.id));
  const ST = { pending: '대기', running: '진행 중', done: '완료', failed: '실패' };
  return plan.tasks.map(t => `- ${t.id} [${ST[t.status] ?? t.status}${ready.has(t.id) && t.status !== 'done' ? ' · 지금 할 수 있음' : ''}] ${TEAM_L[t.team] ?? t.team} · ${t.title}`
    + ` · 산출물: ${t.outputs.join(', ')}${t.criteria.length ? ` · 조건 ${t.criteria.join(',')}번` : ''}${t.dependsOn.length ? ` · 선행: ${t.dependsOn.join(',')}` : ''}`).join('\n');
}
export function taskText(task) {
  if (!task) return '';
  return [`이번 작업 ${task.id}: ${task.title}`, task.inputs.length ? `입력: ${task.inputs.join(', ')}` : '', `산출물: ${task.outputs.join(', ')}`,
    task.criteria.length ? `맡은 완료 조건: ${task.criteria.join(', ')}번` : '', task.onFail ? `실패하면: ${task.onFail}` : ''].filter(Boolean).join('\n');
}
// In words for 대장's criteria approval and the thread.
export function planSummary(plan) {
  if (!plan?.tasks?.length) return '';
  return plan.tasks.map(t => `${t.id} ${TEAM_L[t.team] ?? t.team} · ${t.title}${t.dependsOn.length ? ` (← ${t.dependsOn.join(',')})` : ''}`).join('\n');
}
