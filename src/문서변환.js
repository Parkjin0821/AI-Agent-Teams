import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { hasSecret } from './보안감시.js';

// 한글·오피스 문서 → Markdown, by kordoc (MIT, installed by 대장's approval into tools/kordoc, version pinned,
// install scripts and optional parts off). It runs inside the Codex sandbox (network off, writes only in the
// project folder) and never calls a model, so it uses no subscription usage. The teams then read the Markdown.
export const KORDOC_VERSION = '4.16.1';
export const CONVERTIBLE = ['.hwp', '.hwpx', '.docx', '.xlsx'];

export class DocConverter {
  constructor({ root, sandbox, timeoutMs = 120_000 }) {
    this.cli = path.join(root, 'tools', 'kordoc', 'node_modules', 'kordoc', 'dist', 'cli.js');
    Object.assign(this, { sandbox, timeoutMs });
  }
  get available() { return existsSync(this.cli) && Boolean(this.sandbox?.available); }
  status() { return { installed: existsSync(this.cli), sandbox: Boolean(this.sandbox?.available), version: KORDOC_VERSION }; }

  // rel: "attachments/<file>" inside cwd. Writes "attachments/<file>.md" next to it.
  async convert(cwd, rel) {
    if (!CONVERTIBLE.includes(path.extname(rel).toLowerCase())) return { ok: false, error: 'not a convertible document' };
    if (!this.available) return { ok: false, error: existsSync(this.cli) ? 'sandbox unavailable' : 'kordoc not installed' };
    const out = `${rel}.md`;
    const result = await this.sandbox.run(cwd, [process.execPath, this.cli, rel, '-o', out, '--no-images', '--silent'], { timeoutMs: this.timeoutMs });
    const full = path.join(cwd, out);
    if (result.status !== 'pass' || !existsSync(full) || !lstatSync(full).isFile()) {
      return { ok: false, error: result.status === 'timeout' ? 'conversion timed out' : `conversion failed (${result.status})`, output: String(result.output ?? '').slice(-300) };
    }
    const text = readFileSync(full, 'utf8');
    return { ok: true, path: out, size: Buffer.byteLength(text), ...(hasSecret(text) ? { warning: '변환본에 키·토큰으로 보이는 내용이 있습니다 · 팀에게 보내기 전에 확인하세요' } : {}) };
  }

