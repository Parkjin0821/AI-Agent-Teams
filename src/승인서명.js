import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 서명 승인 (docs/codex-격리-복원.md 13절, 대장 지시 2026-10-18): 대장 승인을 "환경변수 한 줄"이 아니라, 대장만 가진 서명 키로
// 서명한 승인 기록으로 증명한다. 기록은 무엇을(대상 파일과 변경 뒤 해시, 또는 환경 기준 지문의 해시), 왜(목적), 어느 정책 판에서,
// 언제 승인했는지를 담고, OpenSSH 서명(ssh-keygen -Y sign/verify)으로 묶는다. 엔진은 공개 키(approvals/allowed_signers)만 가진다.
//
// 상태 두 가지:
//   not-configured — allowed_signers 가 아직 없다(대장 키 미등록). 서명을 확인할 방법이 없으므로 아무것도 "승인됨"으로 보지 않는다.
//                    기존 절차(환경변수 표시)는 그대로 두되, Codex 활성화 조건에서는 미충족으로 친다.
//   enforced       — allowed_signers 가 있다. 보호 파일의 현재 내용과 환경 기준은 유효한 서명 기록과 일치해야 한다.
// 한계: 검증 코드도 같은 Windows 계정에서 돈다. 이 모듈이 막는 것은 "서명 없이 승인을 만드는 것"이고, 검증 코드 자체를 고치는
// 공격은 리포 밖 검증(원격 CI·브랜치 보호)이 있어야 막힌다. 키 보관(보안 키·비밀번호)은 대장 결정 사항이다.

export const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const APPROVAL_DIR = 'approvals';
export const ALLOWED_SIGNERS = `${APPROVAL_DIR}/allowed_signers`;
export const NAMESPACE = 'agent-hq-approval';
export const SIGNER = 'daejang';
export const KINDS = ['protected-change', 'baseline'];

