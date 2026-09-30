import { TEAMS } from './teams.js';

// 완료 보고서: written by the engine from its own records when a team project finishes (no model call). It states
// only what the records hold — each criterion with its proof, who worked with which model, what was made — so it can
// go to a reader as is. The document maker then turns it into a 한글 document (보고서 서식).
export const REPORTS_DIR = 'reports';

const pad = n => String(n).padStart(2, '0');
// 공문서 date and time: "2026. 9. 30. 14:05"
export function officialDate(iso, withTime = true) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.${withTime ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''}`;
}
const stamp = iso => { const d = new Date(iso); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`; };
// 공문서 표기: no dashes (—, –, ―), they become commas; ISO dates (2026-09-30) become 2026. 9. 30.
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s*[—–―]\s*/g, ', ').replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => `${y}. ${Number(mo)}. ${Number(d)}.`)
    .replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const TOOL = { 'claude-code': 'Claude Code', codex: 'Codex' };

// goal: the finished goal; runs: its run records; files: work-folder files (relative paths); now: ISO time.
export function buildReport({ goal, runs = [], files = [], now = new Date().toISOString() }) {
  const real = runs.filter(r => !r.simulated && r.status === 'finished');
  const criteria = goal.completionCriteria ?? [];
  const proofOf = c => (goal.evidence ?? []).find(e => e.criterion === c)?.proof ?? '근거 기록 없음';
  const byHuman = criteria.filter(c => /^대장 확인/.test(proofOf(c)));
  const lines = [];
  lines.push(`# ${clip(goal.title || goal.objective, 60)} 완료 보고`, '');
  const objective = clip(goal.objective, 180);
  lines.push(`> ${objective}${/[.…!?]$/.test(objective) ? '' : '.'} 완료 조건 ${criteria.length}개를 모두 확인했다 (엔진 확인 ${criteria.length - byHuman.length}개, 대장 확인 ${byHuman.length}개).`, '');

  lines.push('## 완료 조건과 근거', '');
  // A criterion that ends in a full stop would read "…이다.: 엔진 확인" (seen in a real report).
  for (const c of criteria) lines.push(`- ${clip(c, 120).replace(/[.。]$/, '')}: ${clip(proofOf(c).replace(/^엔진 확인 · /, '엔진 확인, '), 220)}`);
  lines.push('');

  lines.push('## 진행 요약', '');
  const first = runs.map(r => r.startedAt).filter(Boolean).sort()[0] ?? goal.createdAt;
  lines.push(`- 기간: ${officialDate(first)}∼${officialDate(now)}`);
  const perTeam = {};
  for (const r of real) perTeam[r.team] = (perTeam[r.team] ?? 0) + 1;
  lines.push(`- 실행 단계: 총 ${real.length}단계 (${Object.entries(perTeam).map(([t, n]) => `${TEAMS[t]?.name ?? t} ${n}`).join(', ') || '기록 없음'})`);
  const models = {};
  for (const r of real) { const k = `${TOOL[r.executor] ?? r.executor} ${r.actualModel ?? r.requestedModel ?? '기본 모델'}`; models[k] = (models[k] ?? 0) + 1; }
  if (Object.keys(models).length) lines.push(`- 사용한 AI: ${Object.entries(models).map(([m, n]) => `${m} ${n}단계`).join(', ')}`);
  const switched = real.filter(r => r.switchedFrom);
  if (switched.length) lines.push(`- 한도 자동 전환: ${switched.length}단계를 다른 AI가 대신함 (그중 작업팀과 같은 AI의 검토 ${switched.filter(r => r.sameAsWorker).length}단계)`);
  const controls = (goal.messages ?? []).filter(m => m.role === 'user' && ['approval', 'control', 'review', 'answer'].includes(m.kind)).length;
  if (controls) lines.push(`- 대장의 승인·답변·조작: ${controls}회`);
  lines.push('');

  const shown = files.filter(f => !/^(attachments|sources|reports)\//.test(f) && !/\.hwpx\.(svg|html|md)$/.test(f)).slice(0, 30);
  if (shown.length) { lines.push('## 결과물', '', ...shown.map(f => `- ${f}`), ''); }

  const sources = {};
  for (const r of runs) for (const s of r.sources ?? []) sources[s.path] = s;
  if (Object.keys(sources).length) {
    lines.push('## 대조한 공식 원문', '', ...Object.values(sources).map(s => `- ${s.url} (${officialDate(s.fetchedAt, false)} 저장, ${s.path})`), '');
  }
  const documents = {};
  for (const r of runs) for (const d of r.documents ?? []) documents[d.path] = d;
  if (Object.keys(documents).length) {
    lines.push('## 엔진이 만든 한글 문서', '', ...Object.values(documents).map(d => `- ${d.path} (${d.preset} 서식, ${d.validated ? '구조 검증 통과' : '구조 검증 실패'})`), '');
  }
  if (byHuman.length) lines.push('## 대장이 직접 확인한 조건', '', ...byHuman.map(c => `- ${clip(c, 120)}`), '');
  lines.push('## 작성', '', `- AGENT HQ 엔진이 실행 기록만으로 작성했다 (AI 호출 없음). 작성 시각 ${officialDate(now)}.`, '');

  const name = `${REPORTS_DIR}/완료보고서-${stamp(now)}`;
  return { markdown: lines.join('\n'), md: `${name}.md`, hwpx: `${name}.hwpx` };
}
