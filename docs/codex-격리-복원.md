# Codex 팀 실행 복원 — 격리 환경 조사·설계 (1단계)

_2026-10-18 · 헌장 원칙 4("보안 때문에 모델을 영구 제외하지 않는다")에 따른 복원 계획 1·2단계. 정책: `architecture-policy.json` → `codexTeamExecution`._

## 요약

- **원인 재확인됨.** 지금 설치된 Codex(앱 CLI `0.163.0-alpha.10.2`, npm CLI `0.162.1`)의 Windows 샌드박스도 작업 폴더 밖 파일을 읽는다.
  원인은 버그라기보다 설계다: 관리자 모드(elevated) 샌드박스는 명령을 `CodexSandboxOffline` 계정으로 돌리면서,
  **실행할 때마다 홈 폴더 아래 폴더마다 `CodexSandboxUsers` 그룹 읽기(RX) 권한을 붙인다.** `.codex`·`.claude`·`OneDrive`·`Documents`·`AppData`에 이미 붙어 있다.
- **Codex의 새 "읽기 제한 권한 프로필"은 이 PC에서 쓸 수 없다.** 관리자 모드는 거부("`:root` 읽기 필요"), 일반 모드도 거부, 경로 `deny`는 오류 없이 무시, 신형 격리(MXC)는 Windows 11 24H2 이상이 필요하다(이 PC는 23H2).
- **선택안: WSL2 배포판 안에서 Codex 실행.** 배포판은 Windows 드라이브를 보지 못하고 Windows 프로그램도 실행하지 못하게 설정하고, 프로젝트 폴더 하나만 연결한다. 그 안에서 다시 Codex의 Linux 샌드박스(읽기 제한 프로필)를 쓴다. **WSL 설치가 필요해 대장 결정이 먼저다.**
- **경계 시험 작성됨:** `test/코덱스격리.test.js` (기본은 건너뜀). 지금의 Windows 샌드박스로 돌리면 **실패**한다 — 시험이 문제를 제대로 잡는다는 뜻이다. WSL 쪽 시험이 통과해야 Codex 팀을 되돌린다.

## 1. 원인 재확인 (2026-10-18 실측)

방법: 홈 폴더에 이 시험만을 위한 임시 폴더를 만들고(작업 폴더·옆 폴더·다른 홈 폴더에 표시 파일), 엔진과 같은 `codex sandbox -P :workspace`로 명령을 돌렸다.
출력에는 참/거짓만 남기고, 시험 폴더는 곧바로 지웠다. 대장의 실제 개인 파일은 열지 않았다(권한 목록 `icacls`만 확인).

| 확인 | 결과 |
|---|---|
| 작업 폴더 안 쓰기·읽기 | 됨 |
| 작업 폴더 **옆 폴더** 파일 읽기 / 목록 | **됨 (누출)** |
| 작업 폴더와 무관한 **다른 홈 폴더** 파일 읽기 | **됨 (누출)** |
| `C:\Windows\win.ini` 읽기 | 됨 (시스템 파일, 예상된 동작) |
| 작업 폴더 밖 쓰기 | 막힘 |
| 홈 폴더 자체의 목록 | 막힘 (홈 폴더에만 읽기 거부가 걸려 있음) |
| TCP 연결(1.1.1.1:443), 웹 요청 | 막힘 |
| DNS 조회(Node `dns.lookup`) | **됨** (8차 때와 같음, 남은 위험) |
| `whoami` | `<PC 이름>\codexsandboxoffline` (관리자 모드 샌드박스 계정) |

권한이 붙는 방식: 홈 폴더에는 `CodexSandboxUsers:(DENY)(R)`와 하위로 상속되는 읽기 거부가 있다. 그런데 샌드박스를 한 번 돌리면 홈 아래 폴더마다
`CodexSandboxUsers:(OI)(CI)(RX)`가 **명시적으로** 붙고(새로 만든 시험 폴더 두 곳 모두, 작업 폴더와 무관한 쪽도), 명시 허용이 상속 거부보다 앞서므로 읽힌다.
이 권한은 실행이 끝나도 남는다.

읽기를 좁히는 시도 (모두 같은 날, 같은 CLI):