  // 문서 만들기: a team's Markdown → 한글 문서 (HWPX, kordoc generate with an official-document preset), then
  // kordoc's own structure check (validate) and notation check (lint), a Markdown read-back of the made file (so its
  // content can be checked), and SVG + HTML previews. Same sandbox, no network, no model call. PDF/PNG are not made
  // (they need extra packages 대장 has not installed). known: HWPX paths the engine made before (may be replaced).
  async make(cwd, { from, to, preset, layout = 'auto', approval, font }, known = new Set()) {
    if (!this.available) return { ok: false, error: existsSync(this.cli) ? '격리 실행 환경을 쓸 수 없음' : 'kordoc 없음' };
    const rel = p => typeof p === 'string' && p && !path.isAbsolute(p) && !/^[a-zA-Z]:/.test(p) ? path.normalize(p).replace(/\\/g, '/') : null;
    const src = rel(from), out = rel(to ?? (typeof from === 'string' ? from.replace(/\.md$/i, '.hwpx') : null));
    const bad = p => !p || p.startsWith('..') || /^(attachments|sources)\//.test(p) || p.split('/').some(s => s.startsWith('.'));
    if (bad(src) || !src.toLowerCase().endsWith('.md')) return { ok: false, error: '원고는 작업 폴더 안의 .md 파일이어야 함' };
    if (bad(out) || !out.toLowerCase().endsWith('.hwpx')) return { ok: false, error: '결과는 작업 폴더 안의 .hwpx 파일이어야 함' };
    const full = p => path.join(cwd, p);
    if (!existsSync(full(src)) || !lstatSync(full(src)).isFile()) return { ok: false, error: `원고 ${src} 없음` };
    if (lstatSync(full(src)).size > 1_000_000) return { ok: false, error: '원고가 너무 큼 (1MB 초과)' };
    const manuscript = readFileSync(full(src), 'utf8');
    if (hasSecret(manuscript)) return { ok: false, error: '원고에 비밀정보 형식이 있어 만들지 않음' };
    if (!['auto', 'compact', 'full'].includes(layout)) return { ok: false, error: '문서 배치는 auto, compact, full 중 하나여야 함' };
    if (existsSync(full(out)) && !known.has(out)) return { ok: false, error: `${out}이(가) 이미 있음 (엔진이 만든 문서만 다시 만듦)` };
    const requestedPreset = PRESETS.includes(preset) ? preset : '보고서';
    // Explicit engine policy, not a page-count estimate: small briefs need no ministry cover/TOC/chapter pages.
    const compact = requestedPreset === '업무보고' && (layout === 'compact' ||
      (layout === 'auto' && manuscript.length <= 2000 && manuscript.split(/\r?\n/).length <= 80));
    const kind = compact ? '보고서' : requestedPreset;
    const run = args => this.sandbox.run(cwd, [process.execPath, this.cli, ...args], { timeoutMs: this.timeoutMs });
    // A 한글 회의록·보고서 looks official with a 결재란 and a 명조 body (the minutes re-test, 2026-10-01, came out in a
    // web-like 고딕 look). 결재란 labels: 1–4 short words. The designed presets keep their own fonts unless asked.
    const labels = (Array.isArray(approval) ? approval : []).map(a => String(a).trim()).filter(a => /^[가-힣A-Za-z]{1,6}$/.test(a)).slice(0, 4);
    const face = ['myeongjo', 'gothic'].includes(font) ? font : ['업무보고', '서울방침', '보도자료'].includes(kind) ? null : 'myeongjo';
    const made = await run(['generate', src, '-o', out, '--preset', kind, ...(face ? ['--font', face] : []),
      ...(labels.length ? ['--approval', labels.join(',')] : []), '--silent']);
    const diagnostic = (stage, result) => ({ stage, status: result.status, code: result.code ?? null,
      output: hasSecret(String(result.output ?? '')) ? '비밀정보 형식이 있어 오류 출력을 숨김' : String(result.output ?? '').slice(-1000) });
    if (made.status !== 'pass' || !existsSync(full(out))) return { ok: false, error: made.status === 'timeout' ? '만들기 시간 초과' : '문서 만들기 실패', ...diagnostic('generate', made) };
    const valid = await run(['validate', out]);
    if (valid.status !== 'pass') return { ok: false, error: '문서 구조 검증 실패', ...diagnostic('validate', valid) };
    const lint = await run(['lint', src]);
    const lintOut = String(lint.output ?? '');
    const counts = /error\s+(\d+),\s*warning\s+(\d+)/.exec(lintOut);
    const back = await this.convert(cwd, out);
    const svg = await run(['render', out, '-o', `${out}.svg`, '--silent']);
    const html = await run(['render', out, '--format', 'html', '-o', `${out}.html`, '--title', path.basename(out, '.hwpx'), '--silent']);
    const sha = p => createHash('sha256').update(readFileSync(full(p))).digest('hex');
    return { ok: true, from: src, path: out, preset: kind, requestedPreset, requestedLayout: layout, layout: compact ? 'compact' : 'full', font: face, approval: labels, sha: sha(out), validated: valid.status === 'pass',
      lint: counts ? { errors: Number(counts[1]), warnings: Number(counts[2]) } : null,
      readback: back.ok ? { path: back.path, sha: sha(back.path) } : null,
      previews: [`${out}.svg`, `${out}.html`].filter((p, i) => [svg, html][i].status === 'pass' && existsSync(full(p))) };
  }
}

