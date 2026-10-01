import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync, lstatSync } from 'node:fs';
import path from 'node:path';

// Engine findings, not an aesthetic score. A long document is not automatically a defect.
export function documentQuality(cwd, documents = {}) {
  const root = realpathSync(cwd);
  const read = rel => {
    if (typeof rel !== 'string' || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error('unsafe path');
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep)) throw new Error('outside workspace');
    let cursor = root;
    for (const part of path.relative(root, full).split(path.sep)) {
      cursor = path.join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('linked path');
    }
    if (!realpathSync(full).startsWith(root + path.sep) || !statSync(full).isFile() || statSync(full).size > 2_000_000) throw new Error('unreadable artifact');
    return readFileSync(full);
  };
  const details = [], blocking = [], warnings = [];
  if (Object.keys(documents).length > 30) warnings.push('문서 30종 초과 · 나머지 문서 품질 검사 미실시');
  for (const doc of Object.values(documents).slice(0, 30)) {
    try {
      const sha = bytes => createHash('sha256').update(bytes).digest('hex');
      if (sha(read(doc.path)) !== doc.sha || !doc.validated) {
        blocking.push(`${doc.path}: 생성 후 변경됐거나 구조 검증 근거 없음`); continue;
      }
      if (!doc.readback || sha(read(doc.readback.path)) !== doc.readback.sha) {
        warnings.push(`${doc.path}: 재변환 내용 대조를 확인할 수 없음`); continue;
      }
      const source = read(doc.from).toString('utf8'), back = read(doc.readback.path).toString('utf8');
      const normalize = value => value.replace(/,/g, '');
      const tokens = [...new Set(source.match(/\d[\d,.]*(?:년|월|일|원|건|종|회|%)/g) ?? [])];
      const missing = tokens.filter(token => !normalize(back).includes(normalize(token)));
      if (missing.length) warnings.push(`${doc.path}: 수치·날짜 대조 필요 (${missing.slice(0, 8).join(', ')})`);
      const htmlPath = (doc.previews ?? []).find(file => file.endsWith('.html'));
      const html = htmlPath ? read(htmlPath).toString('utf8') : '';
      const pages = (html.match(/<svg[\s>]/g) ?? []).length;
      if (!pages) warnings.push(`${doc.path}: 페이지 미리보기 확인 불가`);
      else if (source.length <= 2000 && source.split(/\r?\n/).length <= 80 && pages > 2 && doc.requestedLayout !== 'full')
        warnings.push(`${doc.path}: 짧은 원고가 ${pages}페이지로 분리됨 · 여백·페이지 나눔 검토 필요`);
      details.push(`${doc.path}: 미리보기 ${pages}페이지 · 수치·날짜 ${tokens.length}개 대조 · 가독성은 별도 검토`);
    } catch {
      warnings.push(`${doc?.path ?? '문서'}: 안전하게 읽을 수 없어 품질 검사 미실시`);
    }
  }
  return { id: 'document-quality', name: '문서 품질 검사', status: blocking.length ? 'fail' : warnings.length ? 'review' : 'pass',
    summary: `문서 ${Math.min(Object.keys(documents).length, 30)}종 · 구조 근거·수치·페이지 검사 (미적 품질 판정 아님)`,
    details: [...warnings, ...details], blocking, reviewRequired: warnings.length > 0 };
}
