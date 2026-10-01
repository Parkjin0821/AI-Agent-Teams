import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseReport, reportInstructions, verifyReport, workspaceFingerprint } from '../src/완료근거.js';

const criteria = ['사용안내.md 파일이 있다', 'README에 소개 3줄', '팀 회의를 한다'];
const answerWith = (report) => `작업을 마쳤습니다.\n\nAGENT_HQ_REPORT\n\`\`\`json\n${JSON.stringify(report)}\n\`\`\``;
const ws = () => mkdtempSync(path.join(tmpdir(), 'hq-ev-'));

test('instructions list the criteria by number and the allowed check types', () => {
  const text = reportInstructions(criteria);
  assert.match(text, /1\. 사용안내\.md 파일이 있다/);
  assert.match(text, /AGENT_HQ_REPORT/);
  assert.match(text, /file_exists/);
  assert.match(text, /file_contains/);
});

test('the report is parsed from the answer; a missing or broken report is null', () => {
  const report = parseReport(answerWith({ criteria: [{ index: 1, done: true, check: { type: 'file_exists', path: '사용안내.md' } }] }));
  assert.equal(report.criteria[0].index, 1);
  assert.equal(parseReport('no report here'), null);
  assert.equal(parseReport('AGENT_HQ_REPORT {broken'), null);
});

test('checks run against the workspace; only passing checks become evidence', () => {
  const cwd = ws();
  writeFileSync(path.join(cwd, '사용안내.md'), '# 소개\n첫째 줄\n둘째 줄\n셋째 줄\n');
  const report = parseReport(answerWith({ criteria: [
    { index: 1, done: true, check: { type: 'file_exists', path: '사용안내.md' } },
    { index: 2, done: true, check: { type: 'file_contains', path: '사용안내.md', text: '넷째 줄' } },
    { index: 3, done: true, check: null, note: '회의는 사람이 해야 합니다' },
  ] }));
  const { evidence, claims } = verifyReport(report, criteria, cwd);
  assert.deepEqual(evidence.map(e => e.criterion), ['사용안내.md 파일이 있다']);
  assert.match(evidence[0].proof, /엔진 확인/);
  assert.deepEqual(claims.map(c => [c.criterion, c.claimed, c.check]), [
    ['사용안내.md 파일이 있다', true, 'pass'], ['README에 소개 3줄', true, 'fail'], ['팀 회의를 한다', true, 'none']]);
  assert.equal(claims[2].note, '회의는 사람이 해야 합니다');
});

test('a passing check never counts when the tool itself says the criterion is not done', () => {
  const cwd = ws();
  writeFileSync(path.join(cwd, 'TEAM-STATUS.md'), 'TASK_DONE: helloworld 팀');
  const report = { criteria: [{ index: 1, done: false, check: { type: 'file_contains', path: 'TEAM-STATUS.md', text: 'TASK_DONE' } }] };
  const { evidence, claims } = verifyReport(report, criteria, cwd);
  assert.equal(evidence.length, 0);
  assert.equal(claims[0].check, 'pass', 'the check result is still shown');
  assert.equal(claims[0].claimed, false);
});

test('instructions say a self-written status note is not proof', () => {
  assert.match(reportInstructions(criteria), /not proof/);
});

test('checks cannot look outside the workspace', () => {
  const cwd = ws();
  const outside = ws();
  writeFileSync(path.join(outside, 'secret.txt'), 'x');
  symlinkSync(outside, path.join(cwd, 'link'), 'junction');
  const report = { criteria: [
    { index: 1, done: true, check: { type: 'file_exists', path: '../secret.txt' } },
    { index: 2, done: true, check: { type: 'file_exists', path: path.join(outside, 'secret.txt') } },
    { index: 3, done: true, check: { type: 'file_exists', path: 'link/secret.txt' } },
  ] };
  const { evidence, claims } = verifyReport(report, criteria, cwd);
  assert.equal(evidence.length, 0);
  assert.deepEqual(claims.map(c => c.check), ['invalid', 'invalid', 'invalid']);
});

