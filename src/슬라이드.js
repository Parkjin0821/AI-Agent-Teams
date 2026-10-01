import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 슬라이드 만들기 (no model call): a design or dev team writes slides/<id>/index.tsx with open-slide (MIT, installed by
// 대장's approval on 2026-10-01 into tools/open-slide, version pinned 2.0.1) and names the deck in its report
// ("slides":["<id>"]). After the step the engine builds it in the Codex sandbox, prints 발표자료/<id>.pdf with the
// installed Edge and saves a capture of every page under .hq-screens/. Whether the deck reads well stays with the
// verification team (who get the captures) and 대장. PPTX is not made: 대장 converts the PDF when one is needed.
// Korean names are fine (the file-name rule asks for them; the slides re-test named its deck 구청소개발표 and the
// engine refused it). The build uses an English alias inside its temp workspace; the PDF and captures keep the name.
export const SLIDE_ID = /^[a-z0-9가-힣][a-z0-9가-힣-]{0,40}$/;
export const SLIDE_PDF_DIR = '발표자료';
export class SlideMaker {
  constructor({ sandbox, root, browserPath = null, env = process.env }) {
    this.sandbox = sandbox;
    this.tools = path.join(root, 'tools', 'open-slide');
    this.script = fileURLToPath(new URL('../scripts/슬라이드만들기.cjs', import.meta.url));
    const browsers = [path.join(env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(env.PROGRAMFILES ?? 'C:/Program Files', 'Microsoft/Edge/Application/msedge.exe'),
      path.join(env.PROGRAMFILES ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe')];
    this.browserPath = browserPath ?? browsers.find(p => existsSync(p)) ?? null;
  }
  get installed() { return existsSync(path.join(this.tools, 'node_modules', '@open-slide', 'core', 'bin.js')); }
  get available() { return Boolean(this.sandbox?.available && this.browserPath && this.installed); }
  async make(cwd, ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].filter(i => SLIDE_ID.test(i)).slice(0, 3);
    if (!list.length) return { ok: false, decks: [], error: '슬라이드 id 없음 (한글·영문 소문자·숫자·- 만)' };
    if (!this.available) return { ok: false, decks: [], error: this.installed ? '브라우저나 격리 실행 환경이 없어 슬라이드를 만들지 못함' : 'open-slide 미설치 (tools/open-slide)' };
    const result = await this.sandbox.run(cwd, [process.execPath, this.script, this.tools, this.browserPath, JSON.stringify(list)], { timeoutMs: 300_000 });
    const line = String(result.output ?? '').split(/\r?\n/).find(s => s.startsWith('AGENT_HQ_SLIDES '));
    if (result.status !== 'pass' || !line) {
      const why = String(result.output ?? '').split(/\r?\n/).filter(l => /slide make failed/.test(l)).pop() ?? '';
      return { ok: false, decks: [], error: result.status === 'timeout' ? '슬라이드 만들기 시간 초과' : '격리 실행 실패' + (why ? ' · ' + why.slice(0, 300) : '') };
    }
    try {
      const decks = JSON.parse(line.slice('AGENT_HQ_SLIDES '.length)).decks ?? [];
      const safe = p => typeof p === 'string' && !p.includes('..') && (p.startsWith('.hq-screens/') || p.startsWith(SLIDE_PDF_DIR + '/'));
      const clean = decks.filter(d => list.includes(d.id)).map(d => ({ id: d.id, pages: d.pages ?? 0, error: d.error ?? null, detail: d.detail ?? null,
        pdf: safe(d.pdf) ? d.pdf : null, screenshots: (d.screenshots ?? []).filter(safe), overflowPages: d.overflowPages ?? [], scriptErrors: d.scriptErrors ?? 0,
        sparsePages: (d.sparsePages ?? []).filter(Number.isInteger).slice(0, 40),
        smallText: (d.smallText ?? []).filter(s => Number.isInteger(s?.page) && Number.isFinite(s?.px)).slice(0, 40) }));
      return { ok: clean.length > 0 && clean.every(d => !d.error && d.pdf), decks: clean };
    } catch { return { ok: false, decks: [], error: '슬라이드 결과를 읽지 못함' }; }
  }
}

// The engine tool entry shown in the thread and kept on the run.
export function slideTool(result) {
  const decks = result.decks ?? [];
  const issues = decks.flatMap(d => d.error ? [`${d.id}: ${d.error}${d.detail ? ' · ' + d.detail.split('\n').slice(-3).join(' / ') : ''}`]
    : [...(d.overflowPages.length ? [`${d.id}: ${d.overflowPages.join('·')}쪽 내용이 1920×1080 밖으로 넘침`] : []),
      ...(d.scriptErrors ? [`${d.id}: 실행 오류 ${d.scriptErrors}건`] : [])]);
  const made = decks.filter(d => d.pdf);
  // Notes, never blocking: a page whose content ends above 70% of its height, and text under 24px (about 12pt on a
  // 1920×1080 slide, too small from the back of a room).
  const notes = made.flatMap(d => [
    ...((d.sparsePages ?? []).length ? [`참고: ${d.id} ${d.sparsePages.join('·')}쪽은 아래 30% 이상이 비어 있음 (내용을 키우거나 배치를 바꿈)`] : []),
    ...((d.smallText ?? []).length ? [`참고: ${d.id} 글자가 24px 보다 작은 쪽: ${d.smallText.map(s => `${s.page}쪽 ${s.px}px`).join(', ')}`] : [])]);
  return { id: 'slides', name: '슬라이드 만들기', status: result.error || issues.length ? 'found' : 'pass',
    summary: result.error ? result.error : made.map(d => `${d.pdf} (${d.pages}쪽)`).join(' · ') + (issues.length ? ` · 문제 ${issues.length}개` : '') + (notes.length ? ` · 참고 ${notes.length}개` : ''),
    details: [...issues, ...notes, ...made.flatMap(d => d.screenshots.map(s => '캡처: ' + s))],
    blocking: issues.length || result.error ? ['슬라이드: ' + (result.error ?? issues.slice(0, 3).join(' · '))] : [],
    screenshots: made.flatMap(d => d.screenshots.map(p => ({ file: d.id, path: p }))), decks };
}

export function slidesPrompt() {
  return '\n[슬라이드 만들기 · open-slide · 발표 자료가 필요할 때]\n'
    + '- slides/<id>/index.tsx 한 파일에 React 페이지 컴포넌트를 쓰고 `export default [표지, …] satisfies Page[]` 로 내보낸다. id 는 역할이 드러나는 한글 이름 (한글·영문 소문자·숫자·-, 띄어쓰기 없이, 예: 구청-소개-발표).\n'
    + "- import 는 '@open-slide/core' (Page, SlideMeta, DesignSystem 등 타입·컴포넌트)와 'react' 만 쓴다. 다른 패키지·외부 주소는 쓰지 않는다.\n"
    + '- 각 페이지는 1920×1080 화면 하나다. 넘치면 PDF 에서 잘린다. 글자는 본문 32px 안팎, 제목 72~128px, 한 장에 핵심 하나.\n'
    + '- ol·ul 목록 번호와 점은 기본 스타일이 지워지니 직접 그린다 (번호를 글자로 쓰거나 listStyle 을 지정).\n'
    + '- 보고서 JSON 에 "slides":["<id>"] 를 적으면 단계가 끝난 뒤 엔진이 빌드해 발표자료/<id>.pdf 와 쪽마다 캡처(.hq-screens/슬라이드-<id>-01.png …)를 만든다. 넘친 쪽이나 빌드 오류는 다음 단계 피드백으로 온다. PPTX 는 만들지 않는다.\n';
}
