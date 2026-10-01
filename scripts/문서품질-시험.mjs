import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolveBins } from '../src/실행어댑터.js';
import { SandboxRunner } from '../src/격리환경.js';
import { DocConverter } from '../src/문서변환.js';

const root = process.cwd();
const cwd = path.join(root, 'outputs', `문서시험-${Date.now()}`);
mkdirSync(cwd, { recursive: true });
const sandbox = new SandboxRunner({ codex: resolveBins().codex, resolve: () => resolveBins().codex });
const maker = new DocConverter({ root, sandbox });
const cases = [
  { name: '회의록', expected: ['기획팀', '개발팀', '기록팀', '2026년 10월 5일', '2026년 10월 6일', '1회'] },
  { name: '업무보고', expected: ['120,000', '230,000', '50,000', '400,000', '80%', '2건'] },
  { name: '계획서', expected: ['2026년 10월 1일', '2026년 10월 2일', '2026년 10월 5일', '기준 원고 3종', 'HTML', 'SVG'] },
];
const results = [];
for (const item of cases) {
  const from = `${item.name}-기준원고.md`;
  writeFileSync(path.join(cwd, from), readFileSync(path.join(root, 'docs', '문서시험', from)));
  const doc = await maker.make(cwd, { from, preset: item.name });
  const text = doc.readback ? readFileSync(path.join(cwd, doc.readback.path), 'utf8') : '';
  const missing = item.expected.filter(value => !text.includes(value));
  const previews = doc.previews ?? [];
  const passed = doc.ok && doc.validated && missing.length === 0 && previews.length === 2 && previews.every(file => existsSync(path.join(cwd, file)));
  results.push({ name: item.name, passed, missing, doc });
  console.log(JSON.stringify({ name: item.name, passed, missing, validated: doc.validated, lint: doc.lint, error: doc.error }));
}
const report = { scope: '실제 문서 변환 엔진 시험. 팀 자율 실행 및 시각 품질 평가는 별도.', cwd, results };
writeFileSync(path.join(cwd, '시험결과.json'), JSON.stringify(report, null, 2));
console.log(cwd);
if (results.some(item => !item.passed)) process.exitCode = 1;
