import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { hasSecret } from './sentinel.js';

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
}