// 양식 채우기 (대장, 2026-10-02: "원래 사업계획서는 이렇게 딱딱 맞게 들어가야 되잖아"): an institution's own form
// (attachments/x.hwp or .hwpx) is filled, not rebuilt. The team edits a copy of the form's Markdown (the engine
// converted it when it was attached) and the engine writes only the edited text back into the original file with
// kordoc patch, which keeps its tables, merged cells, fonts, margins and page setup. Then: a read-back, the
// structure of the result against the form (the same headings in the same order, the same tables), the empty cells
// left, the notation check, and SVG/HTML previews. Same sandbox, no network, no model call.
DocConverter.prototype.fill = async function fill(cwd, { template, from, to }, known = new Set()) {
  if (!this.available) return { ok: false, error: existsSync(this.cli) ? '격리 실행 환경을 쓸 수 없음' : 'kordoc 없음' };
  const rel = p => typeof p === 'string' && p && !path.isAbsolute(p) && !/^[a-zA-Z]:/.test(p) ? path.normalize(p).replace(/\\/g, '/') : null;
  const form = rel(template), src = rel(from);
  const ext = form ? path.extname(form).toLowerCase() : '';
  const out = rel(to ?? (src ? src.replace(/\.md$/i, ext) : null));
  const hidden = p => p.split('/').some(s => s.startsWith('.'));
  if (!form || form.startsWith('..') || hidden(form) || !['.hwp', '.hwpx'].includes(ext)) return { ok: false, error: '양식은 작업 폴더 안의 .hwp 또는 .hwpx 파일이어야 함' };
  const bad = p => !p || p.startsWith('..') || /^(attachments|sources)\//.test(p) || hidden(p);
  if (bad(src) || !src.toLowerCase().endsWith('.md')) return { ok: false, error: '작성본은 작업 폴더 안의 .md 파일이어야 함 (attachments/ 밖)' };
  if (bad(out) || path.extname(out).toLowerCase() !== ext) return { ok: false, error: `결과는 작업 폴더 안의 ${ext} 파일이어야 함 (양식과 같은 형식)` };
  const full = p => path.join(cwd, p);
  for (const [p, l] of [[form, '양식'], [src, '작성본']]) if (!existsSync(full(p)) || !lstatSync(full(p)).isFile()) return { ok: false, error: `${l} ${p} 없음` };
  if (lstatSync(full(src)).size > 3_000_000) return { ok: false, error: '작성본이 너무 큼 (3MB 초과)' };
  const draft = readFileSync(full(src), 'utf8');
  if (hasSecret(draft)) return { ok: false, error: '작성본에 비밀정보 형식이 있어 넣지 않음' };
  if (existsSync(full(out)) && !known.has(out)) return { ok: false, error: `${out}이(가) 이미 있음 (엔진이 만든 문서만 다시 만듦)` };
  // The form's own Markdown: the one made at attachment time, or made now.
  let skeletonPath = `${form}.md`;
  if (!existsSync(full(skeletonPath))) { const c = await this.convert(cwd, form); if (!c.ok) return { ok: false, error: `양식을 읽지 못함: ${c.error}` }; skeletonPath = c.path; }
  const run = args => this.sandbox.run(cwd, [process.execPath, this.cli, ...args], { timeoutMs: this.timeoutMs });
  // Not --silent: kordoc names each edit it skipped ("⚠️ SKIP: 블록 추가는 미지원 (v1)", "… | <the form's text>"), and
  // the team can only repair what it is told (양식 채우기 시험, 2026-10-02: 19 skips, the error said only "일부").
  // kordoc writes its -o file even when it exits 2 (some edits skipped). Written straight to the target, that file had
  // no engine record, so the team's corrected retry was refused as "이미 있음" (양식 채우기 시험, 2026-10-02). The patch
  // goes to a temporary name next to it and becomes the target only once it passed; a failed one is removed.
  const tmp = path.posix.join(path.posix.dirname(out), `.hq-tmp-${randomUUID()}${ext}`);
  const drop = () => rmSync(full(tmp), { force: true });
  const patched = await run(['patch', form, src, '-o', tmp]);
  const secret = hasSecret(String(patched.output ?? ''));
  const output = secret ? '비밀정보 형식이 있어 오류 출력을 숨김' : String(patched.output ?? '').replaceAll(tmp, out).slice(-1000);
  // kordoc exits 2 when some edits could not be placed in the form: that text would be silently lost, so it fails.
  if (patched.status !== 'pass' || !existsSync(full(tmp))) {
    drop();
    const skipped = secret ? [] : patchSkips(patched.output);
    const where = skipped.length ? ` · 건너뛴 곳 ${skipped.length}개: ${skipped.slice(0, 6).join(' / ')}${skipped.length > 6 ? ' / …' : ''}` : '';
    return { ok: false, error: patched.code === 2 ? `작성본의 일부 수정이 양식에 들어가지 않음 (표·목차 구조를 바꾼 곳을 확인)${where}` : patched.status === 'timeout' ? '양식 채우기 시간 초과' : '양식 채우기 실패',
      stage: 'patch', status: patched.status, code: patched.code ?? null, output, skipped };
  }
  const valid = ext === '.hwpx' ? await run(['validate', tmp]) : { status: 'pass' };
  if (valid.status !== 'pass') { drop(); return { ok: false, error: '문서 구조 검증 실패', stage: 'validate', status: valid.status, code: valid.code ?? null, output: String(valid.output ?? '').slice(-1000) }; }
  try { renameSync(full(tmp), full(out)); } catch (error) { drop(); return { ok: false, error: `채운 문서를 ${out}(으)로 옮기지 못함 (열려 있으면 닫기)`, stage: 'rename', output: String(error.code ?? '') }; }
  const back = await this.convert(cwd, out);
  // A document the engine cannot read back gets no record, so it is not left behind to block the next try either.
  if (!back.ok) { rmSync(full(out), { force: true }); return { ok: false, error: '채운 문서를 다시 읽지 못함', stage: 'readback' }; }
  const before = formShape(readFileSync(full(skeletonPath), 'utf8')), after = formShape(readFileSync(full(back.path), 'utf8'));
  const missing = before.headings.filter(h => !after.headings.includes(h)).slice(0, 10);
  const structure = { same: before.tables === after.tables && missing.length === 0 && before.headings.length === after.headings.length,
    tables: [before.tables, after.tables], headings: [before.headings.length, after.headings.length], missing };
  const lint = await run(['lint', src]);
  const counts = /error\s+(\d+),\s*warning\s+(\d+)/.exec(String(lint.output ?? ''));
  // kordoc stacks every page into one SVG only for HWPX; an HWP of several pages needs one file per page and made no
  // preview at all (양식 채우기 시험, 2026-10-02: 64 pages, "--out-dir 이 필요합니다"), so an HWP previews its first page.
  const svg = await run(['render', out, ...(ext === '.hwp' ? ['--pages', '1'] : []), '-o', `${out}.svg`, '--silent']);
  const html = await run(['render', out, '--format', 'html', '-o', `${out}.html`, '--title', path.basename(out, ext), '--silent']);
  const sha = p => createHash('sha256').update(readFileSync(full(p))).digest('hex');
  return { ok: true, kind: 'form', template: form, from: src, path: out, preset: '양식', sha: sha(out), validated: true, structure,
    empties: [before.empties, after.empties], lint: counts ? { errors: Number(counts[1]), warnings: Number(counts[2]) } : null,
    readback: { path: back.path, sha: sha(back.path) },
    previews: [`${out}.svg`, `${out}.html`].filter((p, i) => [svg, html][i].status === 'pass' && existsSync(full(p))) };
};

