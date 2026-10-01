import test from 'node:test';
import assert from 'node:assert/strict';
import { fontsPrompt, installedKoreanFonts, registryFontNames } from '../src/글꼴.js';

// What reg.exe prints for the Windows font key (shape seen on this PC, 2026-10-01).
const sample = [
  'HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts',
  '    Malgun Gothic Bold (TrueType)    REG_SZ    malgunbd.ttf',
  '    Hancom MalangMalang Regular (TrueType)    REG_SZ    HMKMMAG.TTF',
  '    HCR Dotum (TrueType)    REG_SZ    HANDotum.ttf',
  '    Gulim & GulimChe & Dotum & DotumChe (TrueType)    REG_SZ    gulim.ttc',
  '    Arial (TrueType)    REG_SZ    arial.ttf',
].join('\r\n');

test('글꼴: only installed Korean fonts, with the CSS names Edge recognizes', { skip: process.platform !== 'win32' }, () => {
  const run = () => sample;
  assert.ok(registryFontNames({ run }).includes('Hancom MalangMalang Regular'));
  const fonts = installedKoreanFonts({ run });
  assert.deepEqual(fonts.map(f => f.name), ['한컴 말랑말랑', '함초롬돋움', '맑은 고딕', '굴림·돋움'], 'HCR Dotum is not mistaken for old Dotum');
  const text = fontsPrompt(fonts);
  assert.match(text, /font-family: 'Hancom MalangMalang', '한컴 말랑말랑'/);
  assert.match(text, /나눔명조, Pretendard 등.*딱딱해진다/);
  assert.equal(fontsPrompt([]), '');
  assert.deepEqual(installedKoreanFonts({ run: () => { throw new Error('no reg'); } }), [], 'no list when the registry cannot be read');
});

test('엔진 글꼴 묶음: chosen fonts and their licenses are copied with a css file; unknown ids are ignored', async () => {
  const { mkdtempSync, existsSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = (await import('node:path')).default;
  const { copyKitFonts, kitPrompt, KIT_FONTS, FONT_FOLDER } = await import('../src/글꼴.js');
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-kit-'));
  assert.deepEqual((await copyKitFonts(cwd, ['nope'])).copied, []);
  assert.equal(existsSync(path.join(cwd, FONT_FOLDER)), false, 'nothing made for unknown ids');
  const r = await copyKitFonts(cwd, ['do-hyeon', 'pretendard', 'do-hyeon', 'gaegu', 'hahmlet']);
  assert.deepEqual(r.copied, ['do-hyeon', 'pretendard', 'gaegu'], 'at most three, no repeats');
  for (const f of ['DoHyeon-Regular.ttf', 'DoHyeon-OFL.txt', 'PretendardVariable.woff2', 'Pretendard-OFL.txt', 'Gaegu-Regular.ttf']) assert.ok(existsSync(path.join(cwd, FONT_FOLDER, f)), f);
  const css = readFileSync(path.join(cwd, FONT_FOLDER, '글꼴.css'), 'utf8');
  assert.match(css, /font-family: 'Pretendard'; src: url\("PretendardVariable\.woff2"\) format\("woff2"\); font-weight: 45 920/);
  assert.match(css, /SIL OFL/);
  assert.equal(KIT_FONTS.every(f => kitPrompt().includes(`'${f.family}'`)), true);
  assert.match(kitPrompt(), /"fonts":\["pretendard","do-hyeon"\]/);
});
