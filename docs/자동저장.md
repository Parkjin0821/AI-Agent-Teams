# 프로젝트별 GitHub·Notion 자동 저장

## 구현 상태

로컬 정책·판단·보안 검사·중복 방지·재시도·상태 화면은 구현됨.
실제 외부 전송 어댑터는 자동 보안 검토에서 차단되어 연결하지 않음.
Codex 앱 커넥터 로그인과 로컬 웹 서버의 인증은 별개임.
현재는 `external_adapter_not_connected`, 작업은 `authentication_required`로 대기하며 성공을 표시하지 않음.

## 인터페이스

- GET `/api/projects/:id/auto-save`: 정책, 전송 상태, 검사 경고. 토큰과 소스 내용은 반환하지 않음.
- PUT `/api/projects/:id/auto-save`: `github`, `notion` 불리언. 둘 다 기본 false.
  대상 기본값은 사용자가 제공한 GitHub 계정 `Parkjin0821`, Notion 페이지 `2d96029496a28095b8e6d6a7db5b8208`.
- POST `/api/projects/:id/auto-save/check`: 현재 프로젝트들에 대해 자동 저장 판단 실행.

실제 체크포인트가 없는 모의 실행은 전송하지 않음.
GitHub는 검증 완료 또는 텍스트 파일 5개 이상 또는 텍스트 32,000자 이상일 때 저장 후보.
Notion은 실제 작업 기록 변경 시 후보. 판단은 모델 추론이 아닌 명시적 엔진 규칙임.
내용·기록·목적지 해시로 같은 상태의 중복 작업을 막음.
원격 실패는 1분/5분 간격으로 최대 3번 시도 후 차단. 인증·권한 문제는 즉시 차단.
프로세스 내 직렬 실행. 여러 AGENT HQ 서버를 같은 DB로 동시에 실행하는 구성은 지원하지 않음.

## 안전 범위

GitHub 후보는 100개 이하·총 1MB 이하의 텍스트 소스만. 바이너리·큰 파일·의존성 폴더는 포함하지 않음.
읽은 소스의 고정된 바이트를 비밀정보·개인정보 패턴으로 검사함.
설정·지시 파일과 링크, 비밀정보, 미확인/검토 필요 라이선스는 외부 저장을 차단함.
Notion 전송 인터페이스에는 소스 코드·원문 대화·응답·비밀값이 포함되지 않음.
실제 어댑터 연결 전에는 비공개 저장소 생성·소스 범위·Notion 하위 기록 생성 범위의 구체적 승인이 필요함.
기존 저장소 강제 푸시·삭제, 공개 전환, Portfolio 본문 덮어쓰기는 구현 범위에 없음.

## 확인한 공식 자료

- GitHub repository API: https://docs.github.com/en/rest/repos/repos
- Git tree API: https://docs.github.com/en/rest/git/trees
- Non-force reference update: https://docs.github.com/en/rest/git/refs
- Notion page content: https://developers.notion.com/guides/data-apis/working-with-page-content

## 다음 연결 단계

소스 파일 범위·GitHub 비공개 저장소 자동 생성·지정 Notion 페이지 하위 기록 생성에 대한 구체적 승인.
그 뒤 외부 어댑터 구현 및 가짜 HTTP 서버 테스트, 실제 계정 최소 쓰기 검증을 각각 구분해 수행.
Notion 로컬 서버 인증이 필요함. 비밀 토큰은 채팅·프로젝트 파일에 넣지 않음.
