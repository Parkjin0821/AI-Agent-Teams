import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGoalRunner } from '../src/goal-runner.js';
import { ProjectWorkspaces } from '../src/workspaces.js';
import { SkillLibrary } from '../src/skills.js';

const goal = { id: 'g1', projectId: 'hello', objective: 'README를 쓴다', completionCriteria: ['README.md 파일이 있다', '팀 회의를 한다'] };
const store = { emit: async () => {} };
test('interrupted attempts persist before/after metadata and pass it to the next executor', async () => {
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-cp-')));
  let records = [{ id: 'r1', status: 'running', team: 'dev', executor: 'claude-code' }];
  const cpStore = { emit: async () => {}, listRuns: () => records, saveRun: r => { records = records.map(old => old.id === r.id ? r : old); } };
  let prompt = '';
  const adapter = { enabled: true, run: async (provider, p, event, opts) => {
    prompt = p; writeFileSync(path.join(opts.cwd, 'partial.txt'), 'unfinished'); return { outcome: 'limited' };
  } };
  const runner = createGoalRunner({ adapter, store: cpStore, workspaces });
  await runner.run(goal, { executor: 'claude-code', team: 'dev' });
  assert.deepEqual(records[0].checkpoint.added, ['partial.txt']);
  records[0] = { ...records[0], status: 'finished', outcome: 'error' };
  records.push({ id: 'r2', status: 'running', team: 'dev', executor: 'codex' });
  await runner.run(goal, { executor: 'codex', team: 'dev' });
  assert.match(prompt, /Previous attempt interrupted/);
  assert.match(prompt, /claude-code/);
  assert.match(prompt, /partial.txt/);
});

function runnerWith(adapterRun) {
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-gr-')));
  let prompt = '';
  const adapter = { enabled: true, run: async (provider, p, onEvent, opts) => { prompt = p; return adapterRun(opts.cwd); } };
  return { runner: createGoalRunner({ adapter, workspaces, store }), getPrompt: () => prompt };
}

test('the prompt asks for a checkable report on every criterion', async () => {
  const { runner, getPrompt } = runnerWith(() => ({ outcome: 'completed', answer: '' }));
  await runner.run(goal, { executor: 'claude-code', model: null });
  assert.match(getPrompt(), /README를 쓴다/);
  assert.match(getPrompt(), /1\. README\.md 파일이 있다/);
  assert.match(getPrompt(), /AGENT_HQ_REPORT/);
});

test('after a real run the engine checks the report itself and returns evidence, claims, answer and a diff hash', async () => {
  const { runner } = runnerWith((cwd) => {
    writeFileSync(path.join(cwd, 'README.md'), 'hello');
    return { outcome: 'completed', model: 'm', answer: 'README를 만들었습니다.\nAGENT_HQ_REPORT\n{"criteria":[{"index":1,"done":true,"check":{"type":"file_exists","path":"README.md"}},{"index":2,"done":false,"check":null,"note":"사람이 해야 함"}]}' };
  });
  const result = await runner.run(goal, { executor: 'claude-code', model: null });
  assert.deepEqual(result.evidence.map(e => e.criterion), ['README.md 파일이 있다']);
  assert.deepEqual(result.claims.map(c => c.check), ['pass', 'none']);
  assert.match(result.answer, /README를 만들었습니다/);
  assert.equal(result.model, 'm');
  assert.equal(typeof result.diffHash, 'string');
});

test('a claim of "done" with a check that fails is not evidence', async () => {
  const { runner } = runnerWith(() => ({ outcome: 'completed', answer: 'AGENT_HQ_REPORT {"criteria":[{"index":1,"done":true,"check":{"type":"file_exists","path":"README.md"}}]}' }));
  const result = await runner.run(goal, { executor: 'claude-code', model: null });
  assert.equal(result.evidence.length, 0);
  assert.equal(result.claims[0].check, 'fail');
  assert.equal(result.diffHash, null, 'empty workspace has no fingerprint');
});

