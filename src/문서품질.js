import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, lstatSync } from 'node:fs';
import path from 'node:path';

// Engine findings, not an aesthetic score. A long document is not automatically a defect.
// The 한글 file itself (.hwp/.hwpx) is never parsed here: its fingerprint is compared with the engine's record, and its
// content is read from the engine's own read-back Markdown (x.hwp.md). A filled 64-page form is 13 MB, over the text
// limit, and the whole check was skipped as "안전하게 읽을 수 없음" (양식 채우기 재시험, 2026-10-02).
const TEXT_LIMIT = 2_000_000, DOCUMENT_LIMIT = 200_000_000;
export function documentQuality(cwd, documents = {}) {
  const root = realpathSync(cwd);
  const read = (rel, limit = TEXT_LIMIT) => {
    if (typeof rel !== 'string' || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error('unsafe path');
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep)) throw new Error('outside workspace');
    let cursor = root;
    for (const part of path.relative(root, full).split(path.sep)) {
      cursor = path.join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('linked path');
    }
    if (!realpathSync(full).startsWith(root + path.sep) || !statSync(full).isFile() || statSync(full).size > limit) throw new Error('unreadable artifact');
    return readFileSync(full);
  };
  const details = [], blocking = [], warnings = [];
  if (Object.keys(documents).length > 30) warnings.push('문서 30종 초과 · 나머지 문서 품질 검사 미실시');
  for (const doc of Object.values(documents).slice(0, 30)) {
    try {
      const sha = bytes => createHash('sha256').update(bytes).digest('hex');
      if (sha(read(doc.path, DOCUMENT_LIMIT)) !== doc.sha || !doc.validated) {
        blocking.push(`${doc.path}: 생성 후 변경됐거나 구조 검증 근거 없음`); continue;
      }
      if (!doc.readback || sha(read(doc.readback.path)) !== doc.readback.sha) {
        warnings.push(`${doc.path}: 재변환 내용 대조를 확인할 수 없음`); continue;
      }
      const form = doc.kind === 'form';
      const source = read(doc.from).toString('utf8'), back = read(doc.readback.path).toString('utf8');
      const normalize = value => value.replace(/,/g, '');
      const tokens = [...new Set(source.match(/\d[\d,.]*(?:년|월|일|원|건|종|회|%)/g) ?? [])];
      const missing = tokens.filter(token => !normalize(back).includes(normalize(token)));
      if (missing.length) warnings.push(`${doc.path}: 수치·날짜 대조 필요 (${missing.slice(0, 8).join(', ')})`);
      if (form && doc.structure && !doc.structure.same) warnings.push(`${doc.path}: 목차·표 구조가 양식과 다름 (표 ${doc.structure.tables?.join('→')}, 제목 ${doc.structure.headings?.join('→')})`);
      // A preview the engine could not keep small (or an old oversized one) costs the page count only, not the check.
      const htmlPath = (doc.previews ?? []).find(file => file.endsWith('.html'));
      let html = '';
      try { html = htmlPath ? read(htmlPath).toString('utf8') : ''; } catch { /* counted as no preview below */ }
      const pages = (html.match(/<svg[\s>]/g) ?? []).length;
      if (!pages) warnings.push(`${doc.path}: 페이지 미리보기 확인 불가${doc.previewNote ? ` (${doc.previewNote})` : ''}`);
      else if (!form && source.length <= 2000 && source.split(/\r?\n/).length <= 80 && pages > 2 && doc.requestedLayout !== 'full')
        warnings.push(`${doc.path}: 짧은 원고가 ${pages}페이지로 분리됨 · 여백·페이지 나눔 검토 필요`);
      const how = `본문은 엔진 재변환(${doc.readback.path})으로 확인 · 원본 파일은 지문만 대조`;
      details.push(`${doc.path}: ${how} · 미리보기 ${pages}페이지${doc.previewNote ? ` (${doc.previewNote})` : ''} · 수치·날짜 ${tokens.length}개 대조${
        form && doc.structure ? ` · 양식 구조 ${doc.structure.same ? '같음' : '다름'} (표 ${doc.structure.tables?.[1] ?? '?'}개)` : ''} · 가독성은 별도 검토`);
    } catch {
      warnings.push(`${doc?.path ?? '문서'}: 안전하게 읽을 수 없어 품질 검사 미실시`);
    }
  }
  return { id: 'document-quality', name: '문서 품질 검사', status: blocking.length ? 'fail' : warnings.length ? 'review' : 'pass',
    summary: `문서 ${Math.min(Object.keys(documents).length, 30)}종 · 구조 근거·수치·페이지 검사 (한글 파일은 엔진 재변환 Markdown 으로, 미적 품질 판정 아님)`,
    details: [...warnings, ...details], blocking, reviewRequired: warnings.length > 0 };
}