export const sha256 = data => createHash('sha256').update(data).digest('hex');
// The same record must hash and sign the same way on every machine: keys sorted, no spaces, LF only.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
// Text files are hashed by content with line endings normalised (git may check out CRLF on Windows).
export const fileHash = file => sha256(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
export const baselineDigest = items => sha256(canonical(items));

export function sshKeygen() {
  const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe');
  return process.env.AGENT_HQ_SSH_KEYGEN || (process.platform === 'win32' && existsSync(system) ? system : 'ssh-keygen');
}

export function signingMode(root = ROOT) {
  const file = path.join(root, ALLOWED_SIGNERS);
  if (!existsSync(file)) return 'not-configured';
  return readFileSync(file, 'utf8').split(/\r?\n/).some(l => l.trim() && !l.trim().startsWith('#')) ? 'enforced' : 'not-configured';
}

// ── 승인 요청 (엔진이 만든다, 서명은 대장이) ────────────────────────────────────────────────────────────────────────
// targets: [{ path, sha256 }] — the protected files AFTER the change, by content hash.
export function makeRequest({ kind, purpose, policyVersion, targets = [], baseline = null, now = new Date() }) {
  if (!KINDS.includes(kind)) throw new Error(`unknown approval kind: ${kind}`);
  if (!purpose || String(purpose).trim().length < 4) throw new Error('approval purpose is required');
  if (kind === 'protected-change' && !targets.length) throw new Error('a protected change needs its target files');
  if (kind === 'baseline' && !/^[0-9a-f]{64}$/.test(baseline?.digest ?? '')) throw new Error('a baseline approval needs the baseline digest');
  for (const t of targets) if (!/^[0-9a-f]{64}$/.test(t.sha256 ?? '') || !t.path || t.path.includes('..') || path.isAbsolute(t.path)) throw new Error(`bad target: ${t.path}`);
  return { version: 1, kind, purpose: String(purpose).trim(), policyVersion: String(policyVersion ?? ''), approvedAt: now.toISOString(), signer: SIGNER,
    targets: [...targets].sort((a, b) => a.path.localeCompare(b.path)), ...(baseline ? { baseline } : {}) };
}
// Writes approvals/<when>-<kind>-<hash12>.json (the exact bytes 대장 signs) and returns the path and the command to sign it.
export function writeRequest(record, root = ROOT) {
  const text = `${canonical(record)}\n`;
  const name = `${record.approvedAt.replace(/[-:.]/g, '').slice(0, 18)}-${record.kind}-${sha256(text).slice(0, 12)}.json`;
  const dir = path.join(root, APPROVAL_DIR);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return { file, signCommand: `ssh-keygen -Y sign -n ${NAMESPACE} -f <대장 서명 키> "${file}"` };
}

// ── 검증 ────────────────────────────────────────────────────────────────────────────────────────────────────────
export function verifyRecord(file, { root = ROOT, keygen = sshKeygen() } = {}) {
  const signers = path.join(root, ALLOWED_SIGNERS);
  if (signingMode(root) !== 'enforced') return { ok: false, why: '서명 키가 등록되지 않음 (approvals/allowed_signers)' };
  if (!existsSync(`${file}.sig`)) return { ok: false, why: '서명 파일(.sig) 없음' };
  let record;
  const text = readFileSync(file);
  try { record = JSON.parse(text.toString('utf8')); } catch { return { ok: false, why: '기록을 읽지 못함' }; }
  if (`${canonical(record)}\n` !== text.toString('utf8')) return { ok: false, why: '기록이 정규 형식이 아님 (서명 뒤 수정 의심)' };
  if (record.version !== 1 || !KINDS.includes(record.kind) || record.signer !== SIGNER) return { ok: false, why: '기록 형식이 맞지 않음' };
  const r = spawnSync(keygen, ['-Y', 'verify', '-f', signers, '-I', record.signer, '-n', NAMESPACE, '-s', `${file}.sig`], { input: text, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? { ok: true, record } : { ok: false, why: `서명 검증 실패: ${String(r.stderr || r.stdout).trim().split('\n')[0]}` };
}

export function validRecords({ root = ROOT, keygen } = {}) {
  const dir = path.join(root, APPROVAL_DIR);
  if (!existsSync(dir)) return [];
  // Oldest first by the approval time inside the signed record (a file name proves nothing).
  return readdirSync(dir).filter(n => n.endsWith('.json'))
    .map(n => ({ name: n, ...verifyRecord(path.join(dir, n), { root, keygen }) })).filter(r => r.ok)
    .sort((a, b) => a.record.approvedAt.localeCompare(b.record.approvedAt) || a.name.localeCompare(b.name));
}

// Protected files must be exactly what the latest valid approval covering each of them says.
// files: { path: sha256 } of what is being checked (the working tree, or the staged blobs before a commit).
export function checkProtected({ files, root = ROOT, keygen, records = null }) {
  const mode = signingMode(root);
  if (mode !== 'enforced') return { mode, ok: false, problems: ['서명 키 미등록 — 보호 파일 승인을 서명으로 확인할 수 없음'] };
  const valid = records ?? validRecords({ root, keygen });
  const latest = new Map();
  for (const r of valid.filter(v => v.record.kind === 'protected-change')) for (const t of r.record.targets) latest.set(t.path, { sha256: t.sha256, by: r.name });
  const problems = [];
  for (const [file, hash] of Object.entries(files)) {
    const approved = latest.get(file);
    if (!approved) problems.push(`승인 기록 없음 · ${file}`);
    else if (approved.sha256 !== hash) problems.push(`승인된 내용과 다름 · ${file} (마지막 승인 ${approved.by})`);
  }
  return { mode, ok: problems.length === 0, problems };
}

export function checkBaseline({ items, root = ROOT, keygen, records = null }) {
  const mode = signingMode(root);
  if (mode !== 'enforced') return { mode, ok: false, problems: ['서명 키 미등록 — 환경 기준을 서명으로 확인할 수 없음'] };
  const digest = baselineDigest(items);
  const valid = (records ?? validRecords({ root, keygen })).filter(v => v.record.kind === 'baseline');
  return valid.some(v => v.record.baseline?.digest === digest)
    ? { mode, ok: true, problems: [] } : { mode, ok: false, problems: ['환경 기준에 대장 서명 승인이 없음'] };
}

// Current hashes of the protected files (+ the trust root itself) in the working tree, or as staged in git.
export function protectedHashes({ root = ROOT, policy, staged = false } = {}) {
  const list = [...new Set([...(policy?.protectedFiles ?? []), ALLOWED_SIGNERS])];
  const out = {};
  for (const rel of list) {
    if (staged) {
      const r = spawnSync('git', ['show', `:${rel}`], { cwd: root, encoding: 'utf8', windowsHide: true });
      if (r.status === 0) out[rel] = sha256(r.stdout.replace(/\r\n/g, '\n'));
    } else if (existsSync(path.join(root, rel))) out[rel] = fileHash(path.join(root, rel));
  }
  return out;
}
