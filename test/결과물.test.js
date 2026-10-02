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

test('a slide PDF previews as the page captures of the same build, inline (the frame cannot show the PDF)', async () => {
  const { slidePagesHtml } = await import('../src/결과물.js');
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-slide-preview-'));
  mkdirSync(path.join(cwd, '.hq-screens')); mkdirSync(path.join(cwd, '발표자료'));
  for (const n of ['슬라이드-deck-02.png', '슬라이드-deck-01.png', '슬라이드-other-01.png', '화면-index-390.png']) writeFileSync(path.join(cwd, '.hq-screens', n), 'png');
  const html = slidePagesHtml(cwd, '발표자료/deck.pdf');
  assert.equal((html.match(/<img /g) || []).length, 2, 'only this deck, in page order');
  assert.match(html, /1 \/ 2쪽[\s\S]*2 \/ 2쪽/);
  assert.match(html, /src="data:image\/png;base64,/);
  assert.throws(() => slidePagesHtml(cwd, '../deck.pdf'), /not a slide PDF/);
  assert.throws(() => slidePagesHtml(cwd, '발표자료/none.pdf'), /no page captures/);
});

// 2026-10-02: the filled 13 MB .hwp form was neither listed nor downloadable (only .hwpx was, and only under 2 MB).
test('a filled .hwp is listed and downloaded like .hwpx, and a download may be bigger than a preview', async () => {
  const { artifactList, isDownloadOnly, readArtifact } = await import('../src/결과물.js');
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-art-hwp-'));
  writeFileSync(path.join(cwd, '계획서.hwp'), Buffer.alloc(3_000_000, 1));
  writeFileSync(path.join(cwd, '계획서.hwp.svg'), '<svg/>');
  writeFileSync(path.join(cwd, '큰.html'), 'x'.repeat(3_000_000));
  assert.deepEqual(artifactList(cwd).map(i => [i.path, i.type]), [['계획서.hwp', 'application/x-hwp'], ['계획서.hwp.svg', 'image/svg+xml']]);
  assert.equal(isDownloadOnly('계획서.hwp'), true);
  assert.equal(readArtifact(cwd, '계획서.hwp').bytes.length, 3_000_000);
  assert.throws(() => readArtifact(cwd, '큰.html'), /under 2MB/);
});
