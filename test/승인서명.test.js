import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ALLOWED_SIGNERS, NAMESPACE, ROOT, SIGNER, baselineDigest, canonical, checkBaseline, checkProtected, makeRequest, protectedHashes, sha256,
  signingMode, sshKeygen, validRecords, verifyRecord, writeRequest,
} from '../src/승인서명.js';

// 서명 승인: a throwaway key stands in for 대장's (made here, deleted after). It proves the mechanism, not 대장's key custody.
const keygen = sshKeygen();
const hasKeygen = spawnSync(keygen, ['-?'], { encoding: 'utf8' }).error === undefined;
const skip = hasKeygen ? false : 'ssh-keygen 없음';

function setup({ principal = SIGNER, namespace = NAMESPACE } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-approval-'));
  const keys = mkdtempSync(path.join(tmpdir(), 'hq-approval-key-'));
  const key = path.join(keys, 'k');
  spawnSync(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', key]);
  const pub = readFileSync(`${key}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
  mkdirSync(path.join(root, 'approvals'), { recursive: true });
  writeFileSync(path.join(root, ALLOWED_SIGNERS), `${principal} namespaces="${namespace}" ${pub}\n`);
  const sign = (file, n = NAMESPACE, k = key) => { rmSync(`${file}.sig`, { force: true }); return spawnSync(keygen, ['-Y', 'sign', '-n', n, '-f', k, file], { encoding: 'utf8' }); };
  return { root, key, sign, cleanup: () => { rmSync(root, { recursive: true, force: true }); rmSync(keys, { recursive: true, force: true }); } };
}
const target = (p, body) => ({ path: p, sha256: sha256(body) });

test('canonical form: same record, same bytes, whatever the key order', () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
  assert.equal(baselineDigest({ x: '1', y: '2' }), baselineDigest({ y: '2', x: '1' }));
});

test('requests: purpose, targets and kind are required and checked', () => {
  assert.throws(() => makeRequest({ kind: 'other', purpose: 'xxxx' }), /kind/);
  assert.throws(() => makeRequest({ kind: 'protected-change', purpose: '' , targets: [target('a', 'x')] }), /purpose/);
  assert.throws(() => makeRequest({ kind: 'protected-change', purpose: '정책 갱신' }), /target/);
  assert.throws(() => makeRequest({ kind: 'protected-change', purpose: '정책 갱신', targets: [{ path: '../x', sha256: sha256('x') }] }), /bad target/);
  assert.throws(() => makeRequest({ kind: 'baseline', purpose: '기준 등록' }), /digest/);
  const r = makeRequest({ kind: 'protected-change', purpose: '정책 갱신', policyVersion: 'v1', targets: [target('b.json', 'B'), target('a.md', 'A')], now: new Date('2026-10-18T00:00:00Z') });
  assert.deepEqual(r.targets.map(t => t.path), ['a.md', 'b.json']);
  assert.equal(r.signer, SIGNER);
});

test('not configured: without 대장\'s public key nothing counts as approved', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'hq-approval-none-'));
  try {
    assert.equal(signingMode(root), 'not-configured');
    assert.equal(checkProtected({ files: { 'x': sha256('x') }, root }).ok, false);
    assert.equal(checkBaseline({ items: { a: '1' }, root }).ok, false);
    writeFileSync(path.join(root, 'approvals.txt'), '');
    mkdirSync(path.join(root, 'approvals'));
    writeFileSync(path.join(root, ALLOWED_SIGNERS), '# 키 없음\n');
    assert.equal(signingMode(root), 'not-configured', 'a file with only comments is not a key');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('signed record: verifies; any change to the record, another key or another namespace fails', { skip }, () => {
  const s = setup();
  try {
    const { file } = writeRequest(makeRequest({ kind: 'protected-change', purpose: '정책 갱신 시험', policyVersion: 'v1', targets: [target('architecture-policy.json', 'P')] }), s.root);
    assert.equal(verifyRecord(file, { root: s.root, keygen }).ok, false, 'unsigned');
    assert.equal(s.sign(file).status, 0);
    assert.equal(verifyRecord(file, { root: s.root, keygen }).ok, true);
    // Edited after signing.
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace('정책 갱신 시험', '다른 목적'));
    assert.equal(verifyRecord(file, { root: s.root, keygen }).ok, false);
    writeFileSync(file, original);
    // Signed under another namespace or by a key that is not registered.
    const other = setup();
    try {
      assert.equal(s.sign(file, 'git').status, 0);
      assert.equal(verifyRecord(file, { root: s.root, keygen }).ok, false, 'wrong namespace');
      assert.equal(other.sign(file, NAMESPACE, other.key).status, 0);
      assert.equal(verifyRecord(file, { root: s.root, keygen }).ok, false, 'unregistered key');
    } finally { other.cleanup(); }
  } finally { s.cleanup(); }
});

test('protected files: must match the latest signed approval; an unsigned change is caught', { skip }, () => {
  const s = setup();
  try {
    let tick = Date.parse('2026-10-18T00:00:00Z');
    const sign = targets => { const { file } = writeRequest(makeRequest({ kind: 'protected-change', purpose: '보호 파일 변경', policyVersion: 'v1', targets, now: new Date(tick += 1000) }), s.root); s.sign(file); };
    sign([target('architecture-policy.json', 'v1'), target(ALLOWED_SIGNERS, 'keys')]);
    assert.equal(checkProtected({ files: { 'architecture-policy.json': sha256('v1') }, root: s.root, keygen }).ok, true);
    const changed = checkProtected({ files: { 'architecture-policy.json': sha256('v2') }, root: s.root, keygen });
    assert.equal(changed.ok, false);
    assert.match(changed.problems[0], /승인된 내용과 다름/);
    assert.match(checkProtected({ files: { 'src/아키텍처가드.js': sha256('g') }, root: s.root, keygen }).problems[0], /승인 기록 없음/);
    sign([target('architecture-policy.json', 'v2')]);
    assert.equal(checkProtected({ files: { 'architecture-policy.json': sha256('v2') }, root: s.root, keygen }).ok, true, 'a newer approval wins');
    // An unsigned request file next to the signed ones changes nothing.
    writeRequest(makeRequest({ kind: 'protected-change', purpose: '서명 안 한 요청', policyVersion: 'v1', targets: [target('architecture-policy.json', 'v3')] }), s.root);
    assert.equal(checkProtected({ files: { 'architecture-policy.json': sha256('v3') }, root: s.root, keygen }).ok, false);
    assert.equal(validRecords({ root: s.root, keygen }).length, 2);
  } finally { s.cleanup(); }
});

test('environment baseline: only a baseline whose digest 대장 signed is accepted', { skip }, () => {
  const s = setup();
  try {
    const items = { wslconf: 'h1', setuid: 'h2' };
    assert.equal(checkBaseline({ items, root: s.root, keygen }).ok, false);
    const { file } = writeRequest(makeRequest({ kind: 'baseline', purpose: '기준 등록', policyVersion: 'v1', baseline: { digest: baselineDigest(items) } }), s.root);
    s.sign(file);
    assert.equal(checkBaseline({ items, root: s.root, keygen }).ok, true);
    assert.equal(checkBaseline({ items: { ...items, setuid: 'h3' }, root: s.root, keygen }).ok, false, 're-recorded without a signature');
  } finally { s.cleanup(); }
});

// Outside git hooks: npm test checks the real repository whenever 대장's key is registered.
test('this repository: protected files match 대장\'s signed approvals', { skip: signingMode(ROOT) === 'enforced' ? false : '대장 서명 키 미등록 (node scripts/승인-서명.mjs --setup)' }, () => {
  const policy = JSON.parse(readFileSync(path.join(ROOT, 'architecture-policy.json'), 'utf8'));
  const r = checkProtected({ files: protectedHashes({ policy }) });
  assert.ok(r.ok, r.problems.join('\n'));
});

// The commit check itself (scripts/아키텍처-검사.mjs --staged), in a throwaway git repository holding a copy of the
// engine: once a key is registered the environment marker no longer counts — only a signed approval of exactly the
// staged content lets a protected change through.
test('commit check: with a key registered, a protected change needs a signature of exactly that content', { skip, timeout: 120_000 }, async () => {
  const { cpSync, existsSync: has } = await import('node:fs');
  const repo = mkdtempSync(path.join(tmpdir(), 'hq-hook-'));
  const keys = mkdtempSync(path.join(tmpdir(), 'hq-hook-key-'));
  try {
    for (const p of ['src', 'scripts', 'test', '.githooks', 'architecture-policy.json', 'AGENT_HQ_CONSTITUTION.md', 'package.json']) if (has(path.join(ROOT, p))) cpSync(path.join(ROOT, p), path.join(repo, p), { recursive: true });
    const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' });
    git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'base', '--no-verify');
    const key = path.join(keys, 'k');
    spawnSync(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', key]);
    mkdirSync(path.join(repo, 'approvals'), { recursive: true });
    writeFileSync(path.join(repo, ALLOWED_SIGNERS), `${SIGNER} namespaces="${NAMESPACE}" ${readFileSync(`${key}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')}\n`);
    const policyFile = path.join(repo, 'architecture-policy.json');
    // First, the one-time initial registration 대장 signs when the key is set up: every protected file as it is now.
    const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
    const initial = writeRequest(makeRequest({ kind: 'protected-change', purpose: '서명 키 등록 — 보호 파일 초기 승인', policyVersion: 'test',
      targets: Object.entries(protectedHashes({ root: repo, policy })).map(([p, h]) => ({ path: p, sha256: h })), now: new Date(Date.now() - 60_000) }), repo);
    spawnSync(keygen, ['-Y', 'sign', '-n', NAMESPACE, '-f', key, initial.file]);
    writeFileSync(policyFile, readFileSync(policyFile, 'utf8').replace('"reviewBy": "2026-11-15"', '"reviewBy": "2026-11-16"'));
    git('add', 'architecture-policy.json');
    const check = env => spawnSync(process.execPath, ['scripts/아키텍처-검사.mjs', '--staged'], { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env } });
    const marker = check({ AGENT_HQ_ARCH_APPROVED: '대장' });
    assert.equal(marker.status, 1, 'the marker alone must not pass');
    assert.match(marker.stdout, /대장 서명 승인과 다르다/);
    // 대장 signs a request for exactly the staged content.
    const { file } = writeRequest(makeRequest({ kind: 'protected-change', purpose: '재검토일 변경 시험', policyVersion: 'test',
      targets: [{ path: 'architecture-policy.json', sha256: sha256(readFileSync(policyFile, 'utf8').replace(/\r\n/g, '\n')) }] }), repo);
    spawnSync(keygen, ['-Y', 'sign', '-n', NAMESPACE, '-f', key, file]);
    const signed = check({});
    assert.equal(signed.status, 0, signed.stdout.split(/\r?\n/).filter(l => /^[✗!]|보류|실패/.test(l)).join(' | '));
    assert.match(signed.stdout, /대장 서명 승인 확인/);
    // Changing the staged content after signing is caught again.
    writeFileSync(policyFile, readFileSync(policyFile, 'utf8').replace('"reviewBy": "2026-11-16"', '"reviewBy": "2026-11-17"'));
    git('add', 'architecture-policy.json');
    assert.equal(check({ AGENT_HQ_ARCH_APPROVED: '대장' }).status, 1);
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(keys, { recursive: true, force: true }); }
});