const teamGoal = { ...goal, kind: 'team', team: { step: 'plan', task: '', feedback: '', cycle: 1 } };

test('a relevant approved skill reaches its team prompt and counts only completed runs', async () => {
  const values = {}, events = [], prompts = [];
  const skillStore = { getSettings:()=>structuredClone(values), setSetting:(key,value)=>{values[key]=structuredClone(value);},
    emit:async event=>{events.push(event);} };
  const library = new SkillLibrary({store:skillStore});
  const skill = library.register({name:'ui-layout',description:'화면 레이아웃 검토',body:'정보 위계를 점검한다.',teams:['design'],triggers:['화면']});
  for(const kind of ['security','policy','compatibility'])library.review(skill.id,{kind,pass:true,note:'검토 완료'});
  library.activate(skill.id,{confirm:true});
  const outcomes = ['limited','completed'];
  const adapter = {enabled:true,run:async (provider,prompt)=>{prompts.push(prompt);return {outcome:outcomes.shift(),answer:'AGENT_HQ_REPORT {"criteria":[]}' };}};
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(),'hq-skill-run-')));
  const runner = createGoalRunner({adapter,workspaces,store:skillStore});
  const work = {...teamGoal,team:{...teamGoal.team,step:'design',task:'UI 구성'}};
  await runner.run(work,{executor:'claude-code',team:'design',access:'write'});
  assert.match(prompts[0],/정보 위계를 점검한다/);
  assert.equal(library.list()[0].applied,undefined);
  await runner.run(work,{executor:'claude-code',team:'design',access:'write'});
  assert.equal(library.list()[0].applied,1);
  assert.equal(events.filter(e=>e.type==='skill.applied').length,1);
});

test('team rounds use the team prompt and access, and return the parsed plan', async () => {
  let seen;
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-gr-')));
  writeFileSync(path.join(workspaces.resolve('hello'), 'notes.md'), 'x');
  const adapter = { enabled: true, run: async (provider, prompt, onEvent, opts) => {
    seen = { provider, prompt, access: opts.access };
    return { outcome: 'completed', answer: '계획\nAGENT_HQ_PLAN\n{"next_task":"README 작성","needs_decision":null,"all_done":false}' };
  } };
  const result = await createGoalRunner({ adapter, workspaces, store }).run(teamGoal, { executor: 'claude-code', team: 'plan', access: 'read', model: null });
  assert.deepEqual([seen.provider, seen.access], ['claude', 'read']);
  assert.match(seen.prompt, /기획팀/);
  assert.match(seen.prompt, /notes\.md/);
  assert.deepEqual(result.plan, { nextTask: 'README 작성', team: 'dev', reviews: [], needsDecision: null, allDone: false });
  assert.equal(result.evidence.length, 0);
});

test('review teams run read-only and return the parsed review, never evidence', async () => {
  let seen;
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-gr-')));
  const adapter = { enabled: true, run: async (provider, prompt, onEvent, opts) => {
    seen = { provider, prompt, access: opts.access };
    return { outcome: 'completed', answer: '검토했습니다.\nAGENT_HQ_REVIEW {"verdict":"issues","issues":["비밀번호 평문 저장"],"blocking":true,"needs_decision":null}' };
  } };
  const g = { ...teamGoal, team: { ...teamGoal.team, step: 'security', task: '로그인' } };
  const result = await createGoalRunner({ adapter, workspaces, store }).run(g, { executor: 'codex', team: 'security', access: 'read', model: null });
  assert.deepEqual([seen.provider, seen.access], ['codex', 'read']);
  assert.match(seen.prompt, /보안팀/);
  assert.deepEqual(result.review, { verdict: 'issues', issues: ['비밀번호 평문 저장'], blocking: true, needsDecision: null });
  assert.equal(result.evidence.length, 0);
});

