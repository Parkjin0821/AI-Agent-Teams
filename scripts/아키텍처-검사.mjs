// 아키텍처 검사 (AGENT_HQ_CONSTITUTION.md): is the Claude Code + Codex structure still all there?
//   node scripts/아키텍처-검사.mjs                      every check, exit 1 if one fails
//   node scripts/아키텍처-검사.mjs --proposal "문장"    judges a proposed change (위반 · 대장 승인 필요 · 무관)
//   node scripts/아키텍처-검사.mjs --fingerprint        the constitution's fingerprint, for architecture-policy.json
//   node scripts/아키텍처-검사.mjs --staged             before a commit (.githooks/pre-commit): the checks, and a
//     staged change to a protected file needs 대장's mark: AGENT_HQ_ARCH_APPROVED=대장 git commit ...
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CONSTITUTION_FILE, ROOT, checkArchitecture, fingerprint, judgeChange, readPolicy } from '../src/아키텍처가드.js';

const args = process.argv.slice(2);
const VERDICT = { violation: '위반 · 거부', core: '핵심 설계 변경 · 대장 승인 필요', ok: '핵심 설계와 무관' };

if (args[0] === '--proposal') {
  const j = judgeChange(args.slice(1).join(' '));
  console.log(`${VERDICT[j.verdict]}${j.reasons.length ? `\n- ${j.reasons.join('\n- ')}` : ''}`);
  process.exit(j.verdict === 'violation' ? 1 : 0);
}
if (args[0] === '--fingerprint') {
  console.log(fingerprint(readFileSync(path.join(ROOT, CONSTITUTION_FILE), 'utf8')));
  process.exit(0);
}

const { ok, results, warnings } = await checkArchitecture();
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name} — ${r.ok ? r.about : r.problem}`);
for (const w of warnings) console.log(`! ${w}`);
let unapproved = false;
if (args[0] === '--staged') {
  const staged = spawnSync('git', ['diff', '--cached', '--name-only', '-z'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
  const touched = staged.filter(f => readPolicy().protectedFiles.includes(f));
  if (touched.length && process.env.AGENT_HQ_ARCH_APPROVED !== '대장') {
    console.log(`✗ 보호 파일 변경 — 대장 승인 표시가 없다: ${touched.join(', ')}\n  대장이 확인한 변경이면: AGENT_HQ_ARCH_APPROVED=대장 git commit ...`);
    unapproved = true;
  } else if (touched.length) console.log(`✓ 보호 파일 변경 — 대장 승인 표시 있음: ${touched.join(', ')}`);
}
console.log(!ok ? '\n아키텍처 검사 실패 · 헌장(AGENT_HQ_CONSTITUTION.md)이 지키라는 구조가 빠졌습니다.'
  : unapproved ? '\n커밋 보류 · 헌장·가드 파일 변경에는 대장 승인 표시가 필요합니다.' : '\n아키텍처 검사 통과');
process.exit(!ok || unapproved ? 1 : 0);