test('criteria without any report stay unclaimed; unknown indexes are ignored', () => {
  const { evidence, claims } = verifyReport({ criteria: [{ index: 9, done: true, check: null }] }, criteria, ws());
  assert.equal(evidence.length, 0);
  assert.deepEqual(claims.map(c => c.claimed), [false, false, false]);
  assert.deepEqual(verifyReport(null, criteria, ws()).claims.map(c => c.check), ['none', 'none', 'none']);
});

test('workspace fingerprint changes with content and is null for an empty folder', () => {
  const cwd = ws();
  assert.equal(workspaceFingerprint(cwd), null);
  writeFileSync(path.join(cwd, 'a.txt'), '1');
  const first = workspaceFingerprint(cwd);
  mkdirSync(path.join(cwd, 'node_modules'));
  writeFileSync(path.join(cwd, 'node_modules', 'ignored.js'), 'x');
  assert.equal(workspaceFingerprint(cwd), first, 'node_modules is ignored');
  writeFileSync(path.join(cwd, 'a.txt'), '2');
  assert.notEqual(workspaceFingerprint(cwd), first);
});

test('file_unchanged: attachments are proven unchanged against the fingerprint the engine recorded', async () => {
  const { createHash } = await import('node:crypto');
  const { mkdtempSync: mk, mkdirSync: md, writeFileSync: wf } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  const { attachmentOriginals } = await import('../src/목표실행.js');
  const cwd = mk(path.join(td(), 'hq-unchanged-'));
  md(path.join(cwd, 'attachments'));
  wf(path.join(cwd, 'attachments', 'a.png'), 'A'); wf(path.join(cwd, 'attachments', 'b.hwpx'), 'B'); wf(path.join(cwd, 'attachments', 'b.hwpx.md'), 'B-md');
  const sha = t => createHash('sha256').update(t).digest('hex');
  // a.png: recorded at upload; b.hwpx(.md): only in an older run checkpoint (attachments sent before fingerprints existed)
  const goal = { messages: [{ role: 'user', attachments: [{ path: 'attachments/a.png', sha256: sha('A') }, { path: 'attachments/b.hwpx' }] }] };
  const records = [{ round: 3, checkpoint: { before: { signatures: { 'attachments/b.hwpx': sha('B'), 'attachments/b.hwpx.md': sha('B-md'), 'result.md': sha('x') } } } }];
  const originals = attachmentOriginals(goal, records);
  assert.deepEqual(Object.keys(originals).sort(), ['attachments/a.png', 'attachments/b.hwpx', 'attachments/b.hwpx.md'], 'only attachments, never other files');
  const C = ['첨부 파일은 바뀌지 않았다'];
  const check = paths => verifyReport({ criteria: [{ index: 1, done: true, check: { type: 'file_unchanged', paths } }] }, C, cwd, { originals });
  const ok = check(['attachments/a.png', 'attachments/b.hwpx', 'attachments/b.hwpx.md']);
  assert.equal(ok.evidence.length, 1);
  assert.match(ok.evidence[0].proof, /첨부할 때 기록한 지문.*3번째 단계 시작 전 기록/);
  wf(path.join(cwd, 'attachments', 'a.png'), 'changed');
  assert.match(check(['attachments/a.png']).claims[0].detail, /바뀜/);
  assert.match(check(['result.md']).claims[0].detail, /원래 지문 기록이 없음/, 'a file 대장 did not attach cannot be proven unchanged');
  assert.equal(check(['../outside']).claims[0].check, 'invalid');
});