// The edits kordoc patch could not place, one short line each ("블록 추가는 미지원 (v1)", "표 캡션 수정은 미지원 (v1) |
// [표. …]"), the same reason and text only once.
export function patchSkips(output) {
  const lines = String(output ?? '').split(/\r?\n/).map(l => /SKIP:\s*(.+)$/.exec(l)?.[1]?.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return [...new Set(lines.map(l => (l.length > 90 ? `${l.slice(0, 90)}…` : l)))];
}

// The parts of a form that filling must keep: its headings in order (목차·번호 줄), its tables, and how many cells are
// still empty. Read from kordoc's Markdown of the form and of the filled document.
// (Sub-items such as "(1) 산업의 특성" are usually the writer's own and may change; the form's levels are kept.)
const HEADING = /^(#{1,6}\s+\S.*|\d{1,2}\.\s+\S.*|[가-하]\.\s+\S.*|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\.?\s+\S.*)$/;
export function formShape(md) {
  const lines = String(md).split(/\r?\n/).map(l => l.trim());
  const headings = lines.filter(l => HEADING.test(l) && l.length <= 80).map(l => l.replace(/^#+\s+/, ''));
  const tables = (String(md).match(/<table/g) ?? []).length + lines.filter(l => /^\|(\s*:?-{3,}:?\s*\|)+$/.test(l)).length;
  const empties = (String(md).match(/<td[^>]*>\s*<\/td>/g) ?? []).length
    + lines.filter(l => l.startsWith('|') && !/^\|(\s*:?-{3,}:?\s*\|)+$/.test(l)).reduce((n, l) => n + (l.split('|').slice(1, -1).filter(c => !c.trim()).length), 0);
  return { headings, tables, empties };
}

// kordoc generate presets (official Korean document forms).
export const PRESETS = ['기안문', '보고서', '계획서', '통지', '회의록', '개조식', '업무보고', '서울방침', '보도자료'];
