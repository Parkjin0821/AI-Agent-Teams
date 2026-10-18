// 자율 완료율 측정: five fixed projects (web page, slides, minutes, research, code) run on the real server, and the
// result is how many finished with no 대장 step beyond approving their completion criteria. Run it after changing team
// guidance or engine rules, right after the Claude usage resets (it spends subscription usage).
//   node scripts/자율시험.mjs start     creates and starts the five projects, then watches them
//   node scripts/자율시험.mjs watch     watches the last set again (e.g. after a restart)
//   node scripts/자율시험.mjs report    prints the table of the last set
//   --chaos (with start/watch): once a work step is running, the server is killed hard and started again (장애 주입),
//     and the report says whether that step resumed on its own (9차 6번).
// The harness itself approves each project's completion criteria (that is part of every run) and nothing else: any
// other stop for 대장 (a question, a decision, a result check) counts as an intervention and is left for 대장.
// Results: data/자율시험/<date>.json (data/ stays out of the repository).
//
// 목표 중심 측정 (자율 작업 조율 6번): besides 자율 완료, every project is measured on six things (src/목표측정.js) —
// 업무 분해 정확도, 팀 배정 적합도, 인계 완전성, 재작업 비율, 산출물 정리 완성도, 실제 목표 달성률 — from the engine's
// records, the files in its folder and the rubric written below for it before the run (never from a team's own report).
//   --set=기본 | 복합 | 전체 (with start): the five single projects, the two multi-team projects, or all seven (default 전체)
//   node scripts/자율시험.mjs measure                 measures the last set again (server must be running)
//   node scripts/자율시험.mjs review <번호> <달성|부분|미달> [메모]   records 대장's own judgement of project <번호>
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { METRICS, measureGoal, pct, summarize } from '../src/목표측정.js';