test('a passing check about something else is not proof for the criterion (real case from a Codex QA report)', () => {
  const cwd = ws();
  writeFileSync(path.join(cwd, 'result.md'), '- 버튼 글자: 변경 내용 저장\n- 화면 코드: IMG-5390\n- 관리 번호: DOC-2718\n');
  const C = [
    "result.md에 이미지의 버튼 글자 '변경 내용 저장', 화면 코드 'IMG-5390'이 캡처 이미지와 일치하게 적혀 있다",
    "파일에서 직접 읽은 내용만 적혀 있고 추측이 없으며, 읽지 못한 항목이 있으면 '읽지 못함'으로 표시되어 있다",
    '작업 폴더 밖 경로 사용, 비밀정보 기록, 금지된 설정 파일 생성이 없다',
    '작업 폴더에 result.md가 존재한다',
  ];
  const { evidence, claims } = verifyReport({ criteria: [
    { index: 1, done: true, check: { type: 'file_contains', path: 'result.md', text: '- 화면 코드: IMG-5390' } },
    { index: 2, done: true, check: { type: 'file_contains', path: 'result.md', text: '- 화면 코드: IMG-5390' } },
    { index: 3, done: true, check: { type: 'file_exists', path: 'result.md' } },
    { index: 4, done: true, check: { type: 'file_exists', path: 'result.md' } },
  ] }, C, cwd);
  assert.deepEqual(evidence.map(e => e.criterion), [C[0], C[3]]);
  assert.deepEqual(claims.map(c => c.check), ['pass', 'unrelated', 'unrelated', 'pass']);
  assert.match(claims[1].detail, /관련 없는 검사/);
  // file_unchanged only proves a criterion about the attached originals
  const U = verifyReport({ criteria: [{ index: 1, done: true, check: { type: 'file_unchanged', paths: ['attachments/a.png'] } }] },
    [C[2]], cwd, { originals: {} });
  assert.equal(U.evidence.length, 0);
});

test('stayed_inside is proven from the engine records: write guards, the Sentinel log, and the folder itself', async () => {
  const { boundaryCheck } = await import('../src/완료근거.js');
  const cwd = ws(), log = path.join(ws(), 'sentinel.jsonl');
  writeFileSync(path.join(cwd, 'divide.js'), 'module.exports = {}');
  writeFileSync(log, [
    { at: '2026-09-30T01:00:05Z', project: 'p1', tool: 'Write', target: 'divide.js', decision: 'allow' },
    { at: '2026-09-30T01:00:06Z', project: 'p1', tool: 'Write', target: 'x', decision: 'deny', reason: '작업 폴더 밖에 쓰려 함' },
    { at: '2026-09-30T01:00:07Z', project: 'other', tool: 'Write', target: 'y', decision: 'allow' },
  ].map(e => JSON.stringify(e)).join('\n'));
  const runs = [
    { round: 1, startedAt: '2026-09-30T01:00:00Z', checkpoint: { guard: { by: 'sentinel' } } },
    { round: 2, startedAt: '2026-09-30T01:01:00Z', checkpoint: { guard: { by: 'codex-read-only' } } },
    { round: 3, startedAt: '2026-09-30T01:02:00Z', simulated: true, checkpoint: {} },
  ];
  const ok = boundaryCheck({ runs, sentinelLog: log, project: 'p1', cwd });
  assert.equal(ok.status, 'pass');
  assert.match(ok.proof, /쓰기 1번 모두 작업 폴더 안.*막은 쓰기 1번.*읽기 전용 1/);
  assert.equal(boundaryCheck({ runs: [...runs, { round: 4, checkpoint: {} }], sentinelLog: log, project: 'p1', cwd }).status, 'invalid', 'a step without a recorded guard cannot be vouched for');
  assert.equal(boundaryCheck({ runs: [{ round: 1, checkpoint: { guard: { by: 'none' } } }], cwd }).status, 'fail');
  mkdirSync(path.join(cwd, '.claude'));
  assert.match(boundaryCheck({ runs, sentinelLog: log, project: 'p1', cwd }).reason, /금지된 설정 파일.*\.claude/);

  // In a report: full proof only when the criterion is just about the work folder; otherwise only that part.
  const clean = ws();
  const C = ['작업 폴더 밖의 파일을 건드리지 않았다', '설명에 추측이 없고, 작업 폴더 밖의 파일을 건드리지 않았다', 'README에 소개가 있다'];
  const boundary = () => boundaryCheck({ runs: runs.slice(0, 2), sentinelLog: log, project: 'p1', cwd: clean });
  const { evidence, claims } = verifyReport({ criteria: C.map((_, i) => ({ index: i + 1, done: true, check: { type: 'stayed_inside' }, person: i === 1 })) }, C, clean, { boundary });
  assert.deepEqual(evidence.map(e => e.criterion), [C[0]]);
  assert.deepEqual(claims.map(c => c.check), ['pass', 'partial', 'unrelated']);
  assert.match(claims[1].detail, /“설명에 추측이” 부분은 대장 판단/);
  assert.equal(claims[1].person, true);
  assert.equal(verifyReport({ criteria: [{ index: 1, done: true, check: { type: 'stayed_inside' } }] }, [C[0]], clean).claims[0].check, 'invalid');
});

