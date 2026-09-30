import { createHash } from 'node:crypto';

const TEAM = { plan: '기획팀', research: '조사팀', dev: '개발팀', design: '디자인팀', security: '보안팀', policy: '정책팀', qa: '검증팀' };
const STATUS = { scheduled: '실행 예정', running: '실행 중', finished: '단계 종료', verified: '완료 확인', paused: '일시 중단', blocked: '차단', review_required: '확인 필요', recovery_required: '복구 필요', model_wait: '모델 대기', retry_wait: '재시도 대기', failed: '실패' };
const OUTCOME = { completed: '작업 종료', verified: '검증 완료', progress: '진행', blocked: '차단', failed: '실패' };
const label = (map, value) => map[value] ?? '미분류';
const cell = value => String(value ?? '미확인').replace(/[\r\n|`<>]/g, ' ');
const evidencedCount = goal => new Set((goal.evidence ?? []).map(e => e.criterion)
  .filter(c => c != null && (goal.completionCriteria ?? []).includes(c))).size;

// Metadata-only external drafts exclude prompts, answers, paths and tool output.
export function projectRecord(store, projectId) {
  const goals = store.listGoals().filter(g => g.projectId === projectId);
  if (!goals.length) throw new Error('project not found');
  const checkpoints = goals.flatMap(g => store.listRuns(g.id).map(r => ({
    goalId: g.id, runId: r.id, team: r.team, executor: r.executor, status: r.status,
    simulated: r.simulated === true, outcome: r.outcome, startedAt: r.startedAt, finishedAt: r.finishedAt,
    verifiedCriteria: r.evidence?.length ?? 0,
  }))).sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')) || String(a.runId).localeCompare(String(b.runId)));
  const snapshot = { projectId, goals: goals.map(g => ({ id: g.id, status: g.status,
    criteriaCount: (g.completionCriteria ?? []).length, evidencedCount: evidencedCount(g) })), checkpoints };
  const real = checkpoints.filter(r => !r.simulated);
  const summary = { goals: goals.length, completedGoals: goals.filter(g => g.status === 'verified').length,
    actualRuns: real.length, simulatedRuns: checkpoints.length - real.length,
    finishedRuns: real.filter(r => r.status === 'finished').length,
    criteria: snapshot.goals.reduce((n, g) => n + g.criteriaCount, 0),
    evidencedCriteria: snapshot.goals.reduce((n, g) => n + g.evidencedCount, 0),
    needsAttention: snapshot.goals.filter(g => ['blocked','review_required','recovery_required','model_wait','paused'].includes(g.status)).length };
  const teamSummary = Object.entries(TEAM).map(([team, name]) => ({ team, name,
    actualRuns: real.filter(r => r.team === team).length,
    simulatedRuns: checkpoints.filter(r => r.team === team && r.simulated).length,
    finishedRuns: real.filter(r => r.team === team && r.status === 'finished').length }));
  const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const markdown = [`# AGENT HQ · ${cell(projectId)} 작업 기록`, '', `Record: ${digest}`, '',
    '엔진 기록 기반 초안입니다. 모의 실행과 단계 종료는 프로젝트 완료를 의미하지 않습니다.',
    '외부 공유용으로 목표 원문·대화·답변·파일 경로·도구 출력을 제외했습니다.', '',
    '## 프로젝트 요약', '',
    `- 목표: ${summary.goals}개 · 완료 확인: ${summary.completedGoals}개 · 확인 필요: ${summary.needsAttention}개`,
    `- 실제 실행: ${summary.actualRuns}회 · 종료된 단계: ${summary.finishedRuns}회 · 모의 실행: ${summary.simulatedRuns}회`,
    `- 완료 조건 근거: ${summary.evidencedCriteria}/${summary.criteria}개 (조건별 중복 제외)`, '',
    '## 목표별 상태', '',
    '| 목표 ID | 상태 | 근거 있는 조건 |', '| --- | --- | --- |',
    ...snapshot.goals.map(g => `| ${cell(g.id)} | ${label(STATUS, g.status)} | ${g.evidencedCount}/${g.criteriaCount} |`), '',
    '## 팀별 작업', '', '| 팀 | 실제 실행 | 종료 단계 | 모의 실행 |', '| --- | ---: | ---: | ---: |',
    ...teamSummary.map(t => `| ${t.name} | ${t.actualRuns} | ${t.finishedRuns} | ${t.simulatedRuns} |`), '',
    '## 실행 이력', '',
    ...(checkpoints.length ? checkpoints.map(r => `- ${cell(r.runId)} · ${label(TEAM, r.team)} · ${label(STATUS, r.status)} · ${r.simulated ? '모의 실행 (SIMULATED / not verified)' : label(OUTCOME, r.outcome)} · ${cell(r.startedAt)}`) : ['- 실행 기록 없음']), '',
    '## 미완료와 다음 확인', '',
    ...snapshot.goals.filter(g => g.status !== 'verified').map(g => `- ${cell(g.id)}: ${label(STATUS, g.status)} · 근거 미확인 조건 ${Math.max(0, g.criteriaCount - g.evidencedCount)}개`),
    ...(summary.completedGoals === summary.goals ? ['- 모든 목표가 완료 확인 상태입니다.'] : []), '',
    '## 외부 저장', '', '- 실제 저장 여부와 저장 URL은 자동 저장 상태에서 확인합니다. 이 초안 생성만으로 외부 저장이 완료되지는 않습니다.'
  ].join('\n');
  return { version: 2, digest, snapshot, summary, teamSummary, markdown, state: 'draft', externalSync: 'not_connected',
    github: { path: `agent-hq-records/${projectId}/${digest}.md`, content: Buffer.from(markdown).toString('base64') },
    notion: { blocks: markdown.split('\n').filter(Boolean).map(text => ({ object: 'block', type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: text.slice(0, 1900) } }] } })) },
    requires: ['destination_allowlist', 'credentials', 'security_policy_review', 'publication_approval'] };
}
