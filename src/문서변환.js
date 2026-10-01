import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
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
  async make(cwd, { from, to, preset }, known = new Set()) {
    if (!this.available) return { ok: false, error: existsSync(this.cli) ? '격리 실행 환경을 쓸 수 없음' : 'kordoc 없음' };
    const rel = p => typeof p === 'string' && p && !path.isAbsolute(p) && !/^[a-zA-Z]:/.test(p) ? path.normalize(p).replace(/\\/g, '/') : null;
    const src = rel(from), out = rel(to ?? (typeof from === 'string' ? from.replace(/\.md$/i, '.hwpx') : null));
    const bad = p => !p || p.startsWith('..') || /^(attachments|sources)\//.test(p) || p.split('/').some(s => s.startsWith('.'));
    if (bad(src) || !src.toLowerCase().endsWith('.md')) return { ok: false, error: '원고는 작업 폴더 안의 .md 파일이어야 함' };
    if (bad(out) || !out.toLowerCase().endsWith('.hwpx')) return { ok: false, error: '결과는 작업 폴더 안의 .hwpx 파일이어야 함' };
    const full = p => path.join(cwd, p);
    if (!existsSync(full(src)) || !lstatSync(full(src)).isFile()) return { ok: false, error: `원고 ${src} 없음` };
    if (lstatSync(full(src)).size > 1_000_000) return { ok: false, error: '원고가 너무 큼 (1MB 초과)' };
    if (hasSecret(readFileSync(full(src), 'utf8'))) return { ok: false, error: '원고에 비밀정보 형식이 있어 만들지 않음' };
    if (existsSync(full(out)) && !known.has(out)) return { ok: false, error: `${out}이(가) 이미 있음 (엔진이 만든 문서만 다시 만듦)` };
    const kind = PRESETS.includes(preset) ? preset : '보고서';
    const run = args => this.sandbox.run(cwd, [process.execPath, this.cli, ...args], { timeoutMs: this.timeoutMs });
    const made = await run(['generate', src, '-o', out, '--preset', kind, '--silent']);
    if (made.status !== 'pass' || !existsSync(full(out))) return { ok: false, error: made.status === 'timeout' ? '만들기 시간 초과' : '문서 만들기 실패', output: String(made.output ?? '').slice(-300) };
    const valid = await run(['validate', out]);
    const lint = await run(['lint', src]);
    const lintOut = String(lint.output ?? '');
    const counts = /error\s+(\d+),\s*warning\s+(\d+)/.exec(lintOut);
    const back = await this.convert(cwd, out);
    const svg = await run(['render', out, '-o', `${out}.svg`, '--silent']);
    const html = await run(['render', out, '--format', 'html', '-o', `${out}.html`, '--title', path.basename(out, '.hwpx'), '--silent']);
    const sha = p => createHash('sha256').update(readFileSync(full(p))).digest('hex');
    return { ok: true, from: src, path: out, preset: kind, sha: sha(out), validated: valid.status === 'pass',
      lint: counts ? { errors: Number(counts[1]), warnings: Number(counts[2]) } : null,
      readback: back.ok ? { path: back.path, sha: sha(back.path) } : null,
      previews: [`${out}.svg`, `${out}.html`].filter((p, i) => [svg, html][i].status === 'pass' && existsSync(full(p))) };
  }
}

// kordoc generate presets (official Korean document forms).
export const PRESETS = ['기안문', '보고서', '계획서', '통지', '회의록', '개조식', '업무보고', '서울방침', '보도자료'];
