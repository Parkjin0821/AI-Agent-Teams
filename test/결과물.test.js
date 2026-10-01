import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { artifactList, readArtifact } from '../src/결과물.js';
test('preview confines files, blocks hidden paths, sensitive names, unknown types and oversize files, and shows code as plain text', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-artifacts-'));
  writeFileSync(path.join(cwd, 'index.html'), '<h1>Result</h1>');
  writeFileSync(path.join(cwd, 'secret.json'), '{}');
  writeFileSync(path.join(cwd, '앱.js'), 'code');
  writeFileSync(path.join(cwd, 'tool.exe'), 'bin');
  writeFileSync(path.join(cwd, 'large.txt'), 'x'.repeat(2000001));
  mkdirSync(path.join(cwd, '.private'));
  writeFileSync(path.join(cwd, '.private', 'data.txt'), 'secret');
  assert.equal(readArtifact(cwd, 'index.html').type, 'text/html; charset=utf-8');
  assert.equal(readArtifact(cwd, '앱.js').type, 'text/plain; charset=utf-8', 'code is readable, never served as a script');
  for (const file of ['../outside.txt', '.private/data.txt', 'secret.json', 'tool.exe', 'large.txt', 'C:/secret.txt'])
    assert.throws(() => readArtifact(cwd, file));
  assert.deepEqual(artifactList(cwd).map(a => a.path).sort(), ['앱.js', 'index.html'].sort());
});

test('an engine-made 한글 document is listed and offered only as a download', async () => {
  const { artifactList, isDownloadOnly } = await import('../src/결과물.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-art-hwpx-'));
  writeFileSync(path.join(cwd, '회의록.hwpx'), 'PK');
  writeFileSync(path.join(cwd, '회의록.hwpx.svg'), '<svg/>');
  const items = artifactList(cwd);
  assert.deepEqual(items.map(i => [i.path, i.type]), [['회의록.hwpx', 'application/vnd.hancom.hwpx'], ['회의록.hwpx.svg', 'image/svg+xml']]);
  assert.deepEqual([isDownloadOnly('회의록.hwpx'), isDownloadOnly('회의록.hwpx.svg'), isDownloadOnly('발표자료/deck.pdf')], [true, false, true]);
});