const H = process.env.HQ_URL ?? 'http://127.0.0.1:4314';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, 'data', '자율시험');
// Rubrics (평가 기준) are written here, before any run, from the objective alone. requirements: what the goal needs
// split out and which teams fit; goalChecks: what the finished files must show for the original goal.
const CODE = /\.(html?|m?js|cjs|ts|css|json)$/i, TEXT = /\.(md|html?|m?js|cjs|json|txt)$/i;
const SET = [
  { set: '기본', kind: '웹페이지', title: "동네 빵집 '아침결' 소개 페이지 (자율 시험)",
    objective: "동네 빵집 '아침결'을 소개하는 한 페이지 웹사이트를 만든다. 대표 메뉴, 영업시간, 오시는 길, 주문 문의 방법을 담고 휴대폰에서도 보기 좋게 한다. 대장이 알려주지 않은 가격·주소·전화번호는 예시로 채우고 예시임을 표시한다.",
    rubric: {
      requirements: [{ name: '소개 페이지 구현', match: /\.html?|페이지|화면/i, teams: ['design', 'dev'] }],
      goalChecks: [
        { name: 'HTML 페이지', file: /\.html?$/i },
        { name: '대표 메뉴', file: /\.html?$/i, contains: /메뉴/ },
        { name: '영업시간', file: /\.html?$/i, contains: /영업 ?시간/ },
        { name: '오시는 길', file: /\.html?$/i, contains: /오시는 ?길|찾아오/ },
        { name: '주문 문의', file: /\.html?$/i, contains: /문의/ },
        { name: '휴대폰 화면 설정(viewport)', file: /\.html?$/i, contains: /name=["']?viewport/i },
        { name: '예시 값 표시', file: /\.html?$/i, contains: /예시/ },
      ] } },
  { set: '기본', kind: '발표 자료', title: '도서관 여름 독서 교실 학부모 안내 발표 (자율 시험)',
    objective: '동네 작은도서관의 여름 독서 교실을 학부모에게 안내하는 발표 자료를 5~6장으로 만든다. 프로그램 소개, 주별 일정, 신청 방법, 준비물, 문의처를 담는다. 대장이 알려주지 않은 날짜·인원·연락처는 예시로 채우고 예시임을 표시한다. 결과는 PDF로 받는다.',
    rubric: {
      requirements: [{ name: '발표 자료 제작', match: /발표|슬라이드|slide|\.pdf/i, teams: ['design'] }],
      goalChecks: [
        { name: 'PDF 발표 자료', file: /\.pdf$/i },
        { name: '주별 일정', file: TEXT, contains: /주차|1주|주별/ },
        { name: '신청 방법', file: TEXT, contains: /신청/ },
        { name: '준비물', file: TEXT, contains: /준비물/ },
        { name: '문의처', file: TEXT, contains: /문의/ },
        { name: '예시 값 표시', file: TEXT, contains: /예시/ },
      ] } },
  { set: '기본', kind: '회의록', title: '주간 운영 회의록 한글 문서 (자율 시험)',
    objective: '아래 회의 내용을 정리해 회의록.md를 쓰고, 보고서의 documents로 엔진에 요청해 "회의록" 서식의 한글 문서 회의록.hwpx를 만든다. 회의 내용 — 일시: 2026. 10. 5. 10:00, 장소: 3층 회의실, 참석: 대장·기획팀·디자인팀, 안건: 10월 소식지 제작. 논의: 기획팀은 소식지를 4쪽으로 줄이자고 제안, 디자인팀은 표지 사진을 새로 찍자고 제안. 결정 사항: ① 소식지는 4쪽으로 만든다. ② 표지 사진은 디자인팀이 10. 12.까지 준비한다. ③ 다음 회의는 10. 19. 10:00에 연다. 공문서 표기법을 지킨다.',
    rubric: {
      requirements: [{ name: '회의록 작성', match: /회의록/, teams: ['research', 'design', 'dev'] }],
      goalChecks: [
        { name: '회의록.md', file: /(^|\/)회의록\.md$/ },
        { name: '회의록.hwpx', file: /(^|\/)회의록\.hwpx$/ },
        { name: '결정 ① 4쪽', file: /회의록\.md$/, contains: /4 ?쪽/ },
        { name: '결정 ② 10. 12.', file: /회의록\.md$/, contains: /10\. 12\./ },
        { name: '결정 ③ 다음 회의 10. 19.', file: /회의록\.md$/, contains: /10\. 19\./ },
      ] } },
  { set: '기본', kind: '조사', title: 'Node.js 지원 일정 조사 (자율 시험)',
    objective: 'Node.js 공식 사이트에서 현재 지원 중인 LTS 버전들과 각 버전의 지원 종료일을 확인해 조사결과.md로 정리한다. 버전마다 출처 페이지를 적고, 공식 원문을 저장해 대조할 수 있게 한다.',
    rubric: {
      requirements: [{ name: 'LTS 지원 일정 조사', match: /조사|LTS|Node/i, teams: ['research'] }],
      goalChecks: [
        { name: '조사결과.md', file: /(^|\/)조사결과\.md$/ },
        { name: '공식 출처(nodejs.org) 2곳 이상', file: /조사결과\.md$/, contains: /https?:\/\/[^\s)]*nodejs\.org/, min: 2 },
        { name: 'LTS 버전과 종료일', file: /조사결과\.md$/, contains: /LTS/ },
        { name: '공식 원문 저장', file: /^sources\//, sources: true },
      ] } },
  { set: '기본', kind: '코드', title: '가계부 월별 합계 모듈 (자율 시험)',
    objective: 'CSV 가계부(날짜,항목,금액)를 읽어 월별 수입·지출 합계와 항목별 지출 상위 3개를 돌려주는 Node.js 모듈을 만들고, 테스트로 확인한다. 빈 줄과 잘못된 금액은 건너뛰고 몇 줄을 건너뛰었는지 알려 준다.',
    rubric: {
      requirements: [
        { name: '월별 합계 모듈', match: /모듈|합계|\.m?js|구현/, teams: ['dev'] },
        { name: '테스트', match: /테스트|test/i, teams: ['dev'] },
      ],
      goalChecks: [
        { name: '모듈 파일', file: /^(?!.*\.test\.).*\.(m?js|cjs)$/ },
        { name: '테스트 파일', file: /\.test\.(m?js|cjs)$/ },
        { name: '건너뛴 줄 수 알림', file: /\.(m?js|cjs)$/, contains: /skip|건너/i },
        { name: '상위 3개', file: /\.(m?js|cjs)$/, contains: /slice\(0, ?3\)|top ?3|상위/i },
      ] } },
  // 복합: projects that need several teams working on each other's results (조사 → 설계 → 구현 → 검증).
  { set: '복합', kind: '복합·웹 MVP', title: '광주·전남 행사 스태프 매칭 웹 MVP (자율 시험)',
    objective: '광주·전남 지역의 행사 스태프 매칭 플랫폼을 기획하고, 실제 사용할 수 있는 웹 MVP까지 만든다. 주최자는 행사와 필요한 스태프 인원을 올리고, 스태프는 행사에 지원하고, 주최자는 지원자를 확정한다. 비슷한 서비스 2곳 이상을 조사해 차별점을 정리하고, 사용자 역할·화면 흐름·데이터 모델을 설계한 뒤 구현하고 테스트로 확인한다. 외부 서버·결제·로그인 연동 없이 브라우저 저장소나 JSON 파일로 충분하다. 실제 개인정보 대신 예시 데이터를 쓰고 예시임을 표시한다.',
    rubric: {
      requirements: [
        { name: '요구사항·사용자 역할 정의', match: /요구사항|역할|명세/, teams: ['research', 'design'] },
        { name: '유사 서비스 조사', match: /유사|경쟁|비슷한|비교|조사/, teams: ['research'] },
        { name: 'IA·사용자 흐름 설계', match: /IA|사용자 ?흐름|화면 ?(구조|흐름|설계)|와이어|플로우|flow/i, teams: ['design'] },
        { name: '데이터 모델 설계', match: /데이터 ?모델|스키마|schema|DB/i, teams: ['dev'] },
        { name: '기능 구현', match: /구현|MVP|\.html|\.m?js/i, teams: ['dev', 'design'] },
        { name: '테스트', match: /테스트|test/i, teams: ['dev'] },
      ],
      goalChecks: [
        { name: '실행 화면 index.html', file: /(^|\/)index\.html$/ },
        { name: '행사 등록 기능', file: CODE, contains: /행사 ?(등록|올리기|만들기|추가)/ },
        { name: '스태프 지원 기능', file: CODE, contains: /지원하기|지원 ?(신청|등록)|apply/i },
        { name: '지원자 확정 기능', file: CODE, contains: /확정/ },
        { name: '데이터 모델 정리', file: TEXT, contains: /데이터 ?모델|스키마|schema/i },
        { name: '유사 서비스 출처 2곳 이상', file: /\.md$/i, contains: /https?:\/\/\S+/, min: 2 },
        { name: '테스트 파일', file: /\.test\.(m?js|cjs)$/ },
        { name: '예시 데이터 표시', file: TEXT, contains: /예시/ },
      ] } },
  { set: '복합', kind: '복합·조사+발표', title: '광주·전남 가을 축제 비교 조사와 발표 자료 (자율 시험)',
    objective: "광주·전남의 대표 가을 축제 3곳을 각 축제 공식 누리집이나 지자체 자료로 조사해 조사결과.md에 비교표(기간·장소·주요 프로그램·입장료·출처)를 만들고, 공식 원문을 저장해 대조할 수 있게 한다. 그 조사 결과로 지자체 관광 담당자에게 보여 줄 5~6장 발표 자료를 PDF로 만든다. 확인하지 못한 값은 지어내지 말고 '확인 필요'로 적는다.",
    rubric: {
      requirements: [
        { name: '축제 공식 자료 조사', match: /조사|축제/, teams: ['research'] },
        { name: '비교표 정리', match: /비교/, teams: ['research', 'design'] },
        { name: '발표 자료 제작', match: /발표|슬라이드|slide|\.pdf/i, teams: ['design'] },
      ],
      goalChecks: [
        { name: '조사결과.md', file: /(^|\/)조사결과\.md$/ },
        { name: '출처 3곳 이상', file: /조사결과\.md$/, contains: /https?:\/\/\S+/, min: 3 },
        { name: '비교표', file: /조사결과\.md$/, contains: /\|[^\n]*기간[^\n]*\|/ },
        { name: '공식 원문 저장', file: /^sources\//, sources: true },
        { name: 'PDF 발표 자료', file: /\.pdf$/i },
        { name: '발표에 축제 내용', file: /^(slides|발표자료)\/.*\.(md|html?|json)$/i, contains: /축제/ },
      ] } },
];
const rubricOf = it => SET.find(s => s.title === it.title)?.rubric ?? null;

const api = (method, url, body) => fetch(H + url, { method, headers: { 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : undefined }).then(async r => { const j = await r.json(); if (!r.ok) throw new Error(`${url}: ${j.error}`); return j; });
const goalsById = async () => new Map((await api('GET', '/api/engine')).projects.flatMap(p => p.goals).map(g => [g.id, g]));
const latest = () => {
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];
  if (!files.length) throw new Error('측정 기록 없음 · 먼저 start');
  return path.join(dir, files.at(-1));
};
const save = (file, rec) => writeFileSync(file, JSON.stringify(rec, null, 2));
const DONE = new Set(['verified', 'failed', 'stopped', 'blocked']);

async function start() {
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  const rec = { startedAt: at, set: SET_NAME, items: [], ...(AUTONOMY ? { autonomy: AUTONOMY } : {}) };
  for (const s of SET.filter(s => SET_NAME === '전체' || s.set === SET_NAME)) {
    // Each run gets its own folder: the run time goes into the title, e.g. "(자율 시험 10-02 0135)" (no ":" in folders).
    const stamp = new Date().toLocaleString('sv-SE').slice(5, 16).replace(':', '');
    const g = await api('POST', '/api/projects', { title: s.title.replace(/\)$/, ` ${stamp})`), objective: s.objective, conversation: true, start: true, ...(AUTONOMY ? { autonomy: AUTONOMY } : {}) });
    rec.items.push({ kind: s.kind, title: s.title, goalId: g.id, projectId: g.projectId, interventions: [], approvals: 0 });
    console.log('시작', s.kind, g.projectId);
  }
  const file = path.join(dir, at.replace(/[:.]/g, '-') + '.json');
  save(file, rec);
  return file;
}

// Approves criteria when asked, records every other stop for 대장 once, and ends when every project is done or
// waiting for 대장 / the next day, or after `hours`.
async function watch(file, hours = 6) {
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  const until = Date.now() + hours * 3600_000;
  let lastLine = '';
  while (Date.now() < until) {
    const goals = await goalsById().catch(() => null);
    if (goals) {
      for (const it of rec.items) {
        const g = goals.get(it.goalId); if (!g) continue;
        if (g.status === 'review_required' && g.reason === 'criteria_approval_required' && g.criteriaApprovalPending) {
          await api('POST', `/api/goals/${g.id}/criteria/approve`, { confirm: true, criteria: g.completionCriteria }).catch(e => console.log('승인 실패', e.message));
          it.approvals++; it.criteria = g.completionCriteria.length;
          continue;
        }
        const stop = g.status === 'review_required' ? `${g.reason}@${g.round}` : null;
        // Left only with criteria 대장 judges by design ("(대장이 … 확인)"): the final look, not an intervention.
        const unmet = (g.completionCriteria ?? []).filter(c => !(g.evidence ?? []).some(e => e.criterion === c));
        const final = g.reason === 'owner_approval' || unmet.length > 0 && unmet.every(c => /\(대장이[^)]*확인\)/.test(c));
        if (stop && !it.interventions.some(x => x.key === stop)) it.interventions.push({ key: stop, reason: g.reason, round: g.round, final, unmet,
          at: new Date().toISOString(), question: String(g.question?.text ?? g.question ?? '').slice(0, 400) });
        const runs = g.runs ?? [];
        Object.assign(it, { status: g.status, reason: g.reason, round: g.round, met: g.evidence?.length ?? 0, total: g.completionCriteria?.length ?? 0,
          steps: runs.length, modelCalls: runs.filter(r => r.actualModel).length,
          engineOnly: runs.filter(r => String(r.answer ?? '').startsWith('엔진 단독 검증')).length,
          interrupted: runs.filter(r => r.status === 'interrupted').length, resumed: (g.recoveries ?? []).length });
        // 장애 주입: the first time a work step runs, kill the server hard and start it again.
        const last = runs.at(-1);
        if (CHAOS && !rec.chaos && g.status === 'running' && last?.status === 'running' && ['research', 'dev', 'design'].includes(last.team)) {
          rec.chaos = { at: new Date().toISOString(), kind: it.kind, goalId: g.id, team: last.team };
          let pid = null;
          try { pid = readFileSync(path.join(root, 'data', 'real-test', 'server.pid'), 'utf8').trim(); } catch { /* no pid */ }
          if (pid) spawnSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore' });
          spawnSync(process.execPath, [path.join(root, 'scripts', '에이전트-관리.mjs'), 'start', '--no-open'], { stdio: 'ignore' });
          console.log('장애 주입 · 서버를 강제 종료하고 다시 켬 ·', it.kind, last.team);
          save(file, rec);
          break;
        }
      }
      save(file, rec);
      const line = rec.items.map(it => `${it.kind}:${it.status ?? '?'}${it.reason ? '/' + it.reason : ''} ${it.met ?? 0}/${it.total ?? 0}`).join(' | ');
      if (line !== lastLine) { console.log(new Date().toTimeString().slice(0, 8), line); lastLine = line; }
      const settled = rec.items.every(it => DONE.has(it.status) || (it.status === 'review_required' && it.reason !== 'criteria_approval_required') || it.reason === 'daily_cap');
      if (settled && rec.items.every(it => it.status)) break;
    }
    await new Promise(r => setTimeout(r, 20_000));
  }
  rec.endedAt = new Date().toISOString();
  save(file, rec);
  await measure(file).catch(e => console.log('목표 중심 측정 실패:', e.message));
  report(file);
}

// 목표 중심 측정: each project's goal, runs and task graph from the server, its events from the engine's database, and
// its files read straight from its work folder.
function engineEvents(ids) {
  const out = [];
  try {
    const db = new DatabaseSync(path.join(root, 'data', 'real-test', 'hq.sqlite'), { readOnly: true });
    for (const row of db.prepare("select body from events where body like '%\"task.%' or body like '%policy.auto%'").all()) {
      const e = JSON.parse(row.body);
      if (ids.has(e.goalId)) out.push(e);
    }
    db.close();
  } catch { /* no records */ }
  return out;
}
function folderFiles(base, max = 3000) {
  const out = [];
  const walk = rel => {
    if (out.length >= max) return;
    let names = [];
    try { names = readdirSync(path.join(base, rel), { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      if (['node_modules', '.git'].includes(d.name)) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(r); else out.push(r);
    }
  };
  walk('');
  return out;
}
const readText = base => rel => {
  if (!/\.(md|html?|m?js|cjs|ts|css|json|txt|csv)$/i.test(rel)) return null;
  try { const full = path.join(base, ...rel.split('/')); return statSync(full).size > 1_000_000 ? null : readFileSync(full, 'utf8'); } catch { return null; }
};

async function measure(file) {
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  const view = await api('GET', '/api/engine');
  const events = engineEvents(new Set(rec.items.map(it => it.goalId)));
  for (const it of rec.items) {
    const project = view.projects.find(p => p.id === it.projectId);
    const goal = project?.goals.find(g => g.id === it.goalId);
    if (!goal) continue;
    const base = path.join(root, project.workspacePath);
    it.metrics = measureGoal({ goal, runs: goal.runs ?? [], events: events.filter(e => e.goalId === goal.id), files: folderFiles(base), read: readText(base), rubric: rubricOf(it) });
    it.workspace = project.workspacePath;
  }
  rec.measuredAt = new Date().toISOString();
  save(file, rec);
  return rec;
}

// 대장's own look at a finished project: kept beside the measured goal score, never folded into it.
function review(file, n, verdict, note) {
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  const it = rec.items[Number(n) - 1];
  if (!it || !['달성', '부분', '미달'].includes(verdict)) throw new Error('사용법: review <번호 1~' + rec.items.length + '> <달성|부분|미달> [메모]');
  it.review = { verdict, note: note || '', at: new Date().toISOString() };
  save(file, rec);
  console.log(`대장 검토 기록 · ${it.kind}: ${verdict}${note ? ' · ' + note : ''}`);
}

function autoApprovals(rec) {
  const out = {};
  try {
    const db = new DatabaseSync(path.join(root, 'data', 'real-test', 'hq.sqlite'), { readOnly: true });
    const ids = new Set(rec.items.map(it => it.goalId));
    for (const row of db.prepare("select body from events where body like '%policy.auto%'").all()) {
      const e = JSON.parse(row.body);
      if (e.type === 'policy.auto' && ids.has(e.goalId)) out[e.goalId] = (out[e.goalId] ?? 0) + 1;
    }
    db.close();
  } catch { /* no records */ }
  return out;
}

function report(file) {
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  const real = it => it.interventions.filter(x => !x.final);
  const alone = rec.items.filter(it => !real(it).length && (it.status === 'verified' || it.interventions.some(x => x.final))).length;
  console.log(`\n자율 완료 ${alone}/${rec.items.length} (대장 최종 확인만 남은 것 포함) · 시작 ${rec.startedAt}${rec.endedAt ? ' · 끝 ' + rec.endedAt : ''}`);
  const sum = k => rec.items.reduce((n, it) => n + (it[k] ?? 0), 0);
  const minutes = rec.endedAt ? Math.round((Date.parse(rec.endedAt) - Date.parse(rec.startedAt)) / 60000) : null;
  console.log(`단계 ${sum('steps')} · 모델 호출 ${sum('modelCalls')} · 엔진 단독 검증 ${sum('engineOnly')} · 끊긴 단계 ${sum('interrupted')} · 스스로 복구 ${sum('resumed')}${minutes != null ? ` · ${minutes}분` : ''}`);
  if (rec.chaos) {
    const hit = rec.items.find(it => it.goalId === rec.chaos.goalId);
    console.log(`장애 주입: ${rec.chaos.kind} ${rec.chaos.team} 단계 중 서버 강제 종료 → ${hit?.resumed ? '스스로 복구함' : '복구 기록 없음'}`);
  }
  // 자율 정책: per project, how often 대장 was asked (criteria approvals the harness gave, real stops) and how often the
  // engine approved on its own (policy.auto, read from the engine's own records).
  const autoOf = autoApprovals(rec);
  const asked = it => (it.approvals ?? 0) + real(it).length + it.interventions.filter(x => x.final).length;
  const totalAsked = rec.items.reduce((n, it) => n + asked(it), 0), totalAuto = rec.items.reduce((n, it) => n + (autoOf[it.goalId] ?? 0), 0);
  console.log(`승인: 대장에게 요청 ${totalAsked} (프로젝트당 ${(totalAsked / rec.items.length).toFixed(1)}) · 엔진 자동 처리 ${totalAuto}`
    + ` · 자동 처리율 ${totalAsked + totalAuto ? Math.round(totalAuto / (totalAsked + totalAuto) * 100) : 0}%${rec.autonomy ? ` · 자율 수준 ${rec.autonomy}` : ''}`);
  for (const it of rec.items) {
    const finalOnly = it.interventions.some(x => x.final) && !real(it).length;
    console.log(`- ${it.kind}: ${it.status ?? '?'}${it.reason ? ' (' + it.reason + ')' : ''} · 조건 ${it.met ?? 0}/${it.total ?? 0} · 단계 ${it.round ?? 0}`
      + (finalOnly ? ' · 대장 최종 확인만 남음' : '')
      + (real(it).length ? ` · 대장 개입 ${real(it).length}번: ${real(it).map(x => `${x.reason}(${x.round}단계)`).join(', ')}` : '')
      + ` · 승인 요청 ${asked(it)} · 자동 ${autoOf[it.goalId] ?? 0}`);
  }
  const measured = rec.items.filter(it => it.metrics);
  if (!measured.length) { console.log('\n목표 중심 측정: 아직 없음 (서버를 켜고 measure)'); return; }
  console.log(`\n목표 중심 측정 (${String(rec.measuredAt ?? '').slice(0, 16)} · 엔진 기록·결과 파일·사전 평가 기준으로 판정, 팀 자체 보고는 쓰지 않음)`);
  const show = (key, m) => (key === 'rework' ? pct(m?.rate) : pct(m?.score));
  const groups = [['전체', measured], ...['기본', '복합'].map(s => [s, measured.filter(it => SET.find(x => x.title === it.title)?.set === s)])].filter(([, l]) => l.length);
  for (const [name, list] of groups) {
    const avg = summarize(list.map(it => it.metrics));
    console.log(`${name} (${list.length}개): ` + METRICS.map(([k, label]) => `${label} ${pct(avg[k].value)}${avg[k].n < list.length ? `(${avg[k].n}개)` : ''}`).join(' · '));
  }
  measured.forEach(it => {
    const n = rec.items.indexOf(it) + 1;
    console.log(`${n}. ${it.kind}: ` + METRICS.map(([k, label]) => `${label} ${show(k, it.metrics[k])}`).join(' · ')
      + (it.review ? ` · 대장 검토 ${it.review.verdict}${it.review.note ? ` (${it.review.note})` : ''}` : ''));
    for (const [k, label] of METRICS) {
      const m = it.metrics[k];
      if (m?.misses?.length) console.log(`   ${label} · 못 맞춘 것: ${m.misses.slice(0, 6).join(' / ')}${m.misses.length > 6 ? ` 외 ${m.misses.length - 6}` : ''}`);
    }
  });
  if (measured.some(it => !it.review)) console.log('대장 검토: node scripts/자율시험.mjs review <번호> <달성|부분|미달> [메모]');
}

const cmd = process.argv[2];
const CHAOS = process.argv.includes('--chaos');
// --autonomy=L2: the projects start with that autonomy level (자율정책.js); without it, the old rules.
const AUTONOMY = (process.argv.find(a => a.startsWith('--autonomy=')) ?? '').split('=')[1] || null;
const SET_NAME = (process.argv.find(a => a.startsWith('--set=')) ?? '--set=전체').split('=')[1];
if (!['기본', '복합', '전체'].includes(SET_NAME)) throw new Error('--set 은 기본 · 복합 · 전체 중 하나');
const hours = Number(process.argv.slice(3).find(a => /^\d+(\.\d+)?$/.test(a)) ?? 6);
if (cmd === 'start') await watch(await start(), hours);
else if (cmd === 'watch') await watch(latest(), hours);
else if (cmd === 'report') report(latest());
else if (cmd === 'measure') { await measure(latest()); report(latest()); }
else if (cmd === 'review') review(latest(), process.argv[3], process.argv[4], process.argv.slice(5).join(' '));
else console.log('사용법: node scripts/자율시험.mjs start [--set=기본|복합|전체] | watch | report | measure | review <번호> <달성|부분|미달> [메모]');