test('the verification team returns engine-checked evidence plus feedback and improvements', async () => {
  const { runner } = runnerWith((cwd) => {
    writeFileSync(path.join(cwd, 'README.md'), 'hello');
    return { outcome: 'completed', answer: 'AGENT_HQ_REPORT\n{"criteria":[{"index":1,"done":true,"check":{"type":"file_exists","path":"README.md"}}],"feedback":"회의 조건 미충족","improvements":["목차 추가"]}' };
  });
  const result = await runner.run({ ...teamGoal, team: { ...teamGoal.team, step: 'qa' } }, { executor: 'codex', team: 'qa', access: 'write', model: null });
  assert.deepEqual(result.evidence.map(e => e.criterion), ['README.md 파일이 있다']);
  assert.deepEqual(result.findings, { feedback: '회의 조건 미충족', improvements: ['목차 추가'], blocking: [] });
});

test('each team gets only its own tools: web for research, chosen connectors for design, nothing for others', async () => {
  const seen = {};
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-gr-')));
  const adapter = { enabled: true, run: async (provider, prompt, onEvent, opts) => {
    seen[/^You are (\S+)/.exec(prompt)[1]] = { web: opts.web, connectors: opts.connectors, known: opts.knownConnectors };
    return { outcome: 'completed', answer: 'AGENT_HQ_REPORT {"criteria":[]}' };
  } };
  const toolsFor = (team) => (team === 'design' ? { connectors: ['Figma'], knownConnectors: ['Figma', 'Gmail'] } : {});
  const runner = createGoalRunner({ adapter, workspaces, store, toolsFor });
  for (const step of ['research', 'design', 'dev']) {
    await runner.run({ ...teamGoal, team: { ...teamGoal.team, step, task: 't' } }, { executor: 'claude-code', team: step, access: 'write', model: null });
  }
  assert.deepEqual(seen['조사팀'], { web: true, connectors: [], known: [] });
  assert.deepEqual(seen['디자인팀'], { web: false, connectors: ['Figma'], known: ['Figma', 'Gmail'] });
  assert.deepEqual(seen['개발팀'], { web: false, connectors: [], known: [] });
});

test('a secret the engine finds blocks the security review even when the AI passes it', async () => {
  let prompt = '';
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-gr-')));
  writeFileSync(path.join(workspaces.resolve('hello'), 'config.js'), `const k = "${'sk-ant-' + 'x'.repeat(30)}";`);
  const adapter = { enabled: true, run: async (provider, p) => { prompt = p; return { outcome: 'completed', answer: 'AGENT_HQ_REVIEW {"verdict":"pass","issues":[],"blocking":false,"needs_decision":null}' }; } };
  const g = { ...teamGoal, team: { ...teamGoal.team, step: 'security', task: '설정' } };
  const result = await createGoalRunner({ adapter, workspaces, store }).run(g, { executor: 'codex', team: 'security', access: 'read', model: null });
  assert.match(prompt, /비밀정보 스캔: found/);
  assert.equal(result.review.blocking, true);
  assert.match(result.review.issues[0], /^\[엔진 검사\] 비밀정보가 파일에 있음: config\.js:1/);
  assert.deepEqual(result.tools.map(t => [t.id, t.status]), [['secrets', 'found'], ['npm-audit', 'skipped']]);
  assert.ok(!JSON.stringify(result.tools).includes('x'.repeat(30)));
});