| 시도 | 결과 |
|---|---|
| 권한 프로필 `":minimal"="read"` + 작업 폴더 쓰기 (관리자 모드) | 거부: `elevated Windows sandbox requires effective :root read access` |
| 같은 프로필 + `windows.sandbox="unelevated"` | 거부: `Restricted read-only access requires the elevated Windows sandbox backend` |
| `":root"="read"` + 옆 폴더 `"deny"` (절대 경로·`~/` 경로·`**` 글롭) | **오류 없이 무시** — 표시 파일이 그대로 읽힘 |
| `windows.sandbox="mxc"` | 거부: `native MXC is unavailable on this executor` |

결론: 이 PC의 Windows 기본 샌드박스로는 "작업 폴더 밖 읽기 금지"를 만들 수 없다. 특히 `deny`가 조용히 무시되므로 프로필 설정을 믿고 켜면 안 된다.

## 2. 격리 후보 비교 (이 PC: Windows 11 Education 23H2 build 22631, Ryzen 7 5800X3D, RAM 32GB, 가상화 켜짐·하이퍼바이저 동작 중, WSL·Docker·Podman·Windows Sandbox 미설치)

| 후보 | 설치 필요 | 구독 로그인 유지 (ChatGPT, API 키 금지) | 작업 폴더 경계 (쓰기 / 밖 읽기) | 네트워크 | 속도 | 판정 |
|---|---|---|---|---|---|---|
| A. 지금의 Windows 샌드박스 (elevated) | 없음 | 그대로 | 쓰기 막힘 / **밖 읽기 됨 (홈 전체)** | TCP 막힘, DNS 열림 | 빠름(명령당 약 1초) | **불가** |
| B. Codex 읽기 제한 권한 프로필 (같은 샌드박스) | 없음 | 그대로 | 관리자·일반 모드 모두 거부, `deny` 무시 | — | — | **불가** (현 버전) |
| C. MXC (Codex 신형 Windows 격리) | **Windows 11 24H2(26100.9278) 이상으로 OS 업데이트** | 그대로 (관리자 설정·별도 계정 없음) | 공식 문서: 프로필이 읽기·쓰기 경로를 정함 — 읽기 제한 지원 여부 미확인 | 미확인 | 빠를 것으로 예상 | **보류** — OS 업데이트 뒤 같은 시험으로 재확인할 후보 |
| D. **WSL2 + Codex Linux 샌드박스** | **WSL 기능 + 배포판** (관리자 권한, 재부팅 가능), 배포판 안에 node·codex·bubblewrap | WSL 안에서 대장이 `codex login --device-auth` 1회 → 구독 그대로 | 바깥: Windows 드라이브 안 보임·Windows 프로그램 실행 불가, 프로젝트 폴더만 연결 / 안쪽: 읽기 제한 프로필 (Codex 소스 변경 기록상 bubblewrap이 읽기 제한 지원 — 미러에서 확인, 설치 후 시험으로 확정) | 명령은 Codex 샌드박스가 차단(네트워크 네임스페이스, DNS 포함 예상), Codex 본체만 OpenAI 접속 | 첫 시작 수 초, 이후 명령당 1초 안팎. Windows 폴더 연결(drvfs)은 파일이 많으면 느림 | **선택** |
| E. Docker / Podman 컨테이너 | 미설치. Docker Desktop·Podman 모두 결국 WSL2 위에서 돈다 + 엔진 설치 | 컨테이너 볼륨에 로그인 보관 | 볼륨으로 연결한 폴더만 — 강함 | 컨테이너 단위로 정할 수 있음 | 컨테이너 시작 수 초 | 차선 — D 위에 한 겹 더, 이득에 비해 설치가 큼 |
| F. Windows Sandbox | 기능 켜기(관리자·재부팅). 23H2에는 명령줄 제어(`wsb`) 없음, 동시에 1개만, 닫으면 초기화 | 매번 새로 로그인 → **유지 어려움** | 연결한 폴더만 — 강함 | 끌 수 있음 | 시작 수십 초 | 부적합 (엔진 자동 실행 불가) |
| G. Hyper-V 가상 머신 | 기능 켜기 + OS 설치·관리 | 유지 가능 | 강함 | 정할 수 있음 | 무거움 | 과함 |
| H. ~~별도 Windows 계정~~ | — | — | — | — | — | **대장이 거절한 방식 — 후보에서 제외** |
| I. 폴더 권한 직접 조정 (홈에 샌드박스 그룹 읽기 거부) | 없음 (보안 설정 변경) | 그대로 | Codex가 실행마다 홈 아래에 허용을 다시 붙여 **무력화됨** (실측) | — | — | 불가 |

