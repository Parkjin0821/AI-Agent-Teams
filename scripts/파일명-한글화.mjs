// Engine-owned filenames only. Project evidence, uploaded originals and vendor files remain untouched.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, copyFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = {
  adapters:'실행어댑터', app:'앱', approvals:'승인', artifacts:'결과물', assignment:'작업배정', attachments:'첨부파일',
  'auto-save':'자동저장', checks:'검사', digest:'요약', 'doc-convert':'문서변환', domain:'업무도메인',
  environments:'연결환경', evidence:'완료근거', 'goal-runner':'목표실행', memory:'기억',
  'model-changes':'모델변경', 'model-choices':'모델선택', 'model-evals':'모델평가', 'model-levels':'모델수준',
  'model-policy':'모델정책', models:'모델', orchestrator:'작업조율', 'persistent-store':'영구저장소', policy:'정책',
  records:'작업기록', report:'완료보고서', routines:'반복작업', rules:'규칙', sandbox:'격리환경', scheduler:'작업스케줄러',
  sentinel:'보안감시', server:'서버', skills:'스킬', store:'저장소', 'subscription-safety':'구독안전',
  'team-governance':'팀검토', teams:'팀', templates:'템플릿', toolkit:'검사도구', usage:'사용량',
  'visual-check':'화면검사', 'web-sources':'웹원문', workspaces:'작업공간',
  'agent-hq':'에이전트-관리', 'claude-statusline':'클로드-상태표시', 'cli-smoke':'실행연결-검사', 'sentinel-hook':'보안감시-훅',
  autonomy:'자율실행', 'doc-make':'문서만들기', inbox:'승인함', parallel:'병렬작업', 'regression-gaps':'회귀-검사',
  runtime:'실행환경', 'safety-gaps':'안전경계', 'scheduler-models':'스케줄러-모델', 'scheduler-pause':'스케줄러-일시정지',
  'scheduler-run-now':'스케줄러-즉시실행', 'scheduler-task':'스케줄러-작업', 'scheduler-team':'스케줄러-팀',
  HANDOFF:'인수인계', 'TEAM-EVOLUTION':'팀-개선', 'TEAM-PROMPTS':'팀-지침', architecture:'구조안내',
  'usage-monitoring':'사용량-모니터링', validation:'검증기록', 'agent-hq-screen-design':'에이전트-화면설계',
  connections:'연결', home:'홈', projects:'프로젝트목록', project:'프로젝트', 'project-activity':'프로젝트-활동',
  dashboard:'대시보드', 'dashboard-preview':'대시보드-미리보기', index:'시작화면', README:'사용안내',
  'start-agent-hq':'에이전트-시작', 'stop-agent-hq':'에이전트-종료',
};
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
const moves = files.filter(f => /^(src|scripts|test|docs|outputs|public)\//.test(f) || /^(사용안내\.md|(?:start|stop)-agent-hq\.cmd)$/.test(f))
  .map(from => {
    const b = path.posix.basename(from), match = /^(.*?)(\.test\.js|\.[^.]+)$/.exec(b);
    return match && names[match[1]] ? { from, to: path.posix.join(path.posix.dirname(from), names[match[1]] + match[2]), old: b, name: names[match[1]] + match[2] } : null;
  }).filter(Boolean);
const safe = rel => {
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new Error('Path outside project');
  for (let p = full; p !== root; p = path.dirname(p)) if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('Linked path refused');
  return full;
};
for (const m of moves) if (existsSync(safe(m.to))) throw new Error(`Destination exists: ${m.to}`);
const unique = [...new Map(moves.map(m => [m.old, m.name])).entries()].sort((a,b) => b[0].length-a[0].length);
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const edits = [];
for (const rel of files) {
  if (!/\.(js|mjs|cjs|json|md|html|cmd)$/.test(rel) || !existsSync(safe(rel))) continue;
  const original = readFileSync(safe(rel), 'utf8');
  let content = original;
  for (const [old, name] of unique) {
    // index.html inside sample/test project contracts is not the engine's public entry page.
    if (old === 'index.html') { content = content.replaceAll('public/index.html', 'public/시작화면.html'); continue; }
    content = content.replace(new RegExp(`(?<![a-zA-Z0-9_-])${escape(old)}(?![a-zA-Z0-9_-])`, 'g'), name);
  }
  if (content !== original) edits.push({ rel, content });
}
console.log(JSON.stringify({ renamed: moves.length, references: edits.length, moves }, null, 2));
if (!process.argv.includes('--apply')) process.exit(0);
const backup = path.join(root, 'data', '파일명변경-백업', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(backup, { recursive: true });
for (const rel of new Set([...moves.map(m => m.from), ...edits.map(e => e.rel)])) {
  const target = path.join(backup, `${rel}.bak`); mkdirSync(path.dirname(target), { recursive: true }); copyFileSync(safe(rel), target);
}
writeFileSync(path.join(backup, '변경목록.json'), JSON.stringify(moves, null, 2));
for (const e of edits) writeFileSync(safe(e.rel), e.content, 'utf8');
for (const m of moves) renameSync(safe(m.from), safe(m.to));
console.log(`백업: ${backup}`);
