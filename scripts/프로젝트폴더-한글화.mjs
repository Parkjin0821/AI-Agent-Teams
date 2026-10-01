import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, lstatSync, realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ProjectWorkspaces, validateProjectId } from '../src/작업공간.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projects = realpathSync(path.join(root, 'projects'));
if (projects !== path.join(root, 'projects') || lstatSync(path.join(root, 'projects')).isSymbolicLink()) throw new Error('Linked projects root refused');
const titles = new Map(), goals = [];
for (const rel of ['data/real-test/hq.sqlite', 'data/hq.sqlite']) {
  if (!existsSync(path.join(root, rel))) continue;
  const db = new DatabaseSync(path.join(root, rel), { readOnly: true });
  try { goals.push(...db.prepare('SELECT body FROM goals').all().map(r => JSON.parse(r.body))); }
  finally { db.close(); }
}
if (goals.some(g => g.status === 'running')) throw new Error('실행 중인 팀 작업이 있어 폴더 이관을 하지 않음');
for (const goal of goals.filter(g => !g.parentGoalId)) if (!titles.has(goal.projectId))
  titles.set(goal.projectId, goal.title || goal.objective?.slice(0, 60));
titles.set('cli-smoke-claude', '클로드 실행연결 시험');
titles.set('cli-smoke-codex', '코덱스 실행연결 시험');
const workspaces = new ProjectWorkspaces(projects, { titleFor: id => titles.get(id) || '기록 없는 프로젝트' });
const mapped = new Set(Object.values(workspaces.readMap()));
const plan = readdirSync(projects, { withFileTypes: true }).filter(e => e.isDirectory() && !mapped.has(e.name)).map(e => {
  const id = validateProjectId(e.name), from = path.join(projects, e.name);
  if (lstatSync(from).isSymbolicLink() || path.dirname(realpathSync(from)) !== projects) throw new Error('Unsafe source folder');
  return { id, from, title: titles.get(id) || '기록 없는 프로젝트' };
});
console.log(JSON.stringify(plan.map(p => ({ id: p.id, title: p.title })), null, 2));
if (!process.argv.includes('--apply')) process.exit(0);
try {
  const response = await fetch('http://127.0.0.1:4314/api/engine', { signal: AbortSignal.timeout(1000) });
  if (response.ok) throw new Error('SERVER_RUNNING');
} catch (error) { if (error.message === 'SERVER_RUNNING') throw new Error('서버를 먼저 종료한 뒤 폴더를 이관해야 함'); }

const fingerprint = dir => {
  const files = [];
  const visit = (folder, prefix = '') => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name), rel = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error('Linked project contents refused');
      if (entry.isDirectory()) visit(full, rel + '/');
      else if (entry.isFile()) files.push([rel, createHash('sha256').update(readFileSync(full)).digest('hex')]);
    }
  };
  visit(dir);
  return { count: files.length, sha: createHash('sha256').update(JSON.stringify(files.sort((a,b) => a[0].localeCompare(b[0])))).digest('hex') };
};
const audit = path.join(root, 'data', '프로젝트폴더-변경기록');
mkdirSync(audit, { recursive: true });
const log = path.join(audit, new Date().toISOString().replace(/[:.]/g, '-') + '.json');
const records = plan.map(p => ({ ...p, before: fingerprint(p.from) }));
writeFileSync(log, JSON.stringify(records, null, 2), { flag: 'wx' });
for (const record of records) {
  record.to = workspaces.resolve(record.id);
  record.after = fingerprint(record.to);
  if (record.before.sha !== record.after.sha || record.before.count !== record.after.count) throw new Error('Project contents changed during migration');
  writeFileSync(log, JSON.stringify(records, null, 2));
  console.log(`${path.basename(record.from)} → ${path.basename(record.to)} · ${record.after.count}개 파일 무변경 확인`);
}
console.log(`변경 기록: ${log}`);
