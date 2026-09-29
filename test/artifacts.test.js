import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { artifactList, readArtifact } from '../src/artifacts.js';
test('preview confines files, blocks hidden paths, sensitive names, unknown types and oversize files, and shows code as plain text', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-artifacts-'));
  writeFileSync(path.join(cwd, 'index.html'), '<h1>Result</h1>');
  writeFileSync(path.join(cwd, 'secret.json'), '{}');
  writeFileSync(path.join(cwd, 'app.js'), 'code');
  writeFileSync(path.join(cwd, 'tool.exe'), 'bin');
  writeFileSync(path.join(cwd, 'large.txt'), 'x'.repeat(2000001));
  mkdirSync(path.join(cwd, '.private'));
  writeFileSync(path.join(cwd, '.private', 'data.txt'), 'secret');
  assert.equal(readArtifact(cwd, 'index.html').type, 'text/html; charset=utf-8');
  assert.equal(readArtifact(cwd, 'app.js').type, 'text/plain; charset=utf-8', 'code is readable, never served as a script');
  for (const file of ['../outside.txt', '.private/data.txt', 'secret.json', 'tool.exe', 'large.txt', 'C:/secret.txt'])
    assert.throws(() => readArtifact(cwd, file));
  assert.deepEqual(artifactList(cwd).map(a => a.path).sort(), ['app.js', 'index.html']);
});
