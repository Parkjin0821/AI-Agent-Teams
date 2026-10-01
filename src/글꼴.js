import { execFileSync } from 'node:child_process';

// 이 PC에 설치된 한글 글꼴. 디자인팀이 없는 글꼴 이름만 적어 제목이 바탕, 본문이 맑은 고딕으로 바뀌어 딱딱해졌다
// (2026-10-01 디자인 비교). 그래서 엔진이 실제로 설치된 것을 읽어, 브라우저가 알아보는 CSS 이름과 느낌을 함께 준다.
// CSS 이름은 2026-10-01 이 PC의 Edge에서 글자 폭을 재어 확인했다. 예를 들어 '한컴 산뜻돋움'·'HANBatang'은 알아보지
// 못하고 'Han Santteut Dotum'은 알아본다. 목록은 이 PC에 설치된 것만 고르므로 다른 PC에서는 그 PC의 글꼴이 나온다.
export const KNOWN_FONTS = Object.freeze([
  { reg: /^Noto Sans KR\b/i, css: "'Noto Sans KR'", name: 'Noto Sans KR', feel: '깔끔하고 현대적인 고딕, 굵기 100~900 조절', use: '본문·제목 어디든' },
  { reg: /^Hancom Gothic\b/i, css: "'Hancom Gothic', '한컴 고딕'", name: '한컴 고딕', feel: '반듯한 현대 고딕 (보통·굵게)', use: '본문·제목' },
  { reg: /^Han Santteut Dotum\b/i, css: "'Han Santteut Dotum'", name: '한컴 산뜻돋움', feel: '가볍고 산뜻한 돋움 (보통·굵게)', use: '본문·안내 글' },
  { reg: /^Hancom MalangMalang\b/i, css: "'Hancom MalangMalang', '한컴 말랑말랑'", name: '한컴 말랑말랑', feel: '둥글고 친근함', use: '카페·빵집·아이 대상 제목, 짧은 강조' },
  { reg: /^Hancom Hoonminjeongeum_H\b/i, css: "'Hancom Hoonminjeongeum_H', '한컴 훈민정음 가로쓰기'", name: '한컴 훈민정음', feel: '옛 글씨 느낌', use: '큰 제목 장식에만 (본문 X)' },
  { reg: /^HCR Batang\b/i, css: "'HCR Batang', '함초롬바탕'", name: '함초롬바탕', feel: '단정한 바탕 (보통·굵게)', use: '긴 글, 문서, 격식 있는 제목' },
  { reg: /^HCR Dotum\b/i, css: "'HCR Dotum', '함초롬돋움'", name: '함초롬돋움', feel: '문서용 돋움', use: '문서·표' },
  { reg: /^Malgun Gothic\b/i, css: "'Malgun Gothic', '맑은 고딕'", name: '맑은 고딕', feel: '윈도우 기본 고딕, 무난함', use: '대체 글꼴 (맨 끝)' },
  { reg: /Gungsuh/i, css: "'Gungsuh', '궁서'", name: '궁서', feel: '붓글씨 느낌', use: '전통·한식 같은 특별한 제목에만' },
  { reg: /^Batang\b/i, css: "'Batang', '바탕'", name: '바탕', feel: '오래되고 딱딱한 바탕', use: '제목에 쓰지 않는다' },
  { reg: /^Gulim\b/i, css: "'Gulim', 'Dotum'", name: '굴림·돋움', feel: '오래된 고딕', use: '쓰지 않는다' },
]);

const KEYS = ['HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts', 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'];

// Names of the installed fonts as Windows lists them ("Malgun Gothic Bold (TrueType)"), read with reg.exe.
export function registryFontNames({ run = (file, args) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 }) } = {}) {
  if (process.platform !== 'win32') return [];
  const names = [];
  for (const key of KEYS) {
    let out = '';
    try { out = run('reg', ['query', key]); } catch { continue; }
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s{2,}(.+?)\s{2,}REG_(?:SZ|EXPAND_SZ)\s/.exec(line);
      if (m) names.push(m[1].replace(/\s*\((TrueType|OpenType)\)\s*$/i, '').trim());
    }
  }
  return names;
}

// The known Korean fonts that are installed here, in the order above. Read once per process.
let cached = null;
export function installedKoreanFonts(options = {}) {
  if (cached && !options.run) return cached;
  const names = registryFontNames(options);
  const found = KNOWN_FONTS.filter(f => names.some(n => f.reg.test(n)));
  if (!options.run) cached = found;
  return found;
}

// A short block for the design team prompt.
export function fontsPrompt(fonts) {
  if (!fonts?.length) return '';
  return '\n[이 PC에 설치된 한글 글꼴 · 엔진이 확인 · font-family 에는 이 CSS 이름을 그대로 쓴다]\n'
    + fonts.map(f => `- ${f.name}: font-family: ${f.css} · ${f.feel} · ${f.use}`).join('\n')
    + '\n목록에 없는 글꼴 이름(나눔명조, Pretendard 등)만 적으면 바탕·맑은 고딕으로 바뀌어 딱딱해진다. 쓸 글꼴 뒤에는 대체로'
    + " 'Noto Sans KR', 'Malgun Gothic', sans-serif 를 둔다. 한컴 글꼴은 한컴오피스가 있는 PC에만 있으니, 다른 PC에서 볼 페이지면 대체 글꼴로 봐도 어색하지 않게 고른다.\n";
}
