#!/usr/bin/env node
// 원격 검증 (대장 결정 3, 2026-10-18): GitHub Actions에서 도는 검사. 로컬 훅을 건너뛰거나 검증 코드를 고쳐도, 보호 브랜치의
// 필수 검사로 이 스크립트가 원격에서 다시 확인한다. 이 파일과 워크플로 자체가 보호 파일이다.
//   node scripts/원격-검증.mjs
// 1. 보호 정책 무결성 — 꼭 보호돼야 할 파일·필수 시험·가드 검사가 빠지지 않았는가
// 2. CI 우회 경로 — 승인되지 않은 워크플로, 위험한 트리거, 실패를 삼키는 설정, 빠진 단계
// 3. 서명 — 대장 키가 등록돼 있으면 모든 승인 기록이 유효한 서명이고, 보호 파일 내용이 서명 승인과 같은가(변경 해시 일치)
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const WORKFLOW = '.github/workflows/architecture-guard.yml';
const MUST_PROTECT = ['AGENT_HQ_CONSTITUTION.md', 'architecture-policy.json', 'src/아키텍처가드.js', 'scripts/아키텍처-검사.mjs', '.githooks/pre-commit',
  'src/승인서명.js', 'scripts/승인-서명.mjs', 'scripts/원격-검증.mjs', WORKFLOW];
const MUST_STEPS = ['node scripts/아키텍처-검사.mjs', 'node scripts/원격-검증.mjs', 'node --test'];

export async function remoteCheck({ root = ROOT } = {}) {
  const problems = [], notes = [];
  const policy = JSON.parse(readFileSync(path.join(root, 'architecture-policy.json'), 'utf8'));
  // 1. 보호 정책 무결성
  for (const f of MUST_PROTECT) if (!policy.protectedFiles?.includes(f)) problems.push(`보호 파일 목록에서 빠짐: ${f}`);
  if (!policy.requiredTests?.includes('test/승인서명.test.js')) problems.push('필수 시험에서 test/승인서명.test.js 가 빠짐');
  if (policy.codexTeamExecution?.state !== 'suspended' && policy.codexTeamExecution?.state !== 'active') problems.push('Codex 실행 상태가 정책에 없음');
  const { CHECK_NAMES } = await import(new URL(`file:///${path.join(root, 'src', '아키텍처가드.js').replace(/\\/g, '/')}`).href);
  for (const name of ['헌장', 'Codex 실행 어댑터', '교차 검토', '대장 승인', '서명 승인', '보호 파일']) if (!CHECK_NAMES.includes(name)) problems.push(`아키텍처 가드 검사가 빠짐: ${name}`);
  // 2. CI 우회 경로
  const wfDir = path.join(root, '.github', 'workflows');
  const workflows = existsSync(wfDir) ? readdirSync(wfDir).filter(n => /\.ya?ml$/i.test(n)).map(n => `.github/workflows/${n}`) : [];
  if (!workflows.includes(WORKFLOW)) problems.push(`필수 워크플로가 없음: ${WORKFLOW}`);
  for (const wf of workflows) {
    const text = readFileSync(path.join(root, wf), 'utf8');
    if (!policy.protectedFiles?.includes(wf)) problems.push(`보호되지 않은 워크플로: ${wf} (보호 파일로 승인받아야 함)`);
    if (/pull_request_target|workflow_run/.test(text)) problems.push(`${wf}: pull_request_target·workflow_run 트리거 금지 (외부 코드가 저장소 권한으로 돌 수 있음)`);
    if (/continue-on-error:\s*true/.test(text)) problems.push(`${wf}: continue-on-error 금지 (검사 실패를 삼킴)`);
    if (/permissions:\s*write-all|contents:\s*write/.test(text)) problems.push(`${wf}: 쓰기 권한 금지`);
    if (/uses:\s*[^@\s]+@(?![0-9a-f]{40}\b)/.test(text)) problems.push(`${wf}: 외부 Action 은 커밋 해시로 고정해야 함`);
  }
  if (existsSync(path.join(root, WORKFLOW))) {
    const text = readFileSync(path.join(root, WORKFLOW), 'utf8');
    for (const step of MUST_STEPS) if (!text.includes(step)) problems.push(`${WORKFLOW}: 필수 단계가 빠짐 — ${step}`);
  }
  // 3. 서명
  const { signingMode, validRecords, verifyRecord, checkProtected, protectedHashes, APPROVAL_DIR } = await import(new URL(`file:///${path.join(root, 'src', '승인서명.js').replace(/\\/g, '/')}`).href);
  const mode = signingMode(root);
  const recordFiles = existsSync(path.join(root, APPROVAL_DIR)) ? readdirSync(path.join(root, APPROVAL_DIR)).filter(n => n.endsWith('.json')) : [];
  if (mode !== 'enforced') {
    if (recordFiles.length) problems.push(`대장 공개 키 없이 승인 기록 ${recordFiles.length}건이 있음 — 확인할 수 없는 승인은 허용하지 않음`);
    notes.push('대장 서명 키 미등록 — 서명 검증은 키 등록 뒤부터 강제된다 (보호 브랜치 필수 검사로 걸어 두면 등록 즉시 적용)');
  } else {
    for (const n of recordFiles) {
      const r = verifyRecord(path.join(root, APPROVAL_DIR, n), { root });
      if (!r.ok) problems.push(`승인 기록 서명 무효: ${n} — ${r.why}`);
    }
    const p = checkProtected({ files: protectedHashes({ root, policy }), root, records: validRecords({ root }) });
    problems.push(...p.problems.map(x => `서명 · ${x}`));
  }
  return { ok: problems.length === 0, mode, problems, notes };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await remoteCheck();
  for (const n of r.notes) console.log(`! ${n}`);
  for (const p of r.problems) console.log(`✗ ${p}`);
  console.log(r.ok ? `원격 검증 통과 (서명 ${r.mode})` : `원격 검증 실패 ${r.problems.length}건`);
  process.exit(r.ok ? 0 : 1);
}
