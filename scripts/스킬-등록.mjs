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
  { file: '에이전트-문서.md', name: 'agent-hq-documents', teams: ['dev', 'design'], triggers: ['문서', '회의록', '보고서', '계획서', '기안', 'hwpx', '한글 문서', '제안서', '업무보고', '정리본'],
    description: 'AGENT HQ 문서 만들기: 회의록·보고서·계획서의 필수 항목, 표로 쓸 것, 개조식, 분량, 미정 칸 남기기' },
];
// Other public skill repositories (MIT), chosen 2026-10-01 from 대장's list: { repo, commit, path, license, teams, triggers }.
const MORE = [
  { repo: 'addyosmani/agent-skills', path: 'skills/debugging-and-error-recovery/SKILL.md', teams: ['dev'], triggers: ['오류', '버그', '실패', '디버그', '고치', '테스트 실패'] },
  { repo: 'addyosmani/agent-skills', path: 'skills/security-and-hardening/SKILL.md', teams: ['security'], triggers: ['보안', '입력', '인증', '비밀', '의존성', '권한'] },
  { repo: 'addyosmani/agent-skills', path: 'skills/code-review-and-quality/SKILL.md', teams: ['qa', 'security'], triggers: ['검토', '리뷰', '품질', '코드', '검증'] },
  { repo: 'addyosmani/agent-skills', path: 'skills/planning-and-task-breakdown/SKILL.md', teams: ['plan'], triggers: ['계획', '작업', '나누', '기획', '다음 작업'] },
  { repo: 'mattpocock/skills', path: 'skills/engineering/tdd/SKILL.md', teams: ['dev', 'qa'], triggers: ['테스트', '구현', '코드', '개발', '버그'] },
];
const GITHUB = [
  { path: '.agents/skills/frontend-design/SKILL.md', license: '.agents/skills/frontend-design/LICENSE.txt', teams: ['design'], triggers: ['frontend-design', '디자인', '화면'] },
  { path: '.agents/skills/review-animations/SKILL.md', license: 'LICENSE', teams: ['design'], triggers: ['review-animations', '디자인', '화면'] },
  { path: '.agents/skills/vercel-composition-patterns/SKILL.md', license: 'LICENSE', teams: ['dev'], triggers: ['vercel-composition-patterns', '코드', '개발'] },
  { path: 'packages/core/skills/slide-authoring/SKILL.md', license: 'LICENSE', teams: ['design', 'dev'], triggers: SLIDE },
  { path: '.agents/skills/emil-design-eng/SKILL.md', license: 'LICENSE', teams: ['design'], triggers: ['디자인', '화면', '애니메이션', 'ui', '움직임'] },
  { path: '.agents/skills/apple-design/SKILL.md', license: 'LICENSE', teams: ['design'], triggers: ['디자인', '화면', '슬라이드', '발표', 'ui'] },
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
for (const s of MORE) {
  const head = await (await fetch(`https://api.github.com/repos/${s.repo}/commits/HEAD`)).json();
  const base = `https://raw.githubusercontent.com/${s.repo}/${head.sha}/`;
  const body = await text(base + s.path);
  const name = body.match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1];
  if (!name || done(name)) { console.log(`${name ?? s.path}: ${name ? '이미 있음' : '이름을 읽지 못함'}`); continue; }
  const description = (body.match(/^description:\s*(.+)$/m)?.[1] ?? s.repo).slice(0, 500);
  const license = { name: 'MIT', content: await text(base + 'LICENSE'), source: `https://github.com/${s.repo}/blob/${head.sha}/LICENSE` };
  report(name, await api('POST', '/api/skills', { name, description, teams: s.teams, triggers: s.triggers, body, license,
    source: `https://github.com/${s.repo}/blob/${head.sha}/${s.path}` }));
}
console.log('이 PC의 Claude 스킬 폴더에만 있는 theme-factory·design-taste-frontend·document-typography-design 은 따로 등록합니다 (사용안내 참고).');
console.log('승인함에서 승인하면 팀이 쓰기 시작합니다.');
