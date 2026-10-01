import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { documentQuality } from '../src/문서품질.js';
const sha = text => createHash('sha256').update(text).digest('hex');
function fixture(pages = 1, back = '합계 400,000원, 완료율 80%') {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-quality-'));
  for (const [file, content] of Object.entries({ '보고.md': '합계 400,000원, 완료율 80%', '보고.hwpx': 'bytes', '보고.hwpx.md': back, '보고.hwpx.html': '<svg></svg>'.repeat(pages) })) writeFileSync(path.join(cwd, file), content);
  const doc = { path: '보고.hwpx', from: '보고.md', sha: sha('bytes'), validated: true, layout: 'compact', readback: { path: '보고.hwpx.md', sha: sha(back) }, previews: ['보고.hwpx.html'] };
  return { cwd, doc };
}
test('정상 문서와 쉼표 표시 차이는 통과', () => {
  const { cwd, doc } = fixture(1, '합계 400000원, 완료율 80%');
  assert.equal(documentQuality(cwd, { doc }).status, 'pass');
});
test('짧은 원고의 과도한 페이지와 숫자 누락은 사람 검토 요청', () => {
  const { cwd, doc } = fixture(7, '완료율 80%');
  const result = documentQuality(cwd, { doc });
  assert.equal(result.reviewRequired, true);
  assert.match(result.details.join('\n'), /400,000원/);
  assert.match(result.details.join('\n'), /7페이지/);
  assert.equal(documentQuality(cwd, { doc: { ...doc, layout: 'full', readback: { ...doc.readback } } }).reviewRequired, true);
});
test('변경된 문서는 차단하고 작업 폴더 밖 경로는 읽지 않는다', () => {
  const { cwd, doc } = fixture();
  assert.equal(documentQuality(cwd, { doc: { ...doc, sha: 'wrong' } }).status, 'fail');
  assert.equal(documentQuality(cwd, { doc: { ...doc, from: '../outside.md' } }).reviewRequired, true);
});
test('명시한 정식 서식의 여러 페이지는 결함으로 판단하지 않는다', () => {
  const { cwd, doc } = fixture(7);
  assert.equal(documentQuality(cwd, { doc: { ...doc, requestedLayout: 'full' } }).reviewRequired, false);
});
