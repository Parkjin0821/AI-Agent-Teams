// 스킬 등록 (new PC): registers the skills this AGENT HQ uses as pending candidates, so 대장 approves them once in the
// inbox. Approved skills live in data/ (not in the repository), so a new PC starts with none.
// - AGENT HQ's own skills: docs/skills/*.md (exact text; no outside license needed).
// - open-slide skills (MIT): fetched from GitHub at a pinned commit, with their license text.
// Needs the server running (에이전트-시작.cmd). Usage: node scripts/스킬-등록.mjs [port]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const port = process.argv[2] ?? '4314';
const docs = fileURLToPath(new URL('../docs/skills/', import.meta.url));
const COMMIT = 'abafe9ead0807fcd2149a4e70f734eeb41734fa9';
const raw = p => `https://raw.githubusercontent.com/open-slide/open-slide/${COMMIT}/${p}`;
const SLIDE = ['슬라이드', '발표', '발표자료', 'ppt', 'pdf', 'slides', 'deck', '프레젠테이션', 'open-slide', '보고 자료'];
const OWN = [
  { file: '에이전트-화면설계.md', name: 'agent-hq-screen-design', teams: ['design'], triggers: ['화면', '페이지', '디자인', 'html', 'ui', '레이아웃', '웹', '랜딩'],
    description: 'AGENT HQ 디자인팀의 화면 디자인 원칙: 미적 방향, 글자, 배치, 움직임과 그 안전장치, 모바일 표, 글꼴, 접근성 (비교 시험과 Codex 비판 반영)' },
  { file: '에이전트-슬라이드.md', name: 'agent-hq-slides', teams: ['design', 'dev'], triggers: SLIDE,
    description: 'AGENT HQ 발표 자료 만들기 순서: 기획팀이 정한 주제·장수·글자 양, 장마다 한 문장, slides/<id>/index.tsx, 보고서 "slides", PDF 결과' },
];
const GITHUB = [
  { path: '.agents/skills/frontend-design/SKILL.md', license: '.agents/skills/frontend-design/LICENSE.txt', teams: ['design'], triggers: ['frontend-design', '디자인', '화면'] },
  { path: '.agents/skills/review-animations/SKILL.md', license: 'LICENSE', teams: ['design'], triggers: ['review-animations', '디자인', '화면'] },
  { path: '.agents/skills/vercel-composition-patterns/SKILL.md', license: 'LICENSE', teams: ['dev'], triggers: ['vercel-composition-patterns', '코드', '개발'] },
  { path: 'packages/core/skills/slide-authoring/SKILL.md', license: 'LICENSE', teams: ['design', 'dev'], triggers: SLIDE },
];

const api = (method, url, data) => fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json' },
  body: data ? JSON.stringify(data) : undefined }).then(async r => ({ status: r.status, body: await r.json() }));
const text = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${url} ${r.status}`); return r.text(); };

let have;
try { have = (await api('GET', '/api/skills')).body.items ?? []; }
catch { console.error(`서버(http://127.0.0.1:${port})에 연결하지 못했습니다. 에이전트-시작.cmd 로 먼저 켜 주세요.`); process.exit(1); }
const done = name => have.some(k => k.name === name && ['active', 'pending'].includes(k.status));
const report = (name, r) => console.log(`${name}: ${r.status === 200 ? (r.body.status === 'pending' ? '승인 대기로 등록' : r.body.status) : '실패 · ' + (r.body.error ?? r.status)}`);

for (const s of OWN) {
  if (done(s.name)) { console.log(`${s.name}: 이미 있음`); continue; }
  report(s.name, await api('POST', '/api/skills', { name: s.name, description: s.description, teams: s.teams, triggers: s.triggers,
    body: readFileSync(docs + s.file, 'utf8'), source: 'agent-hq' }));
}
for (const s of GITHUB) {
  const body = await text(raw(s.path));
  const name = body.match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1];
  if (!name) { console.log(`${s.path}: 이름을 읽지 못함`); continue; }
  if (done(name)) { console.log(`${name}: 이미 있음`); continue; }
  const description = (body.match(/^description:\s*(.+)$/m)?.[1] ?? 'open-slide 스킬').slice(0, 500);
  const license = { name: 'MIT (open-slide 저장소)', content: await text(raw(s.license)), source: `https://github.com/open-slide/open-slide/blob/${COMMIT}/${s.license}` };
  report(name, await api('POST', '/api/skills', { name, description, teams: s.teams, triggers: s.triggers, body, license,
    source: `https://github.com/open-slide/open-slide/blob/${COMMIT}/${s.path}` }));
}
console.log('승인함에서 승인하면 팀이 쓰기 시작합니다.');
