#!/usr/bin/env node
// Windows Codex 샌드박스가 남긴 폴더 권한 — 정리 준비 (대장 결정 3, 2026-10-18). 이 스크립트는 권한을 바꾸지 않는다.
//   node scripts/코덱스권한-정리준비.mjs            목록만: CodexSandboxUsers 에 명시적으로 붙은 허용 권한이 있는 폴더
//   node scripts/코덱스권한-정리준비.mjs --backup   목록 + 대상 폴더 권한 백업(icacls /save) + 정리·복구 명령 파일
//   node scripts/코덱스권한-정리준비.mjs --status   이전 현황: 권한 대상 수(마지막 백업과 비교) + Windows 샌드박스 사용 경로 6곳의 상태
// 정리 자체는 대장 승인 뒤, 엔진의 Windows 샌드박스 사용 경로가 새 격리 환경으로 옮겨진 다음에 관리자 PowerShell에서
// 백업 폴더의 정리명령.txt 를 따라 한다. 상속된(I) 항목과 거부(DENY) 항목, 사용자·SYSTEM·관리자 권한은 건드리지 않는다.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GROUP = 'CodexSandboxUsers';
const home = os.homedir();
const drive = path.parse(home).root;
const dirsIn = dir => { try { return readdirSync(dir).map(n => path.join(dir, n)).filter(p => { try { return statSync(p).isDirectory(); } catch { return false; } }); } catch { return []; } };
// icacls prints in the console code page; only the ACE lines (ASCII) are read, and the path is the one we passed.
function aces(target) {
  const r = spawnSync('icacls', [target], { encoding: 'latin1', windowsHide: true });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).filter(l => l.includes(`${GROUP}:`)).map(l => l.slice(l.indexOf(`${GROUP}:`) + GROUP.length + 1).trim());
}

const candidates = [home, ...dirsIn(home), drive, ...dirsIn(drive)];
const targets = [], denies = [], unreadable = [];
for (const p of [...new Set(candidates)]) {
  const list = aces(p);
  if (list === null) { unreadable.push(p); continue; }
  const explicitAllow = list.filter(a => !a.includes('(I)') && !a.includes('(DENY)'));
  if (explicitAllow.length) targets.push({ path: p, aces: explicitAllow });
  if (list.some(a => a.includes('(DENY)') && !a.includes('(I)'))) denies.push(p);
}
console.log(`검사한 폴더 ${candidates.length}곳 (홈 ${home} 과 그 아래, ${drive} 과 그 아래 한 단계)`);
console.log(`\n정리 대상 — ${GROUP} 명시적 허용 권한 ${targets.length}곳:`);
for (const t of targets) console.log(`  ${t.path}  ${t.aces.join(' ')}`);
console.log(`\n유지 — ${GROUP} 거부(DENY) 권한이 있는 곳: ${denies.join(', ') || '없음'}`);
if (unreadable.length) console.log(`읽지 못한 곳 ${unreadable.length}곳 (권한 없음 등, 바꾸지 않음): ${unreadable.slice(0, 8).join(', ')}${unreadable.length > 8 ? ' …' : ''}`);

// 이전 추적 (대장 지시 2026-10-18): the six engine paths that run the Windows Codex sandbox (and so re-add these grants).
// A path counts as moved only when its file no longer calls the Windows sandbox runner.
const PATHS = [
  ['src/검사도구.js', '검증팀 테스트 실행', 1], ['src/작업도구.js', '작업 도구 테스트·문법 검사', 1], ['src/앱.js', '프로젝트 콘솔 테스트', 1],
  ['src/문서변환.js', 'kordoc 문서 변환', 2], ['src/화면검사.js', '화면 검사(브라우저)', 3], ['src/슬라이드.js', '슬라이드(브라우저)', 3],
];
if (process.argv.includes('--status')) {
  const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
  console.log('\n샌드박스 사용 경로 이전 현황:');
  let still = 0;
  for (const [file, what, stage] of PATHS) {
    const uses = readFileSync(path.join(root, ...file.split('/')), 'utf8').includes('sandbox.run(');
    if (uses) still++;
    console.log(`  ${uses ? '·' : '✓'} ${stage}단계 ${what} (${file}) — ${uses ? 'Windows 샌드박스 사용 중' : '이전됨'}`);
  }
  const backups = path.join(process.env.LOCALAPPDATA ?? home, 'AGENT-HQ', 'acl-backup');
  const last = existsSync(backups) ? readdirSync(backups).sort().at(-1) : null;
  let before = null;
  try { before = last ? JSON.parse(readFileSync(path.join(backups, last, '대상.json'), 'utf8')).targets.length : null; } catch { /* no record */ }
  console.log(`\n권한 대상: 지금 ${targets.length}곳 · 마지막 백업(${last ?? '없음'}) ${before ?? '?'}곳${before !== null && targets.length > before ? ' — 늘어남 (Windows 샌드박스가 다시 붙임)' : ''}`);
  console.log(still ? `정리 조건 미충족: ${still}곳이 아직 Windows 샌드박스를 쓴다 (정리해도 다시 붙음)` : '모든 경로 이전됨 — 정리 절차로 넘어갈 수 있음 (대장 승인 후)');
}

if (process.argv.includes('--backup')) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(process.env.LOCALAPPDATA ?? home, 'AGENT-HQ', 'acl-backup', stamp);
  mkdirSync(dir, { recursive: true });
  const log = [`# Codex 샌드박스 권한 백업 ${new Date().toISOString()}`, `# 사용자 ${os.userInfo().username} · 대상 ${targets.length}곳`];
  const removeLines = ['# 관리자 PowerShell에서, 대장 승인 후. 명시적 허용 권한만 지운다 (거부·상속·사용자·SYSTEM·관리자 권한은 그대로).'];
  const restoreLines = ['# 문제가 생기면 관리자 PowerShell에서 아래를 실행해 백업 시점 권한으로 되돌린다.'];
  targets.forEach((t, i) => {
    const file = path.join(dir, `${String(i + 1).padStart(3, '0')}.acl`);
    const saved = spawnSync('icacls', [t.path, '/save', file], { encoding: 'latin1', windowsHide: true });
    log.push(`${saved.status === 0 ? 'OK ' : 'ERR'} ${t.path} -> ${path.basename(file)} ${t.aces.join(' ')}`);
    removeLines.push(`icacls "${t.path}" /remove:g "${os.hostname()}\\${GROUP}"`);
    restoreLines.push(`icacls "${path.dirname(t.path)}" /restore "${file}"`);
  });
  // The home folder's own ACL (its DENY entries stay; saved for reference).
  spawnSync('icacls', [home, '/save', path.join(dir, 'home.acl')], { windowsHide: true });
  writeFileSync(path.join(dir, '대상.json'), JSON.stringify({ at: new Date().toISOString(), group: GROUP, targets, denies, unreadable }, null, 2));
  writeFileSync(path.join(dir, '백업기록.txt'), log.join('\r\n') + '\r\n');
  writeFileSync(path.join(dir, '정리명령.txt'), removeLines.join('\r\n') + '\r\n\r\n# 정리 뒤: node scripts/코덱스권한-정리준비.mjs 로 목록이 비었는지 확인하고, 경계 시험을 다시 돌린다.\r\n');
  writeFileSync(path.join(dir, '복구명령.txt'), restoreLines.join('\r\n') + '\r\n');
  console.log(`\n백업: ${dir}\n  대상.json · 백업기록.txt · 정리명령.txt(실행 안 함) · 복구명령.txt · NNN.acl`);
}
