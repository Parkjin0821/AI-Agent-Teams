import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEAMS, teamPrompt } from '../src/팀.js';

const root = fileURLToPath(new URL('../', import.meta.url));
test('renamed engine imports and entry points resolve', () => {
  for (const dir of ['src', 'scripts', 'test']) {
    for (const name of readdirSync(path.join(root, dir)).filter(n => /\.(?:js|mjs|cjs)$/.test(n))) {
      assert.match(name, /[가-힣]/, name);
      const file = path.join(root, dir, name), text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/^import\s+.*?\s+from\s+['"](\.[^'"]+)['"]/gm))
        assert.ok(existsSync(path.resolve(path.dirname(file), m[1])), `${dir}/${name}: ${m[1]}`);
    }
  }
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node src/서버.js');
  assert.ok(existsSync(path.join(root, 'outputs', '대시보드.html')));
  assert.ok(existsSync(path.join(root, '에이전트-시작.cmd')));
  assert.ok(existsSync(path.join(root, '에이전트-종료.cmd')));
  // .claude/settings.json is this PC's own file and is not in the repository (a fresh clone has none); the guide
  // that tells a new PC how to set the status line is.
  const local = path.join(root, '.claude', 'settings.json');
  if (existsSync(local)) assert.match(readFileSync(local, 'utf8'), /클로드-상태표시\.mjs/);
  // README.md keeps its name: GitHub shows only a README on the repository page (it vanished there after the rename).
  assert.match(readFileSync(path.join(root, 'README.md'), 'utf8'), /scripts\/클로드-상태표시\.mjs/);
});

test('every team gets Korean filename rules with fixed-name and legacy evidence exceptions', () => {
  for (const team of Object.keys(TEAMS)) {
    const prompt = teamPrompt(team, { goal: { objective: '테스트', completionCriteria: [] }, team: {}, files: [] });
    assert.match(prompt, /한글 이름으로 저장/);
    assert.match(prompt, /package\.json/);
    assert.match(prompt, /완료 근거에 연결된 기존 파일/);
    assert.match(prompt, /design\/화면설계\.md/);
    assert.match(prompt, /이전 기준으로 읽어 재사용/);
  }
});
