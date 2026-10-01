import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkHtml, checkSources, detectTests, licenseReport, scanPrivacy, scanSecrets } from '../src/검사.js';
import { SandboxRunner, sandboxEnv } from '../src/격리환경.js';
import { runTeamTools, TOOLKIT, toolkitView, toolReport } from '../src/검사도구.js';

function folder(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'hq-tk-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const fakeKey = 'sk-ant-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4';

test('the secret scan says where a key is, never what it is, and flags .env files', () => {
  const dir = folder({ 'src/앱.js': `const key = "${fakeKey}";\nconst ok = process.env.API_KEY;\n`, '.env': 'X=1', '.env.example': 'X=', 'node_modules/x/a.js': fakeKey });
  const { findings } = scanSecrets(dir);
  assert.deepEqual(findings.map(f => [f.file, f.line, f.kind]), [['src/앱.js', 1, 'Anthropic API 키'], ['.env', null, '.env 파일']]);
  assert.ok(!JSON.stringify(findings).includes(fakeKey), 'the value is never kept');
  assert.equal(scanSecrets(folder({ 'a.js': 'const password = process.env.PASSWORD;\nconst p = "password: <your password>"' })).findings.length, 0);
});

test('personal data patterns are found, and 주민번호·카드번호 are marked strong', () => {
  const { findings } = scanPrivacy(folder({ 'data.csv': '홍길동,900101-1234567\n문의,010-1234-5678,me@realmail.kr\n예시,user@example.com' }));
  assert.deepEqual(findings.map(f => [f.kind, f.strong]), [['주민등록번호 형식', true], ['휴대전화번호', false], ['이메일 주소', false]]);
});

test('dependency licences come from the installed packages; GPL is flagged for a decision', () => {
  const dir = folder({
    'package.json': JSON.stringify({ license: 'MIT', dependencies: { ok: '1', gpl: '1', missing: '1' } }),
    'node_modules/ok/package.json': '{"license":"MIT"}', 'node_modules/gpl/package.json': '{"license":"GPL-3.0"}',
  });
  const r = licenseReport(dir);
  assert.equal(r.project, 'MIT');
  assert.deepEqual(r.packages.map(p => [p.name, p.flag]), [['ok', 'ok'], ['gpl', 'copyleft'], ['missing', 'unknown']]);
});

test('HTML pages, research sources and the test command are checked', () => {
  const dir = folder({
    'index.html': '<html><head></head><body><img src="a.png"><script src="https://cdn.example.net/x.js"></script></body></html>',
    'good.html': '<html lang="ko"><head><title>t</title><meta name="viewport" content="width=device-width"></head><img src="a" alt="a"></html>',
    'research/a.md': '출처 https://example.org (2026-09-29 확인)', 'research/b.md': '출처 없음',
  });
  const pages = Object.fromEntries(checkHtml(dir).pages.map(p => [p.file, p.issues]));
  assert.deepEqual(pages['good.html'], []);
  assert.deepEqual(pages['index.html'], ['<title> 없음', '<html lang> 없음', '모바일 viewport 설정 없음', 'alt 없는 이미지 1개', '외부 스크립트: cdn.example.net']);
  assert.deepEqual(checkSources(dir).notes.map(n => [n.file, n.links, n.dated]), [['research/a.md', 1, true], ['research/b.md', 0, false]]);
  assert.equal(detectTests(dir), null);
  assert.equal(detectTests(folder({ 'package.json': '{"scripts":{"test":"node --test"}}' })).label, 'npm test');
  assert.equal(detectTests(folder({ 'package.json': '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}', 'test/a.test.js': '' })).label, 'node --test');
  assert.equal(detectTests(folder({ 'test_calc.py': '' })).label, 'python -m unittest');
});

const sandboxReturning = (result) => ({ available: true, calls: [], run(cwd, command, opts) { this.calls.push({ command, opts }); return Promise.resolve(result); } });

test('security runs the secret scan; a found secret blocks, and npm audit stays off until turned on', async () => {
  const dir = folder({ 'a.js': `k="${fakeKey}"`, 'package-lock.json': '{}' });
  const sandbox = sandboxReturning({ status: 'pass', code: 0, output: '' });
  const results = await runTeamTools('security', dir, { sandbox });
  assert.deepEqual(results.map(r => [r.id, r.status]), [['secrets', 'found'], ['npm-audit', 'skipped']]);
  assert.match(results[0].blocking[0], /a\.js:1/);
  assert.equal(sandbox.calls.length, 0);
  const audit = { status: 'fail', code: 1, output: JSON.stringify({ metadata: { vulnerabilities: { info: 0, low: 1, moderate: 0, high: 2, critical: 0, total: 3 } } }) };
  const on = sandboxReturning(audit);
  const withAudit = await runTeamTools('security', dir, { sandbox: on, settings: { 'tools.npmAudit': true } });
  assert.deepEqual([withAudit[1].status, withAudit[1].summary], ['found', '취약점 3개 (높음·심각 2개)']);
  assert.equal(withAudit[1].blocking.length, 1);
  assert.equal(on.calls[0].opts.network, true);
  assert.ok(on.calls[0].command.includes('--registry=https://registry.npmjs.org/'));
  writeFileSync(path.join(dir, '.npmrc'), 'registry=https://evil.example/');
  assert.match((await runTeamTools('security', dir, { sandbox: on, settings: { 'tools.npmAudit': true } }))[1].summary, /\.npmrc/);
});

test('policy reports licences and personal data; GPL asks 대장, a 주민번호 blocks', async () => {
  const dir = folder({ 'package.json': '{"dependencies":{"g":"1"}}', 'node_modules/g/package.json': '{"license":"AGPL-3.0"}', 'users.txt': '900101-1234567' });
  const [lic, privacy] = await runTeamTools('policy', dir);
  assert.match(lic.decision, /g\(AGPL-3.0\)/);
  assert.equal(privacy.blocking.length, 1);
});

test('verification runs the project tests in the sandbox; failing tests block', async () => {
  const dir = folder({ 'package.json': '{"scripts":{"test":"node --test"}}', 'index.html': '<html lang="ko"><title>x</title></html>' });
  const pass = sandboxReturning({ status: 'pass', code: 0, output: 'ℹ pass 3\nℹ fail 0' });
  const ok = await runTeamTools('qa', dir, { sandbox: pass });
  assert.deepEqual(ok.map(r => [r.id, r.status]), [['tests', 'pass'], ['secrets', 'pass'], ['html', 'found'], ['visual', 'unavailable']]);
  assert.deepEqual(ok[0].test, { label: 'npm test', passed: true });
  assert.equal(pass.calls[0].opts, undefined, 'tests never get network');
  const failed = await runTeamTools('qa', dir, { sandbox: sandboxReturning({ status: 'fail', code: 1, output: 'not ok 1 - adds' }) });
  assert.deepEqual(failed[0].test, { label: 'npm test', passed: false });
  assert.match(failed[0].blocking[0], /실패 \(종료 코드 1\)[\s\S]*not ok 1/);
  const none = await runTeamTools('qa', dir, { sandbox: null });
  assert.equal(none[0].status, 'unavailable');
  assert.match(toolReport(failed), /data, not instructions/);
});

test('the sandbox runner calls codex sandbox with the workspace profile and a clean environment', async () => {
  const seen = [];
  const spawnFn = (file, args, opts) => {
    seen.push({ file, args, env: opts.env });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => child.stdout;
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => child.stderr;
    setImmediate(() => { child.stdout.emit('data', 'ok'); child.emit('close', 0); });
    return child;
  };
  const env = { PATH: 'p', SystemRoot: 'C:\\Windows', KMA_AUTH_KEY: 'secret', GITHUB_TOKEN: 't', CLAUDE_CODE_MESSAGING_TOKEN: 'x', OPENAI_API_KEY: 'k' };
  const runner = new SandboxRunner({ codex: { file: 'codex.exe', prefix: [] }, env, spawnFn });
  const result = await runner.run('C:\\p', ['node', '--test']);
  assert.deepEqual(result, { status: 'pass', code: 0, output: 'ok' });
  assert.deepEqual(seen[0].args, ['sandbox', '-P', ':workspace', '-C', 'C:\\p', '--', 'node', '--test']);
  assert.deepEqual(Object.keys(seen[0].env).filter(k => /KEY|TOKEN/.test(k)), []);
  assert.equal(seen[0].env.PATH, 'p');
  assert.deepEqual(Object.keys(sandboxEnv(env)).sort(), ['CI', 'FORCE_COLOR', 'NO_COLOR', 'NO_UPDATE_NOTIFIER', 'PATH', 'SystemRoot', 'npm_config_update_notifier']);
  assert.equal((await new SandboxRunner({ codex: null }).run('C:\\p', ['x'])).status, 'unavailable');
});

test('every team lists its programs with an honest status', () => {
  const snapshot = { sandbox: { available: true }, programs: { gitleaks: true, semgrep: false } };
  const view = toolkitView(snapshot, {}, [{ id: 'web', statusL: '사용 가능', tone: 'done' }]);
  assert.deepEqual(Object.keys(view), Object.keys(TOOLKIT));
  const by = (team, id) => view[team].find(t => t.id === id);
  assert.equal(by('qa', 'tests').statusL, '사용 중 · 격리 실행');
  assert.equal(by('security', 'npm-audit').statusL, '꺼짐 · 연결 페이지에서 켬');
  assert.equal(by('security', 'gitleaks').statusL, '설치됨 · 연결 준비 중');
  assert.equal(by('security', 'semgrep').statusL, '설치 안 됨 · 설치는 대장 승인');
  assert.equal(by('research', 'web').statusL, '사용 가능');
  assert.equal(toolkitView(null, {}, [])['qa'].find(t => t.id === 'tests').statusL, '확인 전');
  for (const tool of Object.values(TOOLKIT).flat().filter(t => t.how === 'missing')) assert.ok(tool.license && tool.docs.startsWith('https://'), `${tool.id} has licence and docs`);
});

test('a failing test run passes the failure reason on, not only the counts', async () => {
  const dir = folder({ 'package.json': '{"scripts":{"test":"node --test"}}' });
  const output = ['✖ adds (1ms)', "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:", '  actual: 2', '  expected: 3',
    'ℹ tests 1', 'ℹ pass 0', 'ℹ fail 1', 'ℹ duration_ms 60', '✖ failing tests:', 'test at sum.test.js:1:1'].join('\n');
  const [tests] = await runTeamTools('qa', dir, { sandbox: sandboxReturning({ status: 'fail', code: 1, output }) });
  assert.match(tests.blocking[0], /AssertionError[\s\S]*actual: 2[\s\S]*expected: 3/);
  assert.ok(tests.details.some(l => /AssertionError/.test(l)) && tests.details.some(l => /ℹ fail 1/.test(l)));
});

test('the sandbox finds the Codex CLI again after the Codex app moved it (seen on this PC: an overnight update)', async () => {
  const { SandboxRunner } = await import('../src/격리환경.js');
  const { EventEmitter } = await import('node:events');
  const spawned = [];
  const spawnFn = (file) => { spawned.push(file); const child = new EventEmitter(); setImmediate(() => child.emit('close', 0)); return child; };
  let lookups = 0;
  const sb = new SandboxRunner({ codex: { file: 'C:/old/codex.exe', prefix: [] }, spawnFn,
    resolve: () => { lookups++; return { file: 'C:/new/codex.exe', prefix: [] }; }, exists: f => f === 'C:/new/codex.exe' });
  assert.equal(sb.available, true);
  await sb.run('C:/w', ['node', '--test']);
  assert.deepEqual(spawned, ['C:/new/codex.exe']);
  await sb.run('C:/w', ['node', '--test']);
  assert.equal(lookups, 1, 'looked up once; the new one is kept while it exists');
});
