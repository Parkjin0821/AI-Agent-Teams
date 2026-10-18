import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKFLOW, remoteCheck } from '../scripts/원격-검증.mjs';
import { ALLOWED_SIGNERS, NAMESPACE, SIGNER, makeRequest, protectedHashes, sshKeygen, writeRequest } from '../src/승인서명.js';

// 원격 검증: the CI check catches the ways around the protection — an unprotected or weakened workflow, a dangerous
// trigger, an unpinned action, a missing step, a dropped protected file, approvals that cannot be verified.
const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
function copy() {
  const dir = mkdtempSync(path.join(tmpdir(), 'hq-remote-'));
  for (const p of ['src', 'scripts', '.github', '.githooks', 'architecture-policy.json', 'AGENT_HQ_CONSTITUTION.md']) cpSync(path.join(ROOT, p), path.join(dir, p), { recursive: true });
  return dir;
}
const edit = (dir, rel, from, to) => { const f = path.join(dir, rel); writeFileSync(f, readFileSync(f, 'utf8').replace(from, to)); };
const editPolicy = (dir, fn) => { const f = path.join(dir, 'architecture-policy.json'); const p = JSON.parse(readFileSync(f, 'utf8')); fn(p); writeFileSync(f, JSON.stringify(p, null, 2)); };

test('this repository passes the remote check', async () => {
  const r = await remoteCheck();
  assert.ok(r.ok, r.problems.join('\n'));
});

test('ways around the protection are caught', async () => {
  const cases = [
    ['workflow removed from the protected list', d => editPolicy(d, p => { p.protectedFiles = p.protectedFiles.filter(f => f !== WORKFLOW); }), /보호 파일 목록에서 빠짐/],
    ['remote check script unprotected', d => editPolicy(d, p => { p.protectedFiles = p.protectedFiles.filter(f => f !== 'scripts/원격-검증.mjs'); }), /원격-검증/],
    ['signing test dropped', d => editPolicy(d, p => { p.requiredTests = p.requiredTests.filter(f => f !== 'test/승인서명.test.js'); }), /승인서명/],
    ['pull_request_target', d => edit(d, WORKFLOW, 'pull_request:', 'pull_request_target:'), /pull_request_target/],
    ['failures swallowed', d => edit(d, WORKFLOW, 'run: node scripts/원격-검증.mjs', 'run: node scripts/원격-검증.mjs\n        continue-on-error: true'), /continue-on-error/],
    ['unpinned action', d => edit(d, WORKFLOW, /actions\/checkout@[0-9a-f]{40}/, 'actions/checkout@v7'), /커밋 해시/],
    ['write permission', d => edit(d, WORKFLOW, 'contents: read', 'contents: write'), /쓰기 권한/],
    ['test step removed', d => edit(d, WORKFLOW, 'run: node --test "test/**/*.test.js"', 'run: echo skipped'), /node --test/],
    ['extra unprotected workflow', d => { mkdirSync(path.join(d, '.github', 'workflows'), { recursive: true }); writeFileSync(path.join(d, '.github', 'workflows', 'other.yml'), 'on: push\n'); }, /보호되지 않은 워크플로/],
    ['approval records without a key', d => { mkdirSync(path.join(d, 'approvals'), { recursive: true }); writeFileSync(path.join(d, 'approvals', 'x.json'), '{}'); }, /확인할 수 없는 승인/],
  ];
  for (const [label, change, want] of cases) {
    const d = copy();
    try {
      change(d);
      const r = await remoteCheck({ root: d });
      assert.equal(r.ok, false, label);
      assert.ok(r.problems.some(p => want.test(p)), `${label}: ${r.problems.join(' / ')}`);
    } finally { rmSync(d, { recursive: true, force: true }); }
  }
});

const keygen = sshKeygen();
test('with a key registered: protected files must match signed approvals, and every record must verify', { skip: spawnSync(keygen, ['-?']).error ? 'ssh-keygen 없음' : false, timeout: 60_000 }, async () => {
  const d = copy(), keys = mkdtempSync(path.join(tmpdir(), 'hq-remote-key-'));
  try {
    const key = path.join(keys, 'k');
    spawnSync(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 't', '-f', key]);
    mkdirSync(path.join(d, 'approvals'), { recursive: true });
    writeFileSync(path.join(d, ALLOWED_SIGNERS), `${SIGNER} namespaces="${NAMESPACE}" ${readFileSync(`${key}.pub`, 'utf8').trim().split(/\s+/).slice(0, 2).join(' ')}\n`);
    const policy = JSON.parse(readFileSync(path.join(d, 'architecture-policy.json'), 'utf8'));
    assert.equal((await remoteCheck({ root: d })).ok, false, 'no approvals yet');
    const { file } = writeRequest(makeRequest({ kind: 'protected-change', purpose: '초기 승인 (시험)', policyVersion: 't',
      targets: Object.entries(protectedHashes({ root: d, policy })).map(([p, h]) => ({ path: p, sha256: h })) }), d);
    spawnSync(keygen, ['-Y', 'sign', '-n', NAMESPACE, '-f', key, file]);
    const ok = await remoteCheck({ root: d });
    assert.ok(ok.ok, ok.problems.join('\n'));
    // An unsigned record next to it, or a protected file changed after signing, fails the check.
    writeFileSync(path.join(d, 'approvals', 'zz-unsigned.json'), readFileSync(file));
    assert.ok((await remoteCheck({ root: d })).problems.some(p => /서명 무효/.test(p)));
    rmSync(path.join(d, 'approvals', 'zz-unsigned.json'));
    edit(d, 'architecture-policy.json', '"reviewBy": "2026-11-15"', '"reviewBy": "2099-01-01"');
    assert.ok((await remoteCheck({ root: d })).problems.some(p => /승인된 내용과 다름/.test(p)));
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(keys, { recursive: true, force: true }); }
});
