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

// 양식 채우기 재시험 (2026-10-02): a filled 64-page HWP form is 13 MB, and the check stopped at "안전하게 읽을 수 없어".
test('채운 HWP 양식: 원본은 지문만 대조하고 본문은 엔진 재변환 Markdown 으로 확인한다', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-quality-form-'));
  const hwp = Buffer.alloc(3_000_000, 7), draft = '| 목표 | 불량률 30% 감소 |\n2026년 착수', back = '| 목표 | 불량률 30% 감소 |\n2026년 착수';
  for (const [file, content] of Object.entries({ '계획서.hwp': hwp, '계획서.md': draft, '계획서.hwp.md': back, '계획서.hwp.html': '<svg></svg>'.repeat(64) })) writeFileSync(path.join(cwd, file), content);
  const doc = { kind: 'form', path: '계획서.hwp', from: '계획서.md', sha: sha(hwp), validated: true, readback: { path: '계획서.hwp.md', sha: sha(back) },
    previews: ['계획서.hwp.svg', '계획서.hwp.html'], structure: { same: true, tables: [45, 45], headings: [57, 57], missing: [] } };
  const ok = documentQuality(cwd, { doc });
  assert.equal(ok.status, 'pass', ok.details.join('\n'));
  assert.match(ok.details.join('\n'), /본문은 엔진 재변환\(계획서\.hwp\.md\)으로 확인 · 원본 파일은 지문만 대조 · 미리보기 64페이지 · 수치·날짜 2개 대조 · 양식 구조 같음/);
  // an old preview too big to read costs the page count only
  writeFileSync(path.join(cwd, '계획서.hwp.html'), 'x'.repeat(2_100_000));
  const big = documentQuality(cwd, { doc });
  assert.deepEqual([big.status, big.details.some(d => /안전하게 읽을 수 없어/.test(d))], ['review', false]);
  assert.match(big.details.join('\n'), /계획서\.hwp: 페이지 미리보기 확인 불가/);
  // a form whose structure changed, or a document changed after the engine made it
  assert.match(documentQuality(cwd, { doc: { ...doc, structure: { same: false, tables: [45, 44], headings: [57, 57] } } }).details.join('\n'), /목차·표 구조가 양식과 다름 \(표 45→44/);
  writeFileSync(path.join(cwd, '계획서.hwp'), 'changed');
  assert.equal(documentQuality(cwd, { doc }).status, 'fail');
});
