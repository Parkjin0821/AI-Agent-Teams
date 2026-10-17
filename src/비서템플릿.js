// 비서 템플릿 (2026-10-18): ready-made project starters taken from the "클로드 비서 30명 세팅표" guide, kept to the ones
// AGENT HQ can do inside its own boundaries — files in the work folder, reading public web pages, reading Notion (read-only
// connector) and the engine's own 한글·엑셀·발표 makers. Each one only fills in the new project's name and objective; the
// teams derive the completion criteria in the conversation as for any project, and 대장 approves them. The suggested
// routine is only pre-selected on the project's 반복 실행 card — nothing repeats until 대장 saves it there.
// Left out on purpose: mail, calendar, Slack, Zapier, YouTube and video making (no reviewed read-only connector, or they
// send or post on 대장's behalf), so those guide items are not offered here.
// A blank 대장 must fill in before the project is made (the engine refuses one left as it is).
export const BLANK_MARK = '(여기에 ';
export const SECRETARY_TEMPLATES = Object.freeze([
  { id: 'sec-minutes', name: '회의록 정리', guide: '02',
    summary: '첨부 폴더에 회의 메모를 넣으면 결정·할 일·담당자로 나눈 한글 회의록을 만듭니다.',
    objective: '작업 폴더 attachments/ 에 들어온 회의 메모(텍스트·한글·워드·PDF)를 읽어 결정 사항, 할 일, 담당자, 기한으로 나눈 회의록.md를 쓰고, '
      + '보고서의 documents로 엔진에 요청해 "회의록" 서식의 한글 문서 회의록.hwpx를 만든다. 메모에 없는 담당자·기한은 지어내지 않고 "미정"으로 적는다. '
      + '공문서 표기법을 지킨다. 첨부된 메모가 없으면 대장에게 메모를 올려 달라고 묻는다.',
    routine: { kind: 'files' }, needs: '회의 메모 파일' },
  { id: 'sec-decisions', name: '주간 결정 기록', guide: '20',
    summary: '매주 Notion에서 지난 7일 동안 정해진 내용만 골라 날짜순 결정 기록을 만듭니다.',
    objective: 'Notion에서 최근 7일 동안 고친 페이지 가운데 회의·결정이 담긴 페이지를 읽기 전용으로 찾아, 정해진 내용만 날짜순으로 결정기록.md에 모은다. '
      + '줄마다 날짜, 결정 내용, 출처 페이지 제목과 주소를 적는다. 결정이 아닌 논의·의견은 넣지 않는다. Notion 페이지는 고치거나 만들지 않는다.',
    routine: { kind: 'weekly', weekday: 'mon', time: '09:00' }, needs: 'Notion 읽기 연결 (팀 화면에서 조사팀·기획팀 켜기)' },
  { id: 'sec-prices', name: '가격 비교', guide: '24',
    summary: '알려 준 상품 페이지에서 가격·할인율·리뷰 수를 모아 표로 비교합니다.',
    objective: '아래 상품 페이지(최대 5곳)에서 가격, 할인율, 리뷰 수를 읽어 가격비교.md에 표로 비교하고 가장 싼 곳을 적는다. '
      + '페이지마다 주소와 확인 시각을 적고 원문을 저장해 대조할 수 있게 한다. 로그인·장바구니·구매는 하지 않는다. 읽지 못한 값은 "확인 못 함"으로 둔다.\n'
      + '상품 페이지 주소:\n- (여기에 주소를 적어 주세요)',
    routine: { kind: 'weekly', weekday: 'mon', time: '09:00' }, needs: '비교할 상품 페이지 주소' },
  { id: 'sec-sheet', name: '매출 집계', guide: '06',
    summary: '첨부한 엑셀·CSV의 월별 매출을 상품별로 합산하고 전월 대비 증감률을 붙입니다.',
    objective: '작업 폴더 attachments/ 에 들어온 엑셀·CSV 매출 표를 읽어 월별 매출을 상품별로 합산하고 전월 대비 증감률 열을 더한 표를 '
      + '엔진의 엑셀 만들기로 집계.xlsx로 만들고, 요약을 집계.md에 쓴다. 합계는 코드로 계산하고 테스트로 확인한다. 원본 파일은 고치지 않는다. '
      + '표에 없는 숫자는 만들지 않는다.',
    routine: { kind: 'files' }, needs: '매출 엑셀 또는 CSV 파일' },
  { id: 'sec-slides', name: '데이터로 발표 자료', guide: '29',
    summary: '첨부한 숫자와 메모로 장마다 제목·핵심 숫자·근거 세 줄인 발표 자료를 만듭니다.',
    objective: '작업 폴더 attachments/ 의 숫자와 메모로 10장짜리 발표 자료를 만든다. 장마다 제목 한 줄, 핵심 숫자 하나, 근거 세 줄을 둔다. '
      + '자료에 없는 숫자는 만들지 않고, 근거마다 어느 파일에서 왔는지 발표자 메모에 적는다. 결과는 PDF로 받는다.',
    routine: { kind: 'files' }, needs: '숫자·메모 파일' },
  { id: 'sec-digest', name: '아침 소식 모음', guide: '05·10·15·21·25',
    summary: '정한 주제의 공식 소식을 매일 아침 제목·한 줄 요약·출처로 모읍니다.',
    objective: '아래 주제에 대해 공식 사이트·보도자료에서 지난 24시간 동안 새로 올라온 소식을 찾아 소식.md에 제목, 한 줄 요약, 게시일, 출처 주소로 정리한다. '
      + '게시일을 확인하지 못한 글은 넣지 않는다. 원문을 저장해 대조할 수 있게 한다.\n주제:\n- (여기에 주제를 적어 주세요)',
    routine: { kind: 'daily', time: '08:00' }, needs: '모을 주제' },
].map(t => Object.freeze({ ...t, builtin: true })));

export const secretaryTemplate = id => SECRETARY_TEMPLATES.find(t => t.id === id) ?? null;