test('a found value (e.g. a version) counts when the criterion names the file, but never for an absence claim', () => {
  // real case: the research team proved the LTS version with its number, which the criterion could not contain
  const cwd = ws();
  writeFileSync(path.join(cwd, 'research.md'), '- 현재 LTS 버전: v24.21.0\n- 출처: https://nodejs.org/en/download\n');
  writeFileSync(path.join(cwd, 'index.html'), '<p>현재 LTS: v24.21.0</p>');
  const C = ['research.md에 Node.js의 현재 LTS 버전과 공식 출처(nodejs.org) 주소가 적혀 있다',
    'index.html이 있고 research.md와 같은 LTS 버전이 적혀 있다',
    'research.md에 추측한 내용이 없다'];
  const { claims } = verifyReport({ criteria: [
    { index: 1, done: true, check: { type: 'file_contains', path: 'research.md', text: 'v24.21.0' } },
    { index: 2, done: true, check: { type: 'file_contains', path: 'index.html', text: 'v24.21.0' } },
    { index: 3, done: true, check: { type: 'file_contains', path: 'research.md', text: 'v24.21.0' } },
  ] }, C, cwd);
  assert.deepEqual(claims.map(c => c.check), ['pass', 'pass', 'unrelated']);
});

test('json_shape and folder_only: data criteria the engine can prove itself (seen in a real run: 대장 was asked)', async () => {
  const fs = await import('node:fs');
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-json-'));
  mkdirSync(path.join(cwd, 'menu'));
  const items = Array.from({ length: 12 }, (_, i) => ({ name: `빵${i}`, price: 1000 + i, description: '한 줄 설명', allergens: i % 2 ? ['밀'] : [] }));
  writeFileSync(path.join(cwd, 'menu', 'menu.json'), JSON.stringify(items));
  writeFileSync(path.join(cwd, 'menu', '사용안내.md'), '# 형식');
  const criteria = ['menu/menu.json은 유효한 JSON 배열이며 정확히 12개 항목을 담는다',
    '각 항목은 name, price, description, allergens 필드를 가지며 menu.json의 name은 서로 겹치지 않는다',
    'menu 폴더 안에는 menu.json과 사용안내.md만 있다'];
  const shape = { type: 'json_shape', path: 'menu/menu.json', count: 12 };
  const fields = { type: 'json_shape', path: 'menu/menu.json', fields: { name: 'string', price: 'positive_integer', description: 'one_line', allergens: 'string_array' }, unique: 'name' };
  const only = { type: 'folder_only', path: 'menu/', files: ['menu.json', '사용안내.md'] };
  const report = { criteria: [{ index: 1, done: true, check: shape }, { index: 2, done: true, check: fields }, { index: 3, done: true, check: only }] };
  const { evidence, claims } = verifyReport(report, criteria, cwd);
  assert.equal(evidence.length, 3, JSON.stringify(claims));
  assert.match(evidence[1].proof, /name 겹침 없음/);
  // and they fail when the data is wrong
  writeFileSync(path.join(cwd, 'menu', 'menu.json'), JSON.stringify([...items.slice(0, 11), { ...items[0], price: 0 }]));
  writeFileSync(path.join(cwd, 'menu', 'extra.txt'), 'x');
  const again = verifyReport(report, criteria, cwd).claims.map(c => [c.check, c.detail]);
  assert.equal(again[0][0], 'pass', 'still 12');
  assert.match(again[1][1], /12번째 항목 price이\(가\) positive_integer가 아님/);
  assert.match(again[2][1], /더 있는 파일: extra\.txt/);
  writeFileSync(path.join(cwd, 'menu', 'menu.json'), '{ broken');
  assert.match(verifyReport(report, criteria, cwd).claims[0].detail, /올바른 JSON이 아님/);
  // a passing data check does not prove an unrelated criterion
  fs.unlinkSync(path.join(cwd, 'menu', 'extra.txt'));
  assert.equal(verifyReport({ criteria: [{ index: 1, done: true, check: only }] }, ['페이지가 예쁘다'], cwd).claims[0].check, 'unrelated');
});