참고: Codex 관리자 모드 샌드박스도 자체 계정(`CodexSandboxOffline`·`CodexSandboxOnline`)을 쓰지만, 홈 폴더에 읽기 권한을 스스로 붙이므로 계정이 따로라는 것만으로는 경계가 되지 않는다.

## 3. 선택안 — WSL2 안의 Codex

두 겹으로 막는다.

**바깥 겹 (WSL 배포판 `hq-codex`)** — Windows 쪽을 아예 보이지 않게 한다. `/etc/wsl.conf` (코드: `WSL_CONF`, 검사: `checkWslConf`):

```ini
[automount]
enabled = false        # /mnt/c 없음
mountFsTab = false

[interop]
enabled = false        # 안에서 cmd.exe·powershell.exe 등 Windows 프로그램 실행 불가 (켜져 있으면 대장 계정으로 무엇이든 읽힘)
appendWindowsPath = false
```

- 프로젝트 폴더만 단계마다 연결: `mount -t drvfs <Windows 경로> /hq/work/p-<해시12자리>` (root), 단계가 끝나면 `umount`. 이름은 해시라 한글·공백이 Linux 명령줄에 오지 않는다 (`wslWorkPath`, `wslMountCommands`).
- 다른 프로젝트·엔진 데이터(`data/`)·홈 폴더는 배포판 안에 존재하지 않는다.

**안쪽 겹 (Codex Linux 샌드박스, bubblewrap)** — 배포판 안의 로그인 정보(`~/.codex`)도 Codex가 돌리는 명령에서 숨긴다.

```
codex exec --json --ignore-user-config \
  -c 'permissions.hq={filesystem={":minimal"="read",":workspace_roots"={"."="write"}}}' \
  -c 'default_permissions="hq"' \
  --skip-git-repo-check --ephemeral --cd /hq/work/p-xxxxxxxxxxxx -
```

- `--sandbox`는 넘기지 않는다: 넘기면 Codex가 예전 설정으로 돌아가 `default_permissions`를 무시한다 (공식 문서).
- 읽기 전용 팀은 `"."="read"`. 프롬프트는 지금처럼 표준 입력으로만.
- 엔진 쪽 실행은 `wsl.exe -d hq-codex -u hq --cd <경로> --exec codex ...` — Linux 셸을 거치지 않는다 (`wslCommand`, `wslCodexExec`).
- 환경 변수는 지금의 샌드박스와 같이 시스템 기본값만 넘긴다 (`sandboxEnv`). WSL은 `WSLENV`에 적은 것 말고는 Windows 환경 변수를 넘기지 않는다.

**로그인**: 대장이 배포판 안에서 `codex login --device-auth`로 ChatGPT 구독 로그인 1회. API 키는 쓰지 않는다. Windows 쪽 로그인 파일을 복사하지 않는다.

**아직 연결하지 않은 것**: `src/코덱스격리.js`는 명령을 만들고 경계 시험을 돌리는 데까지만 한다. 팀 실행(`src/실행어댑터.js`의 codex 분기)에 WSL 경로를 붙이는 것은
WSL 시험이 통과하고 대장이 승인한 뒤의 다음 단계다(복원 계획 3단계). 그때 활동 표시(`activityFrom`)는 Linux 경로를 작업 폴더 상대 경로로 바꿔 보여 줘야 한다.

**확인하지 못한 것 (설치 후 첫 시험에서 확인)**: Linux용 `codex sandbox`가 `-P`·`-C`를 Windows판과 같이 받는지, `interop` 끈 상태에서 `drvfs` 단일 폴더 연결이 되는지,
한글 경로 연결, bubblewrap이 DNS까지 막는지, `node_modules`가 큰 프로젝트에서 drvfs 속도.

## 4. 경계 시험 — `test/코덱스격리.test.js`

