import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveBins } from '../src/실행어댑터.js';
import { SandboxRunner } from '../src/격리환경.js';
import { DocConverter } from '../src/문서변환.js';
const root = process.cwd();
const cwd = path.join(root, 'outputs', `팀문서-보완검증-${Date.now()}`);
mkdirSync(cwd, { recursive: true });
const maker = new DocConverter({ root, sandbox: new SandboxRunner({ codex: resolveBins().codex, resolve: () => resolveBins().codex }) });
const results = [];
for (const name of ['회의록', '업무보고', '계획서']) {
  const from = `${name}.md`;
  writeFileSync(path.join(cwd, from), readFileSync(path.join(root, 'projects', '문서 품질 비교 시험', from)));
  const doc = await maker.make(cwd, { from, preset: name });
  const html = doc.ok ? readFileSync(path.join(cwd, `${doc.path}.html`), 'utf8') : '';
  const back = doc.readback ? readFileSync(path.join(cwd, doc.readback.path), 'utf8') : '';
  const previous = readFileSync(path.join(root, 'projects', '문서 품질 비교 시험', `${name}.hwpx.md`), 'utf8');
  const tokens = previous.match(/\d[\d,.]*(?:년|월|일|원|건|종|회|%)/g) ?? [];
  const missing = [...new Set(tokens)].filter(token => !back.includes(token));
  const pages = (html.match(/<svg[\s>]/g) ?? []).length;
  results.push({ name, pages, missing, doc });
  console.log(JSON.stringify({ name, pages, missing, ok: doc.ok, validated: doc.validated, preset: doc.preset, lint: doc.lint }));
  if (!doc.ok || !doc.validated || missing.length || (name === '업무보고' && pages > 2)) process.exitCode = 1;
}
writeFileSync(path.join(cwd, '재검증결과.json'), JSON.stringify({ cwd, results }, null, 2));
console.log(cwd);