test('in verification, tests_pass counts only when the engine ran the tests in the sandbox and they passed', async () => {
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-gr-')));
  writeFileSync(path.join(workspaces.resolve('hello'), 'package.json'), '{"scripts":{"test":"node --test"}}');
  const answer = 'AGENT_HQ_REPORT {"criteria":[{"index":1,"done":true,"check":{"type":"tests_pass"}}],"feedback":"","improvements":[]}';
  const adapter = { enabled: true, run: async () => ({ outcome: 'completed', answer }) };
  const qa = { ...teamGoal, team: { ...teamGoal.team, step: 'qa' } };
  const run = (sandbox) => createGoalRunner({ adapter, workspaces, store, sandbox }).run(qa, { executor: 'codex', team: 'qa', access: 'write', model: null });
  const passing = await run({ available: true, run: async () => ({ status: 'pass', code: 0, output: 'ok' }) });
  assert.deepEqual(passing.evidence, [{ criterion: 'README.md 파일이 있다', proof: '엔진 확인 · 샌드박스에서 npm test 통과' }]);
  assert.deepEqual(passing.findings.blocking, []);
  const failing = await run({ available: true, run: async () => ({ status: 'fail', code: 1, output: 'not ok' }) });
  assert.equal(failing.evidence.length, 0);
  assert.match(failing.findings.blocking[0], /^테스트 실패 \(종료 코드 1\): npm test/);
  const noSandbox = await run(null);
  assert.deepEqual([noSandbox.evidence.length, noSandbox.claims[0].check], [0, 'fail']);
  // A development round cannot prove tests: they only run in verification.
  const dev = await createGoalRunner({ adapter, workspaces, store }).run({ ...teamGoal, team: { ...teamGoal.team, step: 'dev' } }, { executor: 'claude-code', team: 'dev', access: 'write', model: null });
  assert.deepEqual([dev.evidence.length, dev.claims[0].check, dev.tools.length], [0, 'later', 0]);
});

test('simulation still produces no evidence', async () => {
  const { runner } = runnerWith(() => ({ outcome: 'simulated' }));
  const result = await runner.run(goal, { executor: 'codex', model: null });
  assert.deepEqual([result.outcome, result.simulated, result.evidence.length], ['completed', true, 0]);
});

test('the limit state Claude Code reports during a run is handed to the usage record; Codex runs are not', async () => {
  const seen = [];
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-gr-')));
  const limits = [{ window: 'five_hour', status: 'allowed', resetsAt: null, usingOverage: false }];
  const adapter = { enabled: true, run: async () => ({ outcome: 'completed', answer: '', rateLimits: limits }) };
  const runner = createGoalRunner({ adapter, workspaces, store, onRateLimits: l => seen.push(l) });
  await runner.run(goal, { executor: 'claude-code', model: null });
  await runner.run(goal, { executor: 'codex', model: null });
  assert.deepEqual(seen, [limits]);
});

test('원문 저장: the web team lists its pages, the engine saves allowed originals, and a check can prove against them', async () => {
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-src-run-')));
  const grantsFile = path.join(mkdtempSync(path.join(tmpdir(), 'hq-grants-')), 'grants.json');
  writeFileSync(grantsFile, JSON.stringify({ grants: [{ kind: 'web', target: 'nodejs.org', project: 'hello', scope: 'once' }] }));
  // a one-time grant is spent right after the team's step; the engine's saving of that step's pages still uses it
  const approvals = { request: () => [], consumeOnce: () => writeFileSync(grantsFile, JSON.stringify({ grants: [] })) };
  const events = [];
  let records = [{ id: 'r1', status: 'running', team: 'research', executor: 'claude-code' }];
  const srcStore = { emit: async e => { events.push(e); }, listRuns: () => records, saveRun: r => { records = records.map(o => o.id === r.id ? r : o); } };
  const criteria = ['research.md의 LTS 버전이 공식 출처 원문과 같다'];
  const report = { criteria: [{ index: 1, done: true, check: { type: 'source_contains', source: 'sources/nodejs.org-en-download.txt', text: 'v24.21.0', path: 'research.md' } }],
    sources: [{ url: 'https://nodejs.org/en/download' }, { url: 'https://example.com/other' }] };
  const adapter = { enabled: true, run: async (provider, p, e, opts) => {
    writeFileSync(path.join(opts.cwd, 'research.md'), '- 현재 LTS: v24.21.0\n');
    return { outcome: 'completed', answer: 'AGENT_HQ_REPORT ' + JSON.stringify(report) };
  } };
  const webSources = { fetcher: async () => ({ ok: true, status: 200, text: async () => '<p>Get Node.js v24.21.0 (LTS)</p>',
    headers: { get: k => (k === 'content-type' ? 'text/html' : null) } }), resolve: async () => [{ address: '104.20.22.46', family: 4 }] };
  const runner = createGoalRunner({ adapter, workspaces, store: srcStore, webSources, approvals,
    sentinel: { script: 'x', log: path.join(path.dirname(grantsFile), 's.jsonl'), grants: grantsFile } });
  const result = await runner.run({ ...goal, kind: 'team', completionCriteria: criteria, team: { step: 'research', task: '조사', feedback: '', cycle: 1 } },
    { executor: 'claude-code', team: 'research', access: 'write' });
  assert.deepEqual(result.sources.map(s => s.path), ['sources/nodejs.org-en-download.txt']);
  assert.equal(result.claims[0].check, 'pass', 'proven against the original saved in the same step');
  const saved = events.find(e => e.type === 'sources.saved');
  assert.deepEqual([saved.saved.length, saved.skipped[0].reason], [1, '대장이 아직 허용하지 않은 사이트']);
  // the next step lists the same page: the saved original is reused, nothing is fetched again
  records = [{ id: 'r1', status: 'finished', team: 'research', sources: result.sources }, { id: 'r2', status: 'running', team: 'research', executor: 'claude-code' }];
  webSources.fetcher = async () => { throw new Error('fetched again'); };
  events.length = 0;
  const second = await runner.run({ ...goal, kind: 'team', completionCriteria: criteria, team: { step: 'research', task: '조사', feedback: '', cycle: 1 } },
    { executor: 'claude-code', team: 'research', access: 'write' });
  const again = events.find(e => e.type === 'sources.saved');
  assert.deepEqual([again.saved.length, again.reused.map(r => r.url)], [0, ['https://nodejs.org/en/download']]);
  assert.equal(second.claims[0].check, 'pass', 'still proven against the first saved original');
});