| 부분 | 언제 돈다 | 내용 |
|---|---|---|
| 기본 시험 8개 | 항상 (`npm test`) | 경계 정책 판정, 시험 출력 해석, 시험 스크립트가 **참/거짓만 출력**하고 읽은 내용은 절대 출력하지 않음, `wsl.conf` 검사, WSL 경로·명령(셸 없음, 배포판 이름 검사, root는 연결할 때만), `codex exec`에 `--sandbox` 대신 읽기 제한 프로필, `:root` 읽기 없음 |
| 실측 native | `AGENT_HQ_CODEX_ISOLATION_TEST=native` | 지금의 Windows 샌드박스로 시험 스크립트 실행 (모델 호출 없음) |
| 실측 native exec | 위 + `AGENT_HQ_CODEX_ISOLATION_EXEC=1` | 실제 `codex exec` 한 단계 (**모델 호출 · 구독 사용량 소량**) |
| 실측 wsl | `AGENT_HQ_CODEX_ISOLATION_TEST=wsl` (`AGENT_HQ_WSL_DISTRO`, 기본 `hq-codex` · `AGENT_HQ_WSL_USER`, 기본 `hq`) | 배포판 설정 확인(`/mnt/c` 없음, Windows 프로그램 실행 꺼짐) → 작업 폴더 연결 → 시험 스크립트. `EXEC=1`이면 실제 `codex exec`도 |

경계 정책 (`BOUNDARY_POLICY`):

| 항목 | 기대 | 막아야 하나 |
|---|---|---|
| 작업 폴더 안 쓰고 다시 읽기 | 됨 | 필수 (다 막히면 일을 못 함) |
| 작업 폴더 밖(옆 폴더) 파일 읽기 / 목록 | 안 됨 | 필수 |
| 작업 폴더 밖 쓰기 | 안 됨 | 필수 |
| 실행 계정 홈의 파일 읽기 | 안 됨 | 필수 |
| WSL 안에서 Windows 쪽 파일 읽기 (`/mnt/c`) | 안 됨 | 필수 (WSL만) |
| 외부 TCP 연결 | 안 됨 | 필수 |
| DNS 조회 | 안 됨 | 남은 위험으로 보고 (막지 못해도 실패는 아님) |

WSL 실측에서 "밖"은 배포판 안에 root가 만든, **누구나 읽고 쓸 수 있는** 폴더다. 파일 권한이 아니라 Codex 샌드박스만이 막을 수 있는 자리라서 안쪽 겹을 제대로 시험한다.

실행:

```
set AGENT_HQ_CODEX_ISOLATION_TEST=native
node --test test/코덱스격리.test.js
```

2026-10-18 native 실측 결과 (예상대로 **실패**):

```
관측: {"insideWrite":true,"outsideRead":true,"outsideList":true,"outsideWrite":false,"homeRead":true,"tcp":false,"dns":true}
실패 · 작업 폴더 밖(옆 폴더) 파일 읽기 / 작업 폴더 밖 폴더 목록 보기 / 실행 계정 홈의 파일 읽기
남은 위험 · DNS 조회
```

`npm test`: 490개 중 실패 0 (실측 4개 건너뜀). `node scripts/아키텍처-검사.mjs`: 통과.

## 5. `architecture-policy.json` 갱신 제안 (보호 파일 — 커밋하지 않음)

커밋할 때 대장 승인 표시가 필요하다: `AGENT_HQ_ARCH_APPROVED=대장`. `state`는 `suspended` 그대로, 재검토일도 그대로 둔다.

