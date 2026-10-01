# AGENT HQ 아키텍처와 MVP

## 결정

하나의 오케스트레이터가 공급자별 세부사항을 숨기는 `AgentAdapter`를 호출한다. 작업·체크포인트·승인·이벤트는 공급자 세션과 분리해 저장한다. Claude Code/Codex가 바뀌어도 라우팅과 대시보드는 영향을 받지 않는다.

```text
Web dashboard ── HTTP/SSE ── Control plane
                              ├─ Router / policy
                              ├─ Checkpoint + audit store
                              ├─ Approval gate
                              ├─ Claude CLI adapter
                              ├─ Codex CLI adapter
                              └─ MCP catalog adapter
```

## 검토한 설계

1. CLI 어댑터 중심(채택): Plus/Max 구독 로그인을 그대로 사용하고 로컬에서 실행한다. 비용 추가가 없고 현재 목표에 맞지만 CLI 변경 대응이 필요하다.
2. 공급자 API 중심: 안정적인 서버 통합과 계량이 장점이지만 ChatGPT Plus/Claude Max와 별도 API 과금·키가 필요해 목표와 다르다.
3. 범용 프레임워크 중심: LangGraph/OpenHands를 즉시 채택하면 기능은 많지만 두 CLI의 승인·세션·한도 의미가 프레임워크 내부로 새어 들어간다.

## 핵심 경계

- `AgentAdapter.run(task, checkpoint)`: 공급자 실행과 이벤트 정규화
- `RoutingPolicy.choose(task, availability)`: Claude 기본, 중요/복잡 작업은 Codex
- `CheckpointStore`: 목표, 완료 항목, 변경 파일, 검증, 다음 행동, 공급자 세션 ID 저장
- `ApprovalGate`: 네트워크 연결, MCP 설치, 외부 쓰기, 광범위 파일 변경을 승인 전 중단
- `UsageSnapshot`: `available | limited | exhausted | unknown`, reset time, 공식 출처만 저장

## 안전한 교대 규칙

1. 모든 실행 전 체크포인트 생성.
2. 스트림 이벤트와 산출물을 로그에 기록.
3. 한도/인증/복구 가능 오류를 분류하고 실행 종료.
4. 같은 체크포인트에서 다른 공급자용 인계 프롬프트 생성.
5. 새 공급자는 현재 파일 상태와 검증 결과를 먼저 확인한 뒤 계속 진행.
6. 완료 조건 검증 전에는 작업을 완료로 표시하지 않음.

## MVP 범위

포함: 단일 사용자 로컬 실행, 작업 생성·라우팅·상태, SSE 이벤트, 체크포인트, 승인 대기, 공급자 가용성, 감사 로그.

제외: ChatGPT/Claude 웹 UI 자동화, 구독 토큰 탈취·재사용, 비공식 잔여량 스크래핑, 무승인 MCP 설치, 다중 사용자 RBAC, 원격 실행 격리.

## 다음 단계

1. 실제 CLI JSONL 파서와 세션 resume ID 저장
2. SQLite 영속화 및 재시작 복구
3. 공식 MCP Registry read API 연동, 서명·출처·권한 검토 후 승인 설치
4. 워크트리/컨테이너 격리와 명령 정책
5. Playwright E2E와 장애 주입 테스트