test('병렬 작업: a lane step that wrote outside its folder is caught after the step (how Codex is held to it)', async () => {
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-lane-')));
  let records = [{ id: 'r1', status: 'running', team: 'research', executor: 'codex' }];
  const laneStore = { emit: async () => {}, listRuns: () => records, saveRun: r => { records = records.map(o => o.id === r.id ? r : o); }, listGoals: () => [] };
  const adapter = { enabled: true, run: async (provider, p, e, opts) => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(path.join(opts.cwd, 'research'), { recursive: true });
    writeFileSync(path.join(opts.cwd, 'research', 'prices.md'), 'ok');
    writeFileSync(path.join(opts.cwd, 'index.html'), 'outside the lane');
    return { outcome: 'completed', answer: 'AGENT_HQ_REPORT {"criteria":[]}' };
  } };
  const runner = createGoalRunner({ adapter, workspaces, store: laneStore });
  const result = await runner.run({ ...goal, kind: 'team', lane: 'research/', team: { step: 'research', task: '조사', feedback: '', cycle: 1 } },
    { executor: 'codex', team: 'research', access: 'write' });
  assert.deepEqual(result.ruleViolations.map(v => [v.file, v.rule.note]), [['index.html', '병렬 작업은 자기 폴더에만 씀']]);
});