test('checks (all must pass) and file_excludes: what the verifier confirmed by reading can be proven (real bakery criteria)', async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-multi-'));
  writeFileSync(path.join(cwd, 'index.html'), '<html lang="ko"><style>h2{}</style><h2>가게 소개</h2><h2>영업시간</h2><h2>오시는 길</h2><h2>메뉴 표</h2></html>');
  const criteria = ['작업 폴더 루트에 index.html 한 장이 있고, 가게 소개·영업시간·오시는 길·메뉴 표 네 구역이 각각 제목과 함께 들어 있다',
    'index.html은 외부 라이브러리·CDN·외부 URL 참조(http://, https://, // 로 시작하는 src/href)와 fetch/XMLHttpRequest 없이 동작한다'];
  const sections = ['가게 소개', '영업시간', '오시는 길', '메뉴 표'].map(t => ({ type: 'file_contains', path: 'index.html', text: `<h2>${t}</h2>` }));
  const none = { type: 'file_excludes', path: 'index.html', texts: ['http://', 'https://', 'src="//', 'href="//', 'fetch(', 'XMLHttpRequest'] };
  const report = { criteria: [{ index: 1, done: true, checks: sections }, { index: 2, done: true, check: none }] };
  const { evidence, claims } = verifyReport(report, criteria, cwd);
  assert.equal(evidence.length, 2, JSON.stringify(claims));
  assert.match(evidence[0].proof, /가게 소개.*메뉴 표/);
  assert.match(evidence[1].proof, /없음/);
  // one part missing → the whole criterion is not proven, and the reason says which check
  writeFileSync(path.join(cwd, 'index.html'), '<h2>가게 소개</h2><h2>영업시간</h2><h2>메뉴 표</h2><script src="https://cdn.example/x.js"></script>');
  const again = verifyReport(report, criteria, cwd).claims;
  assert.match(again[0].detail, /^3번째 확인: .*없음/);
  assert.match(again[1].detail, /“https:\/\/” 있음/);
  // file_excludes only speaks to a criterion that claims an absence
  writeFileSync(path.join(cwd, 'index.html'), '<h2>메뉴 표</h2>');
  assert.equal(verifyReport({ criteria: [{ index: 1, done: true, check: { type: 'file_excludes', path: 'index.html', texts: ['http://'] } }] },
    ['index.html에 메뉴 표가 있다'], cwd).claims[0].check, 'unrelated');
  // a technical extra (it must still pass) does not spoil a set that has a check about the criterion; a set with none does count for nothing
  assert.equal(verifyReport({ criteria: [{ index: 1, done: true, checks: [sections[3], { type: 'file_contains', path: 'index.html', text: 'h2' }] }] },
    ['메뉴 표 구역이 있다'], cwd).claims[0].check, 'pass');
  assert.equal(verifyReport({ criteria: [{ index: 1, done: true, checks: [{ type: 'file_contains', path: 'index.html', text: 'h2' }, { type: 'file_contains', path: 'index.html', text: '<h2>' }] }] },
    ['메뉴 표 구역이 있다'], cwd).claims[0].check, 'unrelated');
  // stayed_inside is never bundled
  assert.equal(verifyReport({ criteria: [{ index: 1, done: true, checks: [sections[3], { type: 'stayed_inside' }] }] },
    ['index.html에 메뉴 표 구역이 있다'], cwd, { boundary: () => ({ status: 'pass', proof: 'x' }) }).claims[0].check, 'invalid');
});