```diff
-    "reason": "Windows용 Codex 샌드박스(codex-cli 0.163)가 작업 폴더 밖 파일 읽기를 막지 못하는 것을 8차 실측에서 확인. 쓰기·네트워크는 막힘.",
+    "reason": "Windows용 Codex 샌드박스(codex-cli 0.163)가 작업 폴더 밖 파일 읽기를 막지 못하는 것을 8차 실측에서 확인. 쓰기·네트워크는 막힘. 2026-10-18 재확인(0.163.0-alpha.10.2): 관리자 모드 샌드박스가 실행마다 홈 아래 폴더에 샌드박스 계정 읽기 권한을 붙임. 읽기 제한 권한 프로필은 거부되고 deny는 무시됨, MXC는 Windows 11 24H2 이상 필요.",
     "currentPath": "...(그대로)",
     "restorePlan": [
-      "Codex 팀 실행용 격리 환경을 마련한다 (작업 폴더만 보이는 별도 실행 공간 — 예: 전용 Windows 계정·WSL·컨테이너 중 이 PC에서 되는 것)",
-      "격리 환경에서 작업 폴더 밖 읽기가 막히는지 경계 시험을 자동 테스트로 만든다",
+      "[조사·설계 완료 2026-10-18, WSL 설치 대기] Codex 팀 실행용 격리 환경: WSL2 배포판 안에서 실행 (Windows 드라이브 자동 연결·Windows 프로그램 실행 끔, 프로젝트 폴더만 연결, 안쪽은 Codex Linux 샌드박스 읽기 제한 프로필). 별도 Windows 계정 방식은 대장이 거절. 근거 docs/codex-격리-복원.md",
+      "[시험 작성 완료 2026-10-18] 경계 시험 test/코덱스격리.test.js (기본 건너뜀, AGENT_HQ_CODEX_ISOLATION_TEST=native|wsl). 지금의 Windows 샌드박스는 실패(폴더 밖·홈 읽기). WSL 시험 통과가 복원 조건",
       "시험을 통과하면 보안팀·검증팀의 교차 검토를 Codex로 되돌리고, 개발팀의 어려운 작업에 Codex를 다시 배정한다",
       "대시보드에 프로젝트별 Codex 협업 켜기 스위치를 둔다 (지금은 API로만 켤 수 있음)"
     ],
 ...
   "requiredTests": [
 ...
-    "test/업무도메인.test.js"
+    "test/업무도메인.test.js",
+    "test/코덱스격리.test.js"
   ],
```

(같은 내용을 그대로 적용한 파일과 diff: 세션 공유 노트 폴더의 `policy-restore-proposal.json`, `policy-restore.diff`.)

## 6. 대장이 결정할 것

1. **WSL2 설치 여부** — `wsl --install --no-distribution` 후 배포판 하나(Ubuntu 또는 Debian)를 `hq-codex`로 설치. 관리자 권한, 재부팅이 필요할 수 있고 디스크 약 1~2GB.
2. **배포판 안 프로그램 설치** — node(22 이상), `@openai/codex`, bubblewrap. 외부 코드이므로 승인 필요.
3. **WSL 안 Codex 로그인** — 대장이 직접 `codex login --device-auth` (ChatGPT 구독). 비밀번호·토큰은 AI가 입력하지 않는다.
4. **이미 붙은 폴더 권한을 어떻게 할지** — Codex 샌드박스가 `.codex`·`.claude`·`OneDrive`·`Documents`·`AppData` 등 홈 아래 폴더에 붙인
   `CodexSandboxUsers` 읽기 권한. 엔진 검사용 샌드박스(`src/격리환경.js`, 테스트 실행·화면 검사)가 지금도 같은 Codex 샌드박스를 쓰므로 지워도 다시 붙는다.
   정리하려면 검사용 실행도 WSL로 옮기는 것까지 함께 정해야 한다. (보안 설정 변경 — 대장 승인 사항)
5. **MXC를 기다릴지** — Windows 11 24H2 업데이트 뒤 같은 시험으로 MXC를 확인하는 길도 있다. WSL과 함께 보류 후보로 둘지, 버릴지.
6. **실모델 시험 실행 여부** — `AGENT_HQ_CODEX_ISOLATION_EXEC=1`은 Codex 구독 사용량을 조금 쓴다. 이번에는 돌리지 않았다.
7. **정책 갱신 승인** — 위 5절 diff를 `AGENT_HQ_ARCH_APPROVED=대장`으로 커밋할지.

## 출처

- Codex 권한 프로필(`:minimal`·`:workspace_roots`·`deny`, `--sandbox`가 `default_permissions`를 무시함, 일반 모드는 일부 읽기 제한을 거부): https://learn.chatgpt.com/docs/permissions
- 설정 항목(`default_permissions`, `windows.sandbox = mxc | elevated | unelevated`): https://learn.chatgpt.com/docs/config-file/config-reference
- Windows 샌드박스(MXC 빌드 요구, 관리자 모드의 전용 계정·권한 경계·방화벽, WSL2 권장 상황): https://learn.chatgpt.com/codex/windows/windows-sandbox
- 샌드박스 개념(PowerShell은 Windows 샌드박스, WSL2는 Linux 샌드박스): https://learn.chatgpt.com/docs/sandboxing
- OpenAI 엔지니어링 글(기본 모드는 거의 어디든 읽기, 쓰기는 작업 폴더): https://openai.com/index/building-codex-windows-sandbox/
