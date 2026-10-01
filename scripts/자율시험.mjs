// 자율 완료율 측정: five fixed projects (web page, slides, minutes, research, code) run on the real server, and the
// result is how many finished with no 대장 step beyond approving their completion criteria. Run it after changing team
// guidance or engine rules, right after the Claude usage resets (it spends subscription usage).
//   node scripts/자율시험.mjs start     creates and starts the five projects, then watches them
//   node scripts/자율시험.mjs watch     watches the last set again (e.g. after a restart)
//   node scripts/자율시험.mjs report    prints the table of the last set
// The harness itself approves each project's completion criteria (that is part of every run) and nothing else: any
// other stop for 대장 (a question, a decision, a result check) counts as an intervention and is left for 대장.
// Results: data/자율시험/<date>.json (data/ stays out of the repository).
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const H = process.env.HQ_URL ?? 'http://127.0.0.1:4314';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, 'data', '자율시험');
const SET = [
  { kind: '웹페이지', title: "동네 빵집 '아침결' 소개 페이지 (자율 시험)",
    objective: "동네 빵집 '아침결'을 소개하는 한 페이지 웹사이트를 만든다. 대표 메뉴, 영업시간, 오시는 길, 주문 문의 방법을 담고 휴대폰에서도 보기 좋게 한다. 대장이 알려주지 않은 가격·주소·전화번호는 예시로 채우고 예시임을 표시한다." },
  { kind: '발표 자료', title: '도서관 여름 독서 교실 학부모 안내 발표 (자율 시험)',
    objective: '동네 작은도서관의 여름 독서 교실을 학부모에게 안내하는 발표 자료를 5~6장으로 만든다. 프로그램 소개, 주별 일정, 신청 방법, 준비물, 문의처를 담는다. 대장이 알려주지 않은 날짜·인원·연락처는 예시로 채우고 예시임을 표시한다. 결과는 PDF로 받는다.' },
  { kind: '회의록', title: '주간 운영 회의록 한글 문서 (자율 시험)',
    objective: '아래 회의 내용을 정리해 회의록.md를 쓰고, 보고서의 documents로 엔진에 요청해 "회의록" 서식의 한글 문서 회의록.hwpx를 만든다. 회의 내용 — 일시: 2026. 10. 5. 10:00, 장소: 3층 회의실, 참석: 대장·기획팀·디자인팀, 안건: 10월 소식지 제작. 논의: 기획팀은 소식지를 4쪽으로 줄이자고 제안, 디자인팀은 표지 사진을 새로 찍자고 제안. 결정 사항: ① 소식지는 4쪽으로 만든다. ② 표지 사진은 디자인팀이 10. 12.까지 준비한다. ③ 다음 회의는 10. 19. 10:00에 연다. 공문서 표기법을 지킨다.' },
  { kind: '조사', title: 'Node.js 지원 일정 조사 (자율 시험)',
    objective: 'Node.js 공식 사이트에서 현재 지원 중인 LTS 버전들과 각 버전의 지원 종료일을 확인해 조사결과.md로 정리한다. 버전마다 출처 페이지를 적고, 공식 원문을 저장해 대조할 수 있게 한다.' },
  { kind: '코드', title: '가계부 월별 합계 모듈 (자율 시험)',
    objective: 'CSV 가계부(날짜,항목,금액)를 읽어 월별 수입·지출 합계와 항목별 지출 상위 3개를 돌려주는 Node.js 모듈을 만들고, 테스트로 확인한다. 빈 줄과 잘못된 금액은 건너뛰고 몇 줄을 건너뛰었는지 알려 준다.' },
];

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
  const rec = { startedAt: at, items: [] };
  for (const s of SET) {
    // Each run gets its own folder: the run time goes into the title, e.g. "(자율 시험 10-02 0135)" (no ":" in folders).
    const stamp = new Date().toLocaleString('sv-SE').slice(5, 16).replace(':', '');
    const g = await api('POST', '/api/projects', { title: s.title.replace(/\)$/, ` ${stamp})`), objective: s.objective, conversation: true, start: true });
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
        const final = unmet.length > 0 && unmet.every(c => /\(대장이[^)]*확인\)/.test(c));
        if (stop && !it.interventions.some(x => x.key === stop)) it.interventions.push({ key: stop, reason: g.reason, round: g.round, final, unmet,
          at: new Date().toISOString(), question: String(g.question?.text ?? g.question ?? '').slice(0, 400) });
        Object.assign(it, { status: g.status, reason: g.reason, round: g.round, met: g.evidence?.length ?? 0, total: g.completionCriteria?.length ?? 0 });
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
  report(file);
}

function report(file) {
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  const real = it => it.interventions.filter(x => !x.final);
  const alone = rec.items.filter(it => !real(it).length && (it.status === 'verified' || it.interventions.some(x => x.final))).length;
  console.log(`\n자율 완료 ${alone}/${rec.items.length} (대장 최종 확인만 남은 것 포함) · 시작 ${rec.startedAt}${rec.endedAt ? ' · 끝 ' + rec.endedAt : ''}`);
  for (const it of rec.items) {
    const finalOnly = it.interventions.some(x => x.final) && !real(it).length;
    console.log(`- ${it.kind}: ${it.status ?? '?'}${it.reason ? ' (' + it.reason + ')' : ''} · 조건 ${it.met ?? 0}/${it.total ?? 0} · 단계 ${it.round ?? 0}`
      + (finalOnly ? ' · 대장 최종 확인만 남음' : '')
      + (real(it).length ? ` · 대장 개입 ${real(it).length}번: ${real(it).map(x => `${x.reason}(${x.round}단계)`).join(', ')}` : ''));
  }
}

const cmd = process.argv[2];
if (cmd === 'start') await watch(await start(), Number(process.argv[3] ?? 6));
else if (cmd === 'watch') await watch(latest(), Number(process.argv[3] ?? 6));
else if (cmd === 'report') report(latest());
else console.log('사용법: node scripts/자율시험.mjs start | watch | report');
