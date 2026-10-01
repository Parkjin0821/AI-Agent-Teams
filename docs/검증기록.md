# 현황 검증 (2026-09-28)

## 공식 지원 범위

- OpenAI: ChatGPT 요금제에서 Codex 사용이 가능하고, CLI의 `/status` 또는 사용량 화면에서 잔여 허용량과 초기화 시간을 확인하도록 안내한다. 공개된 구독 사용량 서버 API는 확인되지 않았다. 따라서 AGENT HQ는 숫자를 추정하지 않고 공식 클라이언트가 노출한 값만 `UsageSnapshot`으로 수집한다.
  - https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
- Codex: 설치된 CLI는 `codex exec --json`, `resume`, `--sandbox workspace-write`를 지원한다. 과거 `codex mcp-server` 예시는 공식 문서에서 신규 자동화에는 Codex SDK/app-server를 권장하는 보관 예제로 표시된다.
  - https://developers.openai.com/cookbook/examples/codex/codex_mcp_agents_sdk/building_consistent_workflows_codex_cli_agents_sdk
- Anthropic: Claude Code는 Max 로그인을 공식 지원하고, 비대화형 `-p`, `stream-json`, 세션 resume, MCP 설정, 권한 모드를 제공한다.
  - https://code.claude.com/docs/en/getting-started
  - https://code.claude.com/docs/en/cli-usage
- MCP: MCP는 ChatGPT와 Claude를 포함한 여러 호스트가 지원하는 공개 표준이다.
  - https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro

## 로컬 호환성

- Node.js 24.19.0
- npm 11.17.0
- Codex CLI 0.158.0-alpha.2.1
- Claude Code 2.1.265
- Git 2.55.0

## 오픈소스 선별

| 프로젝트 | 라이선스 | 참고할 부분 | MVP 채택 |
|---|---|---|---|
| MCP Registry | Apache-2.0/MIT 전환, 문서 CC-BY-4.0 | 공식 레지스트리 read API·메타데이터 | API 계약만 다음 단계에서 사용 |
| LangGraph | MIT | 체크포인트, interrupt 기반 승인 | 개념 참고; 현재는 작은 자체 상태기계 |
| OpenHands | MIT | 에이전트 실행 격리·이벤트 모델 | 구조 참고; 전체 의존성은 보류 |
| LiteLLM | MIT core | API 프록시 사용량/비용 추적 | 구독 CLI 경로와 맞지 않아 보류 |

라이선스 확인:

- https://github.com/modelcontextprotocol/registry/blob/main/LICENSE
- https://github.com/langchain-ai/langgraph/blob/main/LICENSE
- https://github.com/All-Hands-AI/OpenHands/blob/main/LICENSE
- https://github.com/BerriAI/litellm/blob/main/LICENSE

## 확인된 제약

- Plus/Max 구독은 각 공급자의 API 크레딧과 동일하지 않다.
- 구독 잔여량을 통합 조회하는 공식 공통 API가 없으므로 `unknown`이 정상 상태다.
- 실제 실행은 사용자 로그인 세션을 가진 로컬 CLI 프로세스에서만 수행하고 자격 증명을 AGENT HQ 데이터에 복사하지 않는다.
