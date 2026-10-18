#!/usr/bin/env node
// 공개 전 검사 (대장 결정 3, 2026-10-18): push 하기 전에 올라갈 이력 전체를, 또는 이미 공개된 이력 전체를 비밀정보·개인정보
// 패턴(엔진의 검사.js inspectExport)과 금지 파일 이름으로 검사한다. 값은 출력하지 않는다 — 종류·파일·커밋만.
//   node scripts/공개전-검사.mjs                 origin/main..HEAD 의 모든 커밋이 들인 파일 내용 (중간에 넣었다 지운 것도)
//   node scripts/공개전-검사.mjs --history       저장소의 모든 커밋에 있었던 모든 파일 내용 (이미 공개된 이력 점검)
//   node scripts/공개전-검사.mjs --range A..B   지정한 범위 (CI: 끌어오기 요청·push 가 들이는 커밋)
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectExport } from '../src/검사.js';

const ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const gitBuf = (...a) => spawnSync('git', a, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 }).stdout;

// Names that must never be published, whatever their content.
const FORBIDDEN = [
  [/(^|\/)\.env(\.[^/]*)?$/, '.env 파일', p => !/\.(example|sample|template)$/.test(p)],
  [/(^|\/)(id_(rsa|dsa|ecdsa|ed25519)(_sk)?|agent-hq-approval)$/, '개인 키로 보이는 파일'],
  [/\.(pem|key|p12|pfx|keystore)$/i, '키·인증서 파일'],
  [/(^|\/)auth\.json$/, '로그인 정보 파일 (auth.json)'],
  [/(^|\/)(\.npmrc|\.netrc|\.git-credentials)$/, '인증 설정 파일'],
  [/\.(sqlite|sqlite3|db)$/i, '데이터베이스 파일'],
  [/(^|\/)data\//, '엔진 데이터 폴더 (data/)'],
  [/sentinel.*\.jsonl$/, '감시 기록'],
];

const at = process.argv.indexOf('--range');
// This machine's own identifiers (the Windows user name and the PC name) must not reach a public repository either.
// Short or generic names are skipped so the check does not fire on ordinary words. The values are never printed.
const LOCAL_IDS = [os.userInfo().username, os.hostname()].filter(v => v && v.length >= 4 && !/^(user|admin|runner|root)$/i.test(v)).map(v => v.toLowerCase());

const range = process.argv.includes('--history') ? ['--all'] : [at > 0 ? process.argv[at + 1] : 'origin/main..HEAD'];
if (!/^(--all|[0-9A-Za-z_./^~-]+..[0-9A-Za-z_./^~-]+)$/.test(range[0])) { console.log(`범위가 이상하다: ${range[0]}`); process.exit(2); }
const commits = git('rev-list', ...range).stdout.split(/\s+/).filter(Boolean);
const seen = new Set(), findings = [], names = [];
let blobs = 0;
for (const c of commits) {
  // Every blob this commit added or changed (first commit included), with its path.
  const out = git('diff-tree', '-r', '--root', '--no-commit-id', '--no-renames', '-z', c).stdout.split('\0');
  for (let i = 0; i + 1 < out.length; i += 2) {
    const meta = out[i].trim().split(/\s+/), file = out[i + 1];
    const blob = meta[3], status = meta[4];
    if (!file || status === 'D' || !/^[0-9a-f]{40}$/.test(blob ?? '')) continue;
    for (const [re, kind, extra] of FORBIDDEN) if (re.test(file) && (!extra || extra(file))) names.push({ commit: c.slice(0, 8), file, kind });
    if (seen.has(blob)) continue;
    seen.add(blob);
    const data = gitBuf('cat-file', 'blob', blob);
    if (!data || data.length > 2_000_000 || data.includes(0)) continue;   // binary or very large: names only
    blobs++;
    const text = data.toString('utf8');
    for (const f of inspectExport([{ path: file, content: text }])) findings.push({ commit: c.slice(0, 8), ...f });
    if (LOCAL_IDS.some(id => text.toLowerCase().includes(id))) findings.push({ commit: c.slice(0, 8), file, kind: '이 PC의 사용자 이름·PC 이름' });
  }
}
const strong = findings.filter(f => !/휴대전화번호|이메일/.test(f.kind));
const weak = findings.filter(f => /휴대전화번호|이메일/.test(f.kind));
console.log(`범위: ${range.join(' ')} · 커밋 ${commits.length}개 · 검사한 파일 내용 ${blobs}개`);
console.log(`\n금지 파일 이름: ${names.length ? '' : '없음'}`);
for (const n of names.slice(0, 50)) console.log(`  ✗ ${n.commit} ${n.file} — ${n.kind}`);
console.log(`\n비밀정보·강한 개인정보 패턴: ${strong.length ? '' : '없음'}`);
for (const f of strong.slice(0, 50)) console.log(`  ✗ ${f.commit} ${f.file} — ${f.kind}`);
console.log(`\n약한 개인정보 패턴(전화번호·이메일 형식, 사람이 확인): ${weak.length ? '' : '없음'}`);
for (const f of weak.slice(0, 50)) console.log(`  ? ${f.commit} ${f.file} — ${f.kind}`);
process.exit(names.length || strong.length ? 1 : 0);
