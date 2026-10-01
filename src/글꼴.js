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

// 엔진 글꼴 묶음 (assets/글꼴/, 2026-10-01 대장 승인으로 받음, 모두 SIL OFL 1.1). 설치되지 않아도 페이지와 함께 따라가는
// 글꼴이다: 팀이 보고서에 "fonts":["pretendard"] 처럼 고르면 엔진이 단계 뒤에 프로젝트의 글꼴/ 폴더로 파일과 라이선스를
// 복사하고 글꼴/글꼴.css 를 만든다. 인터넷 없이, 어느 PC에서나, 엔진 화면 캡처에서도 같은 글씨로 보인다.
export const KIT_DIR = new URL('../assets/글꼴/', import.meta.url);
export const KIT_FONTS = Object.freeze([
  { id: 'pretendard', family: 'Pretendard', files: [{ file: 'PretendardVariable.woff2', weight: '45 920', format: 'woff2' }], license: 'Pretendard-OFL.txt',
    feel: '깔끔하고 현대적인 고딕, 굵기 조절', use: '본문·버튼·표 (가장 무난한 현대적 선택)' },
  { id: 'nanum-myeongjo', family: 'Nanum Myeongjo', files: [{ file: 'NanumMyeongjo-Regular.ttf', weight: '400' }, { file: 'NanumMyeongjo-ExtraBold.ttf', weight: '800' }],
    license: 'NanumMyeongjo-OFL.txt', feel: '격식 있는 명조 (보통·아주 굵게)', use: '제목, 긴 글' },
  { id: 'hahmlet', family: 'Hahmlet', files: [{ file: 'Hahmlet[wght].ttf', weight: '100 900' }], license: 'Hahmlet-OFL.txt',
    feel: '현대적인 명조, 굵기 조절', use: '편집형 제목·본문' },
  { id: 'do-hyeon', family: 'Do Hyeon', files: [{ file: 'DoHyeon-Regular.ttf', weight: '400' }], license: 'DoHyeon-OFL.txt',
    feel: '굵고 단단한 고딕', use: '큰 제목·간판' },
  { id: 'black-han-sans', family: 'Black Han Sans', files: [{ file: 'BlackHanSans-Regular.ttf', weight: '400' }], license: 'BlackHanSans-OFL.txt',
    feel: '아주 강한 포스터형', use: '짧은 큰 제목에만' },
  { id: 'gaegu', family: 'Gaegu', files: [{ file: 'Gaegu-Regular.ttf', weight: '400' }], license: 'Gaegu-OFL.txt',
    feel: '손글씨', use: '메모·말풍선·짧은 강조' },
]);
export const FONT_FOLDER = '글꼴';

export function kitPrompt() {
  return '\n[엔진 글꼴 묶음 · 설치되지 않아도 페이지와 함께 따라가는 글꼴]\n'
    + KIT_FONTS.map(f => `- ${f.id}: font-family: '${f.family}' · ${f.feel} · ${f.use}`).join('\n')
    + `\n쓰려면 보고서 JSON 에 "fonts":["pretendard","do-hyeon"] 처럼 id 를 적는다 (최대 3개). 단계가 끝나면 엔진이 작업 폴더의 ${FONT_FOLDER}/ 에`
    + ` 글꼴 파일과 라이선스, ${FONT_FOLDER}/글꼴.css 를 넣는다. 페이지에는 <link rel="stylesheet" href="${FONT_FOLDER}/글꼴.css"> 를 넣고`
    + ` (페이지 위치 기준 상대 경로), font-family 뒤에 대체 글꼴을 둔다. ${FONT_FOLDER}/ 안의 파일은 직접 만들거나 고치지 않는다.`
    + ' 묶음은 작업 폴더 안의 파일이라 인터넷 요청이 없다. "웹폰트·외부 글꼴 없음" 조건은 인터넷에서 불러오는 글꼴을 뜻하므로 묶음은 써도 된다.\n';
}

// Copies the chosen kit fonts (and their licenses) into the work folder and rewrites 글꼴/글꼴.css for every kit
// font present there. Unknown ids are ignored. Returns what was copied.
export async function copyKitFonts(cwd, ids, { kitDir = KIT_DIR } = {}) {
  const { copyFileSync, existsSync, mkdirSync, writeFileSync } = await import('node:fs');
  const path = (await import('node:path')).default;
  const { fileURLToPath } = await import('node:url');
  const src = typeof kitDir === 'string' ? kitDir : fileURLToPath(kitDir);
  const chosen = [...new Set((Array.isArray(ids) ? ids : []).map(String))].map(id => KIT_FONTS.find(f => f.id === id)).filter(Boolean).slice(0, 3);
  if (!chosen.length) return { copied: [] };
  const dest = path.join(cwd, FONT_FOLDER);
  mkdirSync(dest, { recursive: true });
  for (const f of chosen) for (const name of [...f.files.map(x => x.file), f.license]) copyFileSync(path.join(src, name), path.join(dest, name));
  const present = KIT_FONTS.filter(f => f.files.every(x => existsSync(path.join(dest, x.file))));
  const faces = present.flatMap(f => f.files.map(x => `@font-face { font-family: '${f.family}'; src: url("${x.file}") format("${x.format ?? 'truetype'}");`
    + ` font-weight: ${x.weight}; font-style: normal; font-display: swap; }`));
  writeFileSync(path.join(dest, '글꼴.css'), `/* AGENT HQ 엔진이 만든 파일 · 직접 고치지 않는다 · 글꼴 라이선스는 같은 폴더의 *-OFL.txt (SIL OFL 1.1) */\n${faces.join('\n')}\n`);
  return { copied: chosen.map(f => f.id), present: present.map(f => f.id) };
}
