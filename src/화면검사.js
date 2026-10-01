import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 화면 검사: the engine opens the project's pages in the installed Edge (or Chrome) inside the Codex sandbox, at PC
// (1440px) and phone (390px) widths, saves full-page captures under .hq-screens/ and lists what a program can see
// (horizontal overflow, broken images, script errors, files that did not load, nameless buttons, tiny text).
// No package and no model call. Whether the page looks good stays with the design and verification teams, who get
// the captures to look at, and with 대장.
export const SCREENS_DIR = '.hq-screens';
const BROKEN = /가로 넘침|깨진 이미지|JavaScript 실행 오류|보이는 글이 없음|거의 보이지 않는 글/;
export class VisualChecker {
  constructor({ sandbox, browserPath = null, env = process.env }) {
    this.sandbox = sandbox;
    this.script = fileURLToPath(new URL('../scripts/화면검사.cjs', import.meta.url));
    const browsers = [path.join(env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(env.PROGRAMFILES ?? 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(env.PROGRAMFILES ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe')];
    this.browserPath = browserPath ?? browsers.find(p => existsSync(p)) ?? null;
  }
  get available() { return Boolean(this.sandbox?.available && this.browserPath); }
  async check(cwd, pages) {
    if (!this.available) return { status: 'unavailable', summary: '브라우저나 샌드박스가 없어 화면 검사 미실시', details: [], screenshots: [] };
    const list = pages.slice(0, 5);
    const result = await this.sandbox.run(cwd, [process.execPath, this.script, this.browserPath, JSON.stringify(list)], { timeoutMs: 120_000 });
    if (result.status !== 'pass') return { status: result.status === 'timeout' ? 'timeout' : 'unavailable',
      summary: '격리 브라우저 실행 실패 · 화면 검사 미실시', details: [String(result.output ?? '').split(/\r?\n/).filter(l => /visual check failed/.test(l)).pop() ?? ''].filter(Boolean), screenshots: [] };
    const line = String(result.output).split(/\r?\n/).find(s => s.startsWith('AGENT_HQ_VISUAL '));
    try {
      const report = JSON.parse(line.slice('AGENT_HQ_VISUAL '.length));
      if (!Array.isArray(report.pages) || report.pages.length !== list.length * 2) throw new Error('incomplete');
      const issues = report.pages.flatMap(p => p.issues.map(i => `${p.file} (${p.width}px): ${i}`));
      const screenshots = report.pages.map(p => ({ file: p.file, width: p.width, path: p.screenshot }))
        .filter(s => typeof s.path === 'string' && s.path.startsWith(`${SCREENS_DIR}/`) && !s.path.includes('..'));
      return { status: issues.length ? 'found' : 'pass',
        summary: `화면 ${report.pages.length}개 캡처 (PC 1440px · 모바일 390px) · 프로그램이 찾은 문제 ${issues.length}개 · 보기 좋은지는 캡처를 보고 판단`,
        details: [...issues.slice(0, 10), ...screenshots.map(s => `캡처: ${s.path}`)], screenshots,
        // Only what is plainly broken holds the project open; small text or an offline web font is a note for the teams.
        blocking: issues.filter(i => BROKEN.test(i)).length ? ['화면 검사에서 깨진 곳 발견: ' + issues.filter(i => BROKEN.test(i)).slice(0, 5).join(' · ')] : [] };
    } catch { return { status: 'unavailable', summary: '화면 검사 결과를 읽지 못함', details: [], screenshots: [] }; }
  }
}
