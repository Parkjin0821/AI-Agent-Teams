import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkLinks, extractLinks, koreanNameIssues, resolveLink } from '../src/링크검사.js';
import { engineGateSummary, verifyReport } from '../src/완료근거.js';

function site(files) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-link-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true });
    writeFileSync(path.join(cwd, rel), text);
  }
  return cwd;
}

test('10차 1번: a link is decoded, resolved from its page and must reach a real file inside the folder', () => {
  const cwd = site({ '서비스 소개.html': '<h1>소개</h1>', '자료/가격표.html': '', '자료/사진/빵.png': 'x', '메뉴/index.html': '' });
  const r = (raw, from = 'index.html') => resolveLink(raw, from, cwd);
  assert.equal(r('서비스 소개.html').status, 'ok', 'a raw space');
  assert.equal(r('서비스%20소개.html').status, 'ok', '%20');
  assert.equal(r(encodeURI('서비스 소개.html')).status, 'ok', '한글 %-encoded');
  assert.equal(r('서비스 소개.html'.normalize('NFD')).status, 'ok', '한글 written in NFD is the same name');
  assert.equal(r('./자료/가격표.html#표?x').status, 'ok', 'query and fragment are dropped');
  assert.equal(r('../서비스 소개.html', '자료/가격표.html').status, 'ok', 'relative to the linking page');
  assert.equal(r('사진/빵.png', '자료/가격표.html').status, 'ok');
  assert.equal(r('/자료/가격표.html', '자료/가격표.html').status, 'ok', 'a leading / is the work folder');
  assert.equal(r('메뉴/').status, 'ok', 'a folder with index.html');
  assert.match(r('자료/').reason, /index\.html 이 없음/);
  assert.match(r('서비스 소개.HTML').reason, /대소문자가 다름 \(실제 이름: 서비스 소개\.html\)/);
  assert.match(r('서비스_소개.html').reason, /없음/);
  assert.match(r('../../밖.html', '자료/가격표.html').reason, /작업 폴더 밖/);
  assert.match(r('%2e%2e/밖.html').reason, /작업 폴더 밖/, 'an encoded .. is still outside');
  assert.match(r('C:\\Users\\대장\\page.html').reason, /절대 경로/);
  assert.match(r('file:///C:/page.html').reason, /절대 경로/);
  assert.match(r('%E0%A4%A.html').reason, /잘못된 %인코딩/);
  assert.match(r('자료/가격표.html/더.html').reason, /폴더가 아님/);
  for (const skip of ['https://example.com/a', '//cdn.example.com/x.js', 'mailto:a@b.c', 'tel:010', 'data:image/png;base64,AA', '#위로', '', '{{url}}']) {
    assert.equal(r(skip).status, 'skip', skip);
  }
});

test('10차 1번: links are read from html attributes, srcset, css url() and markdown, not from comments', () => {
  const html = '<a href="가.html">가</a>\n<img src=\'나.png\' srcset="다.png 1x, 라.png 2x"><!-- <a href="주석.html"> -->\n<div style="background:url(마.jpg)"></div><link href=바.css>';
  assert.deepEqual(extractLinks(html, 'index.html').map(l => l.raw), ['가.html', '나.png', '바.css', '다.png', '라.png', '마.jpg']);
  assert.equal(extractLinks(html, 'index.html').find(l => l.raw === '마.jpg').line, 3);
  assert.deepEqual(extractLinks('[소개](서비스%20소개.html) ![사진](<사진 1.png> "제목") [밖](https://x.y)', '안내.md').map(l => l.raw),
    ['서비스%20소개.html', '사진 1.png', 'https://x.y']);
  assert.deepEqual(extractLinks('body{background:url("배경.png")}', '꾸밈.css').map(l => l.raw), ['배경.png']);
});

test('10차 1번: the whole folder: broken links are listed with page and line; attachments and saved originals are not pages', () => {
  const cwd = site({ 'index.html': '<a href="소개.html">a</a>\n<a href="없는.html">b</a>', '소개.html': '<a href="index.html">홈</a>',
    'attachments/참고.html': '<a href="nowhere.html">x</a>', 'sources/원문.html': '<a href="gone.html">x</a>' });
  const r = checkLinks(cwd);
  assert.equal(r.pages, 2);
  assert.equal(r.links, 3);
  assert.deepEqual(r.broken, [{ file: 'index.html', line: 2, link: '없는.html', reason: '없는.html 없음' }]);
});

test('10차 1번: 한글 file names: fixed tool names and the engine\'s own files are left out', () => {
  const cwd = site({ 'index.html': '', '소개.html': '', 'css/꾸밈.css': '', 'package.json': '{}', 'logo.png': 'x', 'attachments/photo.jpg': 'x', 'sources/page.html': '' });
  assert.deepEqual(koreanNameIssues(cwd).offenders, ['logo.png']);
  assert.deepEqual(koreanNameIssues(cwd, { skip: f => f === 'logo.png' }).offenders, []);
});

test('10차 1번: the 9차 webpage criterion is now proven by the engine alone, and fails on a real broken link', () => {
  const criterion = '새로 만든 파일 이름이 역할이 드러나는 한글 이름이고 링크·경로가 같은 이름을 쓴다';
  const good = site({ 'index.html': '<a href="오시는%20길.html">길</a><img src="사진/빵.png">', '오시는 길.html': '<a href="./">홈</a>', '사진/빵.png': 'x' });
  const ok = verifyReport({ criteria: [{ index: 1, done: false }] }, [criterion], good, { verifying: true });
  assert.equal(ok.evidence.length, 1, 'the verifier said not done; the engine decides');
  assert.equal(ok.evidence[0].by, 'engine');
  assert.match(ok.evidence[0].proof, /한글/);
  assert.match(ok.evidence[0].proof, /링크 3개가 모두 실제 파일로 연결/);
  const bad = site({ 'index.html': '<a href="오시는길.html">길</a>', '오시는 길.html': '' });
  const no = verifyReport({ criteria: [{ index: 1, done: true }] }, [criterion], bad, { verifying: true });
  assert.equal(no.evidence.length, 0);
  assert.match(no.claims[0].detail, /끊긴 링크 1개: index\.html:1 "오시는길\.html" → 오시는길\.html 없음/);
  // a team check that only looked at the file is not enough: the engine's own link check must hold too
  const team = verifyReport({ criteria: [{ index: 1, done: true, checks: [{ type: 'file_exists', path: '오시는 길.html' }] }] }, [criterion], bad, { verifying: true });
  assert.equal(team.evidence.length, 0);
  assert.deepEqual(engineGateSummary([criterion]), ['1번: 만든 파일 이름이 한글, 링크가 모두 실제 파일로 연결']);
});

test('10차 2번: the pre-approval check warns about 대장 checks that are too many or cover what the engine checks', async () => {
  const { lintCriteria } = await import('../src/완료근거.js');
  const one = lintCriteria(['index.html 파일이 있다', '따뜻한 느낌이다 (대장이 화면에서 확인) — 자동 검증 불가: 분위기는 취향']);
  assert.deepEqual(one, [], 'one subjective 대장 check is fine');
  const two = lintCriteria(['따뜻한 느낌이다 (대장이 화면에서 확인)', '휴대폰에서 깨진 곳이 없다 (대장이 화면에서 확인)']);
  assert.ok(two.some(i => /2번: 깨진 화면·넘침·링크·파일 이름은 엔진이 직접 확인한다/.test(i)));
  assert.ok(two.some(i => /대장 확인 조건이 2개다/.test(i)));
});
