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