test('금지 경로 되돌리기: what a Codex step did under a 금지 path is put back right after it, and kept aside for 대장', async () => {
  const { mkdirSync, readFileSync, existsSync, unlinkSync } = await import('node:fs');
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-deny-')));
  const cwd = workspaces.resolve(goal.projectId);
  mkdirSync(path.join(cwd, 'private'), { recursive: true });
  writeFileSync(path.join(cwd, 'private', 'keep.md'), '원래 내용');
  writeFileSync(path.join(cwd, 'private', 'old.md'), '지우면 안 됨');
  const rulesFile = path.join(mkdtempSync(path.join(tmpdir(), 'hq-deny-r-')), 'rules.json');
  writeFileSync(rulesFile, JSON.stringify({ rules: [{ id: 'r', kind: 'path', target: 'private/', action: 'deny', project: null, note: '개인 메모' }] }));
  const heldDir = mkdtempSync(path.join(tmpdir(), 'hq-held-'));
  let records = [{ id: 'r1', status: 'running', team: 'dev', executor: 'codex', round: 3 }];
  const s = { emit: async () => {}, listRuns: () => records, saveRun: r => { records = records.map(o => o.id === r.id ? r : o); }, listGoals: () => [] };
  const adapter = { enabled: true, run: async (provider, p, e, opts) => {
    writeFileSync(path.join(opts.cwd, 'private', 'memo.md'), '새 메모');
    writeFileSync(path.join(opts.cwd, 'private', 'keep.md'), '덮어씀');
    unlinkSync(path.join(opts.cwd, 'private', 'old.md'));
    writeFileSync(path.join(opts.cwd, 'index.html'), 'ok');
    return { outcome: 'completed', answer: 'AGENT_HQ_REPORT {"criteria":[]}' };
  } };
  const runner = createGoalRunner({ adapter, workspaces, store: s, sentinel: { rules: rulesFile }, heldDir });
  const result = await runner.run({ ...goal, kind: 'team', team: { step: 'dev', task: '작업', feedback: '', cycle: 1 } },
    { executor: 'codex', team: 'dev', access: 'write', round: 3 });
  assert.deepEqual(result.ruleViolations.map(v => [v.file, v.change, v.restored]).sort(),
    [['private/keep.md', 'modified', true], ['private/memo.md', 'added', true], ['private/old.md', 'removed', true]]);
  assert.equal(readFileSync(path.join(cwd, 'private', 'keep.md'), 'utf8'), '원래 내용');
  assert.equal(readFileSync(path.join(cwd, 'private', 'old.md'), 'utf8'), '지우면 안 됨');
  assert.equal(existsSync(path.join(cwd, 'private', 'memo.md')), false);
  assert.equal(readFileSync(path.join(cwd, 'index.html'), 'utf8'), 'ok', 'files outside the rule are left alone');
  const memo = result.ruleViolations.find(v => v.file === 'private/memo.md');
  assert.equal(readFileSync(memo.held, 'utf8'), '새 메모', 'what the team wrote is kept outside the work folder');
  assert.ok(!memo.held.startsWith(cwd));
});

test('병렬 작업: files the lane wrote while the parent step ran are not the parent step\'s (seen in a real run)', async () => {
  const workspaces = new ProjectWorkspaces(mkdtempSync(path.join(tmpdir(), 'hq-overlap-')));
  const laneGoal = { id: 'lane1', parentGoalId: goal.id, lane: 'menu/', status: 'running', projectId: goal.projectId };
  const check = async (laneRuns, access = 'write') => {
    let records = [{ id: 'r1', status: 'running', team: 'dev', executor: 'codex' }];
    const s = { emit: async () => {}, listRuns: id => id === 'lane1' ? laneRuns : records,
      saveRun: r => { records = records.map(o => o.id === r.id ? r : o); }, listGoals: () => [laneGoal] };
    const adapter = { enabled: true, run: async (provider, p, e, opts) => {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(path.join(opts.cwd, 'menu'), { recursive: true });
      writeFileSync(path.join(opts.cwd, 'menu', `menu-${laneRuns.length}-${access}.json`), '[]');
      return { outcome: 'completed', answer: 'AGENT_HQ_REPORT {"criteria":[]}' };
    } };
    const result = await createGoalRunner({ adapter, workspaces, store: s }).run({ ...goal, kind: 'team', team: { step: 'dev', task: 'x', feedback: '', cycle: 1 } },
      { executor: 'codex', team: 'dev', access });
    return (result.ruleViolations ?? []).map(v => v.rule.note);
  };
  // the lane had a step running the whole time → its folder's changes are its own
  assert.deepEqual(await check([{ id: 'l1', startedAt: '2000-01-01T00:00:00.000Z' }]), []);
  // no lane step overlapped → the parent wrote there itself
  assert.deepEqual(await check([]), ['진행 중인 병렬 작업의 폴더']);
  // a read-only step changes nothing itself
  assert.deepEqual(await check([], 'read'), []);
});
