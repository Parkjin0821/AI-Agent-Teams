#!/usr/bin/env node
// Codex 격리 실행 성능 측정 (대장 결정 2-7): 큰 프로젝트의 묶기·복사·실행·반환·반영 시간과 디스크 사용량.
//   node scripts/코덱스격리-측정.mjs [작은|중간|큰]   작은·중간·큰 세 가지, 또는 하나만 (임시 폴더에 만들고 끝나면 지움)
// Codex의 샌드박스만 쓰고 모델은 부르지 않는다. 승인된 기준이 있어야 돈다 (실행 전 점검이 통과해야 함).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CodexIsolatedRunner } from '../src/코덱스격리실행.js';
import { linuxProfileArgs, runCommand, wslCommand } from '../src/코덱스격리.js';

const ONLY = process.argv[2] ?? null;
const SIZES = [
  { name: '작은 프로젝트', files: 1_000, bytes: 10 * 1024 },
  { name: '중간 프로젝트', files: 5_000, bytes: 20 * 1024 },
  { name: '큰 프로젝트', files: 15_000, bytes: 12 * 1024 },
];
const MB = n => `${(n / 1024 / 1024).toFixed(1)}MB`;
const root = argv => runCommand(wslCommand({ user: 'root', argv }), { timeoutMs: 120_000 });
const vhdx = () => {
  const dir = path.join(process.env.LOCALAPPDATA ?? '', 'wsl');
  try { return readdirSync(dir).map(d => path.join(dir, d, 'ext4.vhdx')).filter(existsSync).reduce((s, f) => s + statSync(f).size, 0); } catch { return 0; }
};
const usedKb = async () => Number((await root(['sh', '-c', "df -k / | awk 'NR==2{print $3}'"])).output.trim());

// The job's work: read every file, change 1% of them, add 10 new ones.
const WORK = `const fs = require('fs'), path = require('path');
let n = 0, bytes = 0; const all = [];
const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else { bytes += fs.readFileSync(f).length; n++; all.push(f); } } };
walk('src');
for (let i = 0; i < all.length; i += 100) fs.appendFileSync(all[i], 'changed');
fs.mkdirSync('added', { recursive: true }); for (let i = 0; i < 10; i++) fs.writeFileSync('added/' + i + '.txt', 'new');
fs.writeFileSync('measure.json', JSON.stringify({ n, bytes }));`;

const runner = new CodexIsolatedRunner();
const pre = await runner.preflight();
if (!pre.ok) { console.log(`실행 전 점검 실패 — 측정 안 함:\n- ${pre.problems.join('\n- ')}`); process.exit(1); }
console.log(`실행 전 점검 통과. 측정 시작 (${new Date().toISOString()})\n`);
const rows = [];
for (const size of SIZES.filter(s => !ONLY || s.name.startsWith(ONLY))) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hq-measure-'));
  try {
    for (let i = 0; i < size.files; i++) {
      const sub = path.join(dir, 'src', `d${Math.floor(i / 500)}`);
      if (i % 500 === 0) mkdirSync(sub, { recursive: true });
      writeFileSync(path.join(sub, `f${i}.bin`), randomBytes(size.bytes));
    }
    writeFileSync(path.join(dir, 'work.cjs'), WORK);
    const before = { kb: await usedKb(), vhdx: vhdx() };
    let jobKb = null, peakRss = process.memoryUsage().rss;
    const timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
    const r = await runner.runJob({ projectDir: dir, execute: async ({ dir: jobDir, run, distro, user }) => {
      const result = await run(wslCommand({ distro, user, cwd: jobDir, argv: ['codex', 'sandbox', ...linuxProfileArgs('write'), '-P', 'hq', '-C', jobDir, '--', 'node', 'work.cjs'] }), { timeoutMs: 15 * 60_000 });
      jobKb = Number((await root(['du', '-sk', jobDir])).output.split(/\s/)[0]);
      return result;
    } });
    clearInterval(timer);
    const after = { kb: await usedKb(), vhdx: vhdx() };
    const t = r.timings ?? {};
    rows.push({ name: size.name, files: size.files, total: MB(size.files * size.bytes), outcome: r.outcome, ...t,
      sent: MB(r.sentBytes ?? 0), back: MB(r.returnedBytes ?? 0), applied: r.applied?.applied?.length ?? 0, conflicts: r.plan?.conflicts?.length ?? 0,
      jobDisk: jobKb ? MB(jobKb * 1024) : '?', distroAfterJob: `${((after.kb - before.kb) / 1024).toFixed(1)}MB`,
      vhdxGrowth: MB(after.vhdx - before.vhdx), peakRss: MB(peakRss) });
    console.log(JSON.stringify(rows.at(-1)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
console.log('\n| 규모 | 파일 | 용량 | 결과 | 점검 | 묶기 | 복사 | 실행 | 반환 | 반영 | 보낸/받은 묶음 | 반영 수 | 작업 폴더 디스크 | 작업 뒤 배포판 증가 | VHDX 증가 | 엔진 최대 메모리 |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.name} | ${r.files.toLocaleString()} | ${r.total} | ${r.outcome} | ${(r.preflight / 1000).toFixed(1)}초 | ${(r.pack / 1000).toFixed(1)}초 | ${(r.copyIn / 1000).toFixed(1)}초 | ${(r.execute / 1000).toFixed(1)}초 | ${(r.copyOut / 1000).toFixed(1)}초 | ${(r.apply / 1000).toFixed(1)}초 | ${r.sent} / ${r.back} | ${r.applied} | ${r.jobDisk} | ${r.distroAfterJob} | ${r.vhdxGrowth} | ${r.peakRss} |`);
