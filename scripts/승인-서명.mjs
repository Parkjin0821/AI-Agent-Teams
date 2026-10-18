#!/usr/bin/env node
// 서명 승인 도구 (docs/codex-격리-복원.md 13절). 엔진은 요청을 만들고 서명을 확인만 한다. 서명은 대장이 대장의 키로 한다.
//   node scripts/승인-서명.mjs                       상태: 서명 키 등록 여부, 유효한 승인 기록, 보호 파일·환경 기준 일치
//   node scripts/승인-서명.mjs --request-protected "목적" [파일 …]   보호 파일 변경 승인 요청(지금 내용의 해시) 만들기
//   node scripts/승인-서명.mjs --request-baseline "목적"             지금 Codex 환경 기준(data/코덱스격리-기준.json) 승인 요청
//   node scripts/승인-서명.mjs --verify <approvals/….json>         한 기록의 서명 확인
//   node scripts/승인-서명.mjs --setup                              대장 키 만들기·등록 안내 (아무것도 바꾸지 않음)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ALLOWED_SIGNERS, NAMESPACE, ROOT, SIGNER, baselineDigest, checkBaseline, checkProtected, fileHash, makeRequest, protectedHashes, signingMode, validRecords, verifyRecord, writeRequest } from '../src/승인서명.js';
import { BASELINE_FILE, readBaseline } from '../src/코덱스격리실행.js';

const args = process.argv.slice(2);
const policy = JSON.parse(readFileSync(path.join(ROOT, 'architecture-policy.json'), 'utf8'));
const policyVersion = `v${policy.version}+${fileHash(path.join(ROOT, 'architecture-policy.json')).slice(0, 12)}`;

if (args[0] === '--setup') {
  console.log(`대장 서명 키 만들기 (대장이 직접, AI는 키를 보거나 쓰지 않는다)

권장 — 보안 키(FIDO2, PIN+터치 필요):
  ssh-keygen -t ed25519-sk -O verify-required -C "AGENT HQ 대장 승인" -f %USERPROFILE%\\.ssh\\agent-hq-approval
보안 키가 없으면 — 비밀번호를 건 키 (ssh-agent 에 올리지 않는다):
  ssh-keygen -t ed25519 -C "AGENT HQ 대장 승인" -f %USERPROFILE%\\.ssh\\agent-hq-approval
공개 키 등록 (리포에 커밋되는 파일, 보호 파일로 지정 예정):
  ${ALLOWED_SIGNERS} 에 한 줄:  ${SIGNER} namespaces="${NAMESPACE}" <agent-hq-approval.pub 의 앞 두 칸>
서명 (요청 파일마다):
  ssh-keygen -Y sign -n ${NAMESPACE} -f %USERPROFILE%\\.ssh\\agent-hq-approval <approvals\\….json>`);
  process.exit(0);
}
if (args[0] === '--verify') {
  const r = verifyRecord(path.resolve(args[1] ?? ''));
  console.log(r.ok ? `✓ 유효한 대장 서명 · ${r.record.kind} · ${r.record.purpose}` : `✗ ${r.why}`);
  process.exit(r.ok ? 0 : 1);
}
if (args[0] === '--request-protected') {
  const purpose = args[1];
  const files = args.slice(2).length ? args.slice(2) : Object.keys(protectedHashes({ policy }));
  const targets = files.map(f => ({ path: f.replace(/\\/g, '/'), sha256: fileHash(path.join(ROOT, f)) }));
  const { file, signCommand } = writeRequest(makeRequest({ kind: 'protected-change', purpose, policyVersion, targets }));
  console.log(`승인 요청: ${file}\n목적: ${purpose}\n대상(변경 뒤 내용의 해시):\n${targets.map(t => `  ${t.path}  ${t.sha256.slice(0, 16)}…`).join('\n')}\n\n대장이 내용을 확인한 뒤 서명:\n  ${signCommand}`);
  process.exit(0);
}
if (args[0] === '--request-baseline') {
  const baseline = readBaseline(BASELINE_FILE);
  if (!baseline?.items) { console.log('환경 기준이 없다: node scripts/코덱스격리-준비.mjs --record-baseline'); process.exit(1); }
  const digest = baselineDigest(baseline.items);
  const { file, signCommand } = writeRequest(makeRequest({ kind: 'baseline', purpose: args[1], policyVersion, baseline: { digest, recordedAt: baseline.recordedAt, keys: Object.keys(baseline.items).length } }));
  console.log(`승인 요청: ${file}\n환경 기준 지문 ${digest.slice(0, 16)}… (기록 ${baseline.recordedAt}, 항목 ${Object.keys(baseline.items).length}개)\n\n대장이 확인한 뒤 서명:\n  ${signCommand}`);
  process.exit(0);
}

const mode = signingMode();
console.log(`서명 상태: ${mode === 'enforced' ? '강제 (대장 공개 키 등록됨)' : '미설정 — 대장 키가 등록되지 않아 어떤 승인도 서명으로 확인할 수 없음'}`);
if (mode === 'enforced') {
  const records = validRecords();
  console.log(`유효한 승인 기록 ${records.length}건`);
  const p = checkProtected({ files: protectedHashes({ policy }), records });
  console.log(p.ok ? '✓ 보호 파일이 모두 서명 승인된 내용과 같다' : `✗ 보호 파일:\n- ${p.problems.join('\n- ')}`);
  const baseline = readBaseline(BASELINE_FILE);
  const b = baseline?.items ? checkBaseline({ items: baseline.items, records }) : { ok: false, problems: ['환경 기준 없음'] };
  console.log(b.ok ? '✓ Codex 환경 기준에 대장 서명이 있다' : `✗ 환경 기준: ${b.problems.join(', ')}`);
  process.exit(p.ok && b.ok ? 0 : 1);
}
console.log(`안내: node scripts/승인-서명.mjs --setup${existsSync(path.join(ROOT, ALLOWED_SIGNERS)) ? ' (allowed_signers 는 있으나 키 줄이 없음)' : ''}`);
process.exit(1);
