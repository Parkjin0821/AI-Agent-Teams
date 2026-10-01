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
