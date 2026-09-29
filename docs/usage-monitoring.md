# 공식 사용량 표시

기본 접속 주소는 http://localhost:4311 이다. 서버가 종료된 상태에서는 연결 거부가 발생한다.
`npm start`로 실행하며, 기본은 모의 실행이다. 페이지를 켜는 것만으로 실제 AI 목표를 실행하지 않는다.

Codex: 공식 app-server의 initialize/initialized 후 account/rateLimits/read만 호출한다.
모델 턴이나 스레드는 생성하지 않는다. 5시간/주간 사용률을 잔여율로 변환한다.
계정 누적 토큰은 조회하거나 표시하지 않는다.

Claude: 프로젝트 .claude/settings.json의 statusLine 명령이 공식 rate_limits 필드만
data/claude-usage.json에 저장한다. 인증정보·프롬프트는 저장하지 않는다.
이 프로젝트에서 Claude Code를 다시 열고 첫 응답이 나온 후 사용량 화면을 새로고침한다.
상태줄은 대화형 세션 경로다. 현재 비대화형 팀 실행의 실시간 수집은 검증하지 않았다.
5분 이상 오래된 수집값 또는 초기화가 지난 기간은 잔여율로 표시하지 않는다.

실제 CLI 실행은 다음 단계 시작 전에 공식 수집값을 확인한다. 5시간 잔여율 3% 미만 또는 주간 10% 이하이면 대기한다. 두 기간 중 하나라도 미수집·초기화 경과·오래된 값이면 실행하지 않는다. 실행 중인 단계는 강제 종료하지 않으며 체크포인트 저장 이후 적용한다. 모델 변경은 구독 한도를 초기화하지 않는다.
Fable 전용 한도는 이 필드만으로 추정하지 않는다.

공식 문서:
- https://learn.chatgpt.com/docs/app-server
- https://code.claude.com/docs/en/statusline