test('an "internet loads nothing" criterion is proven by an absence check of loading patterns (flea market run)', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-offline-'));
  writeFileSync(path.join(cwd, 'index.html'), '<link rel="stylesheet" href="글꼴/글꼴.css"><svg xmlns="http://www.w3.org/2000/svg"></svg>');
  const check = { type: 'file_excludes', path: 'index.html', texts: ['src="http', "src='http", 'src="//', 'url(http', 'url("http', '@import'] };
  const crit = ['인터넷에서 불러오는 글꼴·라이브러리·이미지가 없다.'];
  const ok = verifyReport({ criteria: [{ index: 1, done: true, check }] }, crit, cwd);
  assert.equal(ok.evidence.length, 1, JSON.stringify(ok.claims));
  writeFileSync(path.join(cwd, 'index.html'), '<script src="https://cdn.example/x.js"></script>');
  assert.equal(verifyReport({ criteria: [{ index: 1, done: true, check }] }, crit, cwd).claims[0].check, 'fail');
  // loading patterns say nothing about an absence that is not about the network
  writeFileSync(path.join(cwd, 'index.html'), '<p>안내</p>');
  assert.equal(verifyReport({ criteria: [{ index: 1, done: true, check }] }, ['주의사항 상자가 기울어져 있지 않다'], cwd).claims[0].check, 'unrelated');
});

test('slides re-test: N items found in the deck prove "N개 이상", and the engine reads Korean file names itself', () => {
  const cwd = ws();
  mkdirSync(path.join(cwd, 'slides', '구청소개발표'), { recursive: true });
  mkdirSync(path.join(cwd, 'design'));
  writeFileSync(path.join(cwd, 'slides', '구청소개발표', 'index.tsx'),
    '<Item name="장소 사용 허가" /><Item name="임시 전기·수도" /><Item name="안내 게시·홍보" /><Item name="안전·정리 협조" />');
  writeFileSync(path.join(cwd, 'design', '화면설계.md'), '# 설계');
  writeFileSync(path.join(cwd, 'design', 'plan.md'), '# plan');
  const run = (criterion, checks) => verifyReport({ criteria: [{ index: 1, done: true, checks }] }, [criterion], cwd).claims[0].check;
  const deck = 'slides/구청소개발표/index.tsx';
  const items = ['장소 사용 허가', '임시 전기·수도', '안내 게시·홍보', '안전·정리 협조'].map(t => ({ type: 'file_contains', path: deck, text: `name="${t}"` }));
  const ask = "'구청에 요청할 사항' 슬라이드에 구체적인 요청 항목이 3개 이상 적혀 있다";
  assert.equal(run(ask, items), 'pass');
  assert.equal(run(ask, items.slice(0, 2)), 'unrelated', 'two items do not speak to "3개 이상"');
  assert.equal(run('참여 셀러 분류가 3개 이상이고 외부 이미지가 없다', items), 'unrelated', 'a count never proves an absence');
  const names = '새로 만든 소스·문서·결과물 파일 이름이 역할이 드러나는 한글이다';
  assert.equal(run(names, [{ type: 'file_exists', path: 'design/화면설계.md' }, { type: 'file_exists', path: deck }]), 'pass');
  assert.equal(run(names, [{ type: 'file_exists', path: 'design/화면설계.md' }, { type: 'file_exists', path: 'design/plan.md' }]), 'unrelated', 'an English name is not a Korean one');
});

