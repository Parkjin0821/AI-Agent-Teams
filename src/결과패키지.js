import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// 결과 패키지 (자율 작업 조율 4단계): when a project finishes, stops for 대장 or gets stuck, the engine writes a package
// another person or AI can pick up and continue from — what the goal was, what exists, what is proven and how, what was
// decided, what is still open and where to start. Everything comes from the engine's own records (goal, task graph,
// evidence, runs, events); a status says 완료 only when verification passed. What the package stresses follows what
// the project made (code → how to run the tests, a web page → what to open, a 한글 document, slides, research sources).
export const PACKAGE_DIR = 'reports/결과패키지';
const TEAM_L = { plan: '기획팀', research: '조사팀', dev: '개발팀', design: '디자인팀', security: '보안팀', policy: '정책팀', qa: '검증팀' };
const OWNER = /\(대장이[^)]*확인\)/;

export function statusOf(goal) {
  if (goal.status === 'verified') return { key: 'done', label: '완료 · 엔진 검증 통과' };
  if (goal.status === 'review_required' && goal.reason === 'owner_approval') return { key: 'owner', label: '자율 작업 완료 · 대장 최종 확인 대기' };
  if (goal.status === 'review_required') return { key: 'waiting', label: '대장 결정 대기' };
  if (['blocked', 'recovery_required', 'paused'].includes(goal.status)) return { key: 'stopped', label: '멈춤' };
  return { key: 'running', label: '진행 중 · 아직 완료 아님' };
}

