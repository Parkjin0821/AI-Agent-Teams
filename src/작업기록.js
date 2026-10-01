import { createHash } from 'node:crypto';
import { inspectExport } from './검사.js';

const TEAM = { plan: '기획팀', research: '조사팀', dev: '개발팀', design: '디자인팀', security: '보안팀', policy: '정책팀', qa: '검증팀' };
const STATUS = { scheduled: '실행 예정', running: '실행 중', finished: '단계 종료', verified: '완료 확인', paused: '일시 중단', blocked: '차단', review_required: '확인 필요', recovery_required: '복구 필요', model_wait: '모델 대기', retry_wait: '재시도 대기', failed: '실패' };
const OUTCOME = { completed: '작업 종료', verified: '검증 완료', progress: '진행', blocked: '차단', failed: '실패' };
const label = (map, value) => map[value] ?? '미분류';
const cell = value => String(value ?? '미확인').replace(/[\r\n|`<>]/g, ' ');
const evidencedCount = goal => new Set((goal.evidence ?? []).map(e => e.criterion)
  .filter(c => c != null && (goal.completionCriteria ?? []).includes(c))).size;

// Only bounded, structured fields enter the private Notion draft; never raw answers or conversations.
const privateText = value => typeof value !== 'string' ? '기록 없음' : value.slice(0, 3000).split(/\r?\n/).map(line =>
  inspectExport([{ path: 'record', content: line }]).length || /(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/|Bearer\s+\S+)/i.test(line)
    ? '[민감정보 포함 문장 제외]' : cell(line)).join('\n');
function notionDetails(store, goals, metadata) {
  const lines = [metadata, '', '## 상세 작업 기록 · 노션 전용', '',
    '팀의 주장과 엔진 검사 결과를 구분합니다. 원문 대화·답변·도구 출력은 포함하지 않으며 민감정보 검사는 완전한 비밀정보 제거를 보장하지 않습니다.'];
  for (const goal of goals) {
    lines.push('', `### ${privateText(goal.title || goal.id)}`, `목표: ${privateText(goal.objective)}`,
      '완료 조건 (아래 근거 표시는 승인 여부와 별개):',
      ...(goal.completionCriteria ?? []).map(c => `- ${privateText(c)} · ${(goal.evidence ?? []).some(e => e.criterion === c) ? '엔진 근거 있음' : '근거 미확인'}`));
    for (const run of [...store.listRuns(goal.id)].sort((a,b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')) || String(a.id).localeCompare(String(b.id)))) {
      lines.push('', `#### ${label(TEAM, run.team)} · ${cell(run.id)}`, `상태: ${label(STATUS, run.status)} · ${run.simulated ? '모의 실행 / 실제 검증 아님' : '실제 실행'}`,
        `모델: ${privateText(run.model)} · 시작: ${cell(run.startedAt)} · 종료: ${cell(run.finishedAt)}`);
      if (run.plan) lines.push(`다음 작업 (팀 제안): ${privateText(run.plan.nextTask)}`, `결정 요청: ${privateText(run.plan.needsDecision)}`);
      if (run.review) lines.push(`검토 판단 (팀 보고): ${cell(run.review.verdict)}`, ...(run.review.issues ?? []).map(i => `- ${privateText(i)}`));
      for (const tool of run.tools ?? []) lines.push(`- 엔진 검사 ${privateText(tool.name)} · ${cell(tool.status)}: ${privateText(tool.summary)}`);
    }
  }
  const jobs = store.getSettings ? Object.entries(store.getSettings()).filter(([k,v]) => k.startsWith('autosave.job.') && v.projectId === goals[0].projectId).map(([,v]) => v) : [];
  lines.push('', '## 결과물 저장 위치', '코드·버전 이력은 GitHub, 작업 설명과 검증 기록은 Notion에 남깁니다. 파일 크기만으로 저장처를 결정하지 않습니다.');
  const urls = [...new Set(jobs.filter(j => j.provider === 'github' && j.status === 'saved' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(j.url)).map(j => j.url))].sort();
  lines.push(...(urls.length ? urls.map(url => `- GitHub 결과물: ${url}`) : ['- GitHub 실제 저장 URL: 아직 없음']));
  return lines.join('\n');
}

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
  const notionMarkdown = notionDetails(store, goals, markdown);
  return { version: 3, digest, snapshot, summary, teamSummary, markdown, notionMarkdown, notionDigest: createHash('sha256').update(notionMarkdown).digest('hex'), state: 'draft', externalSync: 'not_connected',
    github: { path: `agent-hq-records/${projectId}/작업기록-${digest}.md`, content: Buffer.from(markdown).toString('base64') },
    notion: { blocks: notionMarkdown.split('\n').filter(Boolean).map(text => ({ object: 'block', type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: text.slice(0, 1900) } }] } })) },
    requires: ['destination_allowlist', 'credentials', 'security_policy_review', 'publication_approval'] };
}
