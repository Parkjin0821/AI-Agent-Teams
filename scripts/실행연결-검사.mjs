// 실제 CLI 1회 시험. 격리된 프로젝트 폴더에서 파일 하나만 만들게 하고, 결과는 도구의 말이 아니라
// 이 스크립트가 파일을 직접 읽어 확인한다. 구독 사용량이 조금 쓰인다.
// 사용: node scripts/실행연결-검사.mjs [claude] [codex]
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliAgentAdapter, resolveBins } from '../src/실행어댑터.js';
import { ProjectWorkspaces } from '../src/작업공간.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const providers = process.argv.length > 2 ? process.argv.slice(2) : ['claude', 'codex'];
const workspaces = new ProjectWorkspaces(path.join(root, 'projects'));
const adapter = new CliAgentAdapter({ enabled: true, timeoutMs: 5 * 60_000 });
const bins = resolveBins();
console.log('실행 파일:', JSON.stringify({ claude: bins.claude.file, codex: bins.codex.file }));

for (const provider of providers) {
  const cwd = workspaces.resolve(`cli-smoke-${provider}`);
  rmSync(path.join(cwd, 'hello.txt'), { force: true });
  const expected = `hello from ${provider}`;
  const prompt = [`Create a file named hello.txt in the current working directory whose entire content is exactly: ${expected}`,
    'Do not create or change any other file. Do not run any commands. When finished, reply with the single word DONE.'].join('\n');
  const started = Date.now();
  let outputEvents = 0;
  const result = await adapter.run(provider, prompt, () => { outputEvents++; }, { cwd });
  const file = path.join(cwd, 'hello.txt');
  const content = existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
  console.log(JSON.stringify({
    provider, folder: cwd, outcome: result.outcome, errorKind: result.errorKind ?? null, reportedModel: result.model,
    seconds: Number(((Date.now() - started) / 1000).toFixed(1)), outputEvents,
    verified: content === expected, content, otherFiles: readdirSync(cwd).filter(f => f !== 'hello.txt'),
    error: result.outcome === 'completed' ? null : String(result.summary || '').slice(0, 400),
  }, null, 2));
}