// What kind of results the folder holds, for the "how to use" part.
export function kindsOf(files) {
  const has = re => files.some(f => re.test(f));
  return { code: has(/(^|\/)package\.json$|\.test\.(m?js|cjs|ts)$/), web: has(/\.html?$/i), document: has(/\.hwpx?$/i),
    slides: has(/^발표자료\/.*\.pdf$|^slides\//), research: has(/^sources\//), sheet: has(/\.xlsx$/i) };
}

export function buildPackage({ goal, runs = [], events = [], files = [], packageJson = null, now = new Date().toISOString() }) {
  const st = statusOf(goal);
  const criteria = goal.completionCriteria ?? [];
  const ev = new Map((goal.evidence ?? []).map(e => [e.criterion, e]));
  const tasks = goal.taskPlan?.tasks ?? [];
  const mine = files.filter(f => !f.startsWith('reports/') && !f.startsWith('.hq'));
  const kinds = kindsOf(mine);
  const steps = {};
  for (const r of runs.filter(r => !r.simulated)) steps[r.team ?? 'task'] = (steps[r.team ?? 'task'] ?? 0) + 1;
  const critLine = (c, i) => {
    const e = ev.get(c);
    const how = !e ? (OWNER.test(c) ? '대장 확인 대기' : '아직 증명 안 됨') : e.by === '대장' ? '대장이 확인' : `엔진 증명 · ${String(e.proof ?? '').replace(/^엔진 확인 · /, '').slice(0, 160)}`;
    return `| ${i + 1} | ${e ? '✓' : '·'} | ${c.replace(/\|/g, '/')} | ${how.replace(/\|/g, '/')} |`;
  };
  const deliverables = tasks.length
    ? tasks.flatMap(t => t.outputs.map(o => ({ path: o, task: `${t.id} ${t.title}`, exists: mine.some(f => f === o || f.startsWith(o.replace(/\/?$/, '/'))) })))
    : mine.slice(0, 40).map(f => ({ path: f, task: '', exists: true }));
  // How to use what was made, by kind.
  const use = [];
  if (kinds.code) use.push(packageJson?.scripts?.test ? `테스트: 작업 폴더에서 \`npm test\` (${packageJson.scripts.test})` : `테스트: \`node --test ${mine.filter(f => /\.test\.(m?js|cjs)$/.test(f)).slice(0, 4).join(' ')}\``);
  if (kinds.web) use.push(`화면: 브라우저로 ${mine.find(f => /(^|\/)index\.html?$/i.test(f)) ?? mine.find(f => /\.html?$/i.test(f))} 를 연다`);
  if (kinds.document) use.push(`문서: ${mine.filter(f => /\.hwpx?$/i.test(f)).slice(0, 3).join(', ')} (한글에서 연다)`);
  if (kinds.slides) use.push(`발표: ${mine.filter(f => /^발표자료\/.*\.pdf$/.test(f)).slice(0, 2).join(', ') || 'slides/ 폴더'}`);
  if (kinds.sheet) use.push(`표: ${mine.filter(f => /\.xlsx$/i.test(f)).slice(0, 3).join(', ')}`);
  if (kinds.research) use.push('출처: sources/ 에 엔진이 저장한 원문이 있다 (조사 결과의 값과 대조)');
  const decisions = [
    ...(goal.messages ?? []).filter(m => m.role === 'user' && ['answer', 'approval'].includes(m.kind)).map(m => `- ${String(m.at ?? '').slice(0, 16)} · 대장: ${String(m.text).replace(/\s+/g, ' ').slice(0, 240)}`),
    ...events.filter(e => e.type === 'policy.auto').map(e => `- ${String(e.at ?? '').slice(0, 16)} · 엔진 자동 승인 (${e.level}): ${e.kind} · ${e.rule}`),
    ...tasks.flatMap(t => (t.handoff?.decisions ?? []).map(d => `- ${t.id} ${TEAM_L[t.team] ?? t.team}: ${d}`)),
  ];
  const open = [
    ...criteria.filter(c => !ev.has(c)).map(c => `- 완료 조건 미충족: ${c}${OWNER.test(c) ? ' (대장 확인 대기)' : ''}`),
    ...tasks.filter(t => !['done', 'skipped'].includes(t.status)).map(t => `- 작업 ${t.id} ${t.title} · ${t.status === 'running' ? '진행 중' : '대기'}${t.attempts ? ` · ${t.attempts}번 시도` : ''}`),
    ...tasks.flatMap(t => (t.handoff?.openIssues ?? []).map(i => `- ${t.id} 남은 문제: ${i}`)),
    ...deliverables.filter(d => !d.exists).map(d => `- 계획된 산출물이 없음: ${d.path} (${d.task})`),
    ...(goal.status === 'review_required' && goal.question ? [`- 대장에게 묻는 중: ${String(goal.question).replace(/\s+/g, ' ').slice(0, 300)}`] : []),
  ];
  const title = goal.title || String(goal.objective ?? '').slice(0, 60);
  const summary = [
    `# ${title}`, '', `> 엔진이 기록으로 만든 결과 요약입니다 (${now.slice(0, 16)}). 상태는 엔진 검증 결과 그대로입니다.`, '',
    `**상태:** ${st.label}`, '', '## 목표', String(goal.objective ?? '').replace(/\n\n\[반복 실행[\s\S]*$/, '').trim(), '',
    '## 결과물', '| 파일 | 맡은 작업 | 있음 |', '|---|---|---|', ...deliverables.map(d => `| ${d.path} | ${d.task || '—'} | ${d.exists ? '✓' : '없음'} |`), '',
    '## 완료 조건', '| # | | 조건 | 근거 |', '|---|---|---|---|', ...criteria.map(critLine), '',
    ...(use.length ? ['## 사용 방법', ...use.map(u => `- ${u}`), ''] : []),
    '## 진행', `- 실제 실행 단계: ${Object.values(steps).reduce((a, b) => a + b, 0)} (${Object.entries(steps).map(([t, n]) => `${TEAM_L[t] ?? t} ${n}`).join(' · ')})`,
    ...(tasks.length ? [`- 작업 계획: ${tasks.filter(t => t.status === 'done').length}/${tasks.length} 완료`] : []),
    '', '같은 폴더의 TASK_MANIFEST.json · DECISIONS.md · OPEN_ISSUES.md · HANDOFF.md · evidence/ 를 함께 보세요.',
  ].join('\n');
  const manifest = { project: goal.projectId, goalId: goal.id, title, status: st.key, statusLabel: st.label, generatedAt: now, kinds,
    tasks: tasks.map(t => ({ id: t.id, title: t.title, team: t.team, status: t.status, attempts: t.attempts ?? 0, dependsOn: t.dependsOn, criteria: t.criteria,
      outputs: t.outputs.map(o => ({ path: o, exists: deliverables.some(d => d.path === o && d.exists) })),
      handoff: t.handoff ? { made: t.handoff.made, openIssues: t.handoff.openIssues } : null })),
    criteria: criteria.map(c => ({ text: c, proven: ev.has(c), by: ev.get(c)?.by ?? null, ownerJudged: OWNER.test(c) })), steps };
  const handoff = [
    `# 이어받기 · ${title}`, '', `**지금 상태:** ${st.label}`, '',
    '## 먼저 볼 것', '1. PROJECT_SUMMARY.md — 목표·결과물·완료 조건과 근거', '2. OPEN_ISSUES.md — 남은 일', '3. TASK_MANIFEST.json — 작업별 상태와 산출물', '',
    '## 다음에 할 일', ...(open.length ? open.slice(0, 8) : [st.key === 'done' ? '- 남은 일 없음 · 개선을 하려면 새 목표로 시작' : '- 기록된 남은 일 없음']), '',
    ...(use.length ? ['## 실행·확인 방법', ...use.map(u => `- ${u}`), ''] : []),
    '## 지킬 것', '- 완료 조건이 바뀌면 근거가 다시 필요하다 (엔진은 증명된 파일이 바뀌면 그 근거를 무효로 한다).', '- 작업 폴더 밖에 쓰지 않는다.',
  ].join('\n');
  const evidence = { generatedAt: now, criteria: criteria.map(c => { const e = ev.get(c); return e ? { criterion: c, by: e.by, proof: e.proof, at: e.at, files: e.files ?? null, test: e.test ?? null } : { criterion: c, proven: false }; }),
    checks: runs.filter(r => r.team === 'qa' && Array.isArray(r.tools)).slice(-1).flatMap(r => r.tools.map(t => ({ id: t.id, status: t.status, label: t.label ?? null }))) };
  return {
    'PROJECT_SUMMARY.md': summary + '\n',
    'TASK_MANIFEST.json': JSON.stringify(manifest, null, 2) + '\n',
    'DECISIONS.md': ['# 결정 기록', '', ...(decisions.length ? decisions : ['- 기록된 결정 없음']), ''].join('\n'),
    'OPEN_ISSUES.md': ['# 남은 일', '', ...(open.length ? open : ['- 없음 · 모든 완료 조건이 증명됨']), ''].join('\n'),
    'HANDOFF.md': handoff + '\n',
    'evidence/evidence.json': JSON.stringify(evidence, null, 2) + '\n',
  };
}

export function writePackage(cwd, pkg) {
  const base = path.join(cwd, ...PACKAGE_DIR.split('/'));
  for (const [rel, text] of Object.entries(pkg)) {
    const full = path.join(base, ...rel.split('/'));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
  }
  return Object.keys(pkg).map(rel => `${PACKAGE_DIR}/${rel}`);
}