test('자율 시험: menu items counted in the page, engine-only proofs run by the engine, and the new pre-check rules', async () => {
  const { lintCriteria } = await import('../src/완료근거.js');
  const { createHash } = await import('node:crypto');
  const cwd = ws();
  writeFileSync(path.join(cwd, '아침결소개.html'), '<li>결 크루아상 3,800원</li><li>통밀 캄파뉴 6,500원</li><li>쑥 앙버터 4,200원</li>');
  const menu = ['결 크루아상', '통밀 캄파뉴', '쑥 앙버터'].map(t => ({ type: 'file_contains', path: '아침결소개.html', text: t }));
  assert.equal(verifyReport({ criteria: [{ index: 1, done: true, checks: menu }] }, ['대표 메뉴가 3개 이상이고 메뉴마다 예시 가격이 있다'], cwd).claims[0].check, 'pass');
  // no check at all for "the engine made 회의록.hwpx": in verification the engine runs document_made itself
  writeFileSync(path.join(cwd, '회의록.hwpx'), 'HWPX');
  const documents = { '회의록.hwpx': { path: '회의록.hwpx', from: '회의록.md', preset: '회의록', sha: createHash('sha256').update('HWPX').digest('hex'), validated: true } };
  const made = verifyReport({ criteria: [{ index: 1, done: false, note: '엔진 기록 확인 못 함' }] }, ["엔진이 서식 '회의록'으로 회의록.hwpx 를 만들었다"], cwd, { verifying: true, documents });
  assert.deepEqual([made.claims[0].check, made.evidence.length], ['pass', 1]);
  const content = verifyReport({ criteria: [] }, ['회의록.hwpx 에 결정 사항 3건이 들어 있다'], cwd, { verifying: true, documents });
  assert.equal(content.claims[0].check, 'none', 'content is never proven by the engine alone');
  assert.equal(verifyReport({ criteria: [] }, ["엔진이 서식 '회의록'으로 회의록.hwpx 를 만들었다"], cwd, { documents }).claims[0].check, 'none', 'work steps are not verification');
  const issues = lintCriteria(['회의록.md 에 대장이 말하지 않은 사실이 없다 (빈 칸은 (미정)으로 둔다)', '새로 생긴 파일은 회의록.md 와 회의록.hwpx 뿐이다 (엔진 파일은 빼고 센다)',
    '지어낸 사실이 없다 (대장이 확인)']);
  assert.equal(issues.length, 2);
  assert.match(issues.join('\n'), /1번: 지어낸[\s\S]*2번: "새 파일은 ○○뿐" 은 증명할 기준 기록이 없다/);
});

test('자율 시험 2차: "밖에 쓴 파일이 없다" is fully proven by the engine record, and a 대장 criterion is never proven by a check', () => {
  const cwd = ws();
  const boundary = () => ({ status: 'pass', proof: '엔진 확인 · 모든 단계가 쓰기 제한 아래 실행됨' });
  for (const c of ['작업 폴더 밖에 쓴 파일이 없다.', '작업 폴더 밖에 파일을 썼거나 만든 것이 없다']) {
    const r = verifyReport({ criteria: [{ index: 1, done: true, check: { type: 'stayed_inside' } }] }, [c], cwd, { boundary });
    assert.deepEqual([r.claims[0].check, r.evidence.length], ['pass', 1], c);
  }
  assert.equal(verifyReport({ criteria: [{ index: 1, done: true, check: { type: 'stayed_inside' } }] }, ['작업 폴더 밖을 읽지 않았다'], cwd, { boundary }).claims[0].check, 'partial');
  const person = verifyReport({ criteria: [{ index: 1, done: true, check: { type: 'tests_pass' } }] }, ['빵집다운 따뜻한 분위기다 (대장이 화면에서 확인)'], cwd,
    { test: { label: 'node --test', passed: true }, verifying: true });
  assert.deepEqual([person.evidence.length, person.claims[0].check, person.claims[0].person], [0, 'none', true]);
  assert.match(person.claims[0].detail, /^참고 · /);
});
