# Codex 팀 실행 복원 — 격리 환경 조사·설계

_2026-10-18 · 헌장 원칙 4("보안 때문에 모델을 영구 제외하지 않는다")에 따른 복원 계획 1·2단계. 정책: `architecture-policy.json` → `codexTeamExecution`._
_1차(커밋 2970857): 원인 재확인·후보 비교. 2차(이 판): 대장 결정·보안 조건 반영 설계, 설치 안내(`docs/codex-wsl-설치안내.md`)._

## 요약

- **원인 재확인됨.** 지금 설치된 Codex(앱 CLI `0.163.0-alpha.10.2`, npm CLI `0.162.1`)의 Windows 샌드박스도 작업 폴더 밖 파일을 읽는다.
  관리자 모드(elevated) 샌드박스는 명령을 `CodexSandboxOffline` 계정으로 돌리면서 **실행할 때마다 홈 아래 폴더마다 `CodexSandboxUsers` 읽기(RX) 권한을 붙인다.**
  이 문제는 **해결되지 않은 것으로 유지**하고 8절에서 따로 추적한다 (대장 결정 4).
- **대장 결정 (2026-10-18):** WSL2를 Codex 전용 시험 환경으로 구축. Node.js·Codex CLI·bubblewrap 설치 승인. 로그인은 대장이 직접.
  MXC·Windows 업데이트는 기다리지 않음. 경계 시험 통과 후에만 제한된 실모델 시험. 정책 변경은 diff·검증 결과를 보고 별도 승인.
- **보안 조건:** WSL2는 Windows와 완전히 분리된 보안 경계가 아니다 (Microsoft: WSL 안의 셸은 같은 사용자가 PowerShell을 연 것과 같은 권한).
  그래서 **설치만으로 해결로 보지 않고**, 2차 설계는 Windows와 배포판 사이에 공유 폴더를 아예 두지 않는다 —
  작업 파일은 tar 묶음으로 넣고 돌려받으며, 돌려받을 때 링크·밖으로 나가는 경로·에이전트 설정 파일을 거부한다.
- **지금 상태 (2026-10-18 20:30):** 배포판 `hq-codex` 구축·준비 확인 15/15, **WSL 경계 시험 모든 항목 막힘**(대조 실험으로 시험 유효성 확인), 실제 로그인 정보 보호 확인, **제한된 실모델 시험 1회 통과**.
  Codex를 팀 실행에 연결하는 것은 경계 조건은 충족했지만, 정상 실행 경로를 바꾸는 일이라 정책 승인과 연결 설계 승인 뒤 별도로 한다 (5절).

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
| D. **WSL2 + Codex Linux 샌드박스** | **WSL 기능 + 배포판** (관리자 권한, 재부팅 가능), 배포판 안에 node·codex·bubblewrap | WSL 안에서 대장이 `codex login --device-auth` 1회 → 구독 그대로 | 바깥: Windows 드라이브 안 보임·Windows 프로그램 실행 불가, 작업별 파일 복사·반환(공유 폴더 없음) / 안쪽: 읽기 제한 프로필 (Codex 소스 변경 기록상 bubblewrap이 읽기 제한 지원 — 미러에서 확인, 설치 후 시험으로 확정) | 명령은 Codex 샌드박스가 차단(네트워크 네임스페이스, DNS 포함 예상), Codex 본체만 OpenAI 접속 | 첫 시작 수 초, 이후 명령당 1초 안팎. 작업마다 복사·반환 시간 추가(파일 수에 비례) | **선택** |
| E. Docker / Podman 컨테이너 | 미설치. Docker Desktop·Podman 모두 결국 WSL2 위에서 돈다 + 엔진 설치 | 컨테이너 볼륨에 로그인 보관 | 볼륨으로 연결한 폴더만 — 강함 | 컨테이너 단위로 정할 수 있음 | 컨테이너 시작 수 초 | 차선 — D 위에 한 겹 더, 이득에 비해 설치가 큼 |
| F. Windows Sandbox | 기능 켜기(관리자·재부팅). 23H2에는 명령줄 제어(`wsb`) 없음, 동시에 1개만, 닫으면 초기화 | 매번 새로 로그인 → **유지 어려움** | 연결한 폴더만 — 강함 | 끌 수 있음 | 시작 수십 초 | 부적합 (엔진 자동 실행 불가) |
| G. Hyper-V 가상 머신 | 기능 켜기 + OS 설치·관리 | 유지 가능 | 강함 | 정할 수 있음 | 무거움 | 과함 |
| H. ~~별도 Windows 계정~~ | — | — | — | — | — | **대장이 1차에서 거절 — 후보에서 제외.** 2차 지시에 따라 "WSL만으로 부족할 때의 보강" 으로서만 7절에서 다시 검토 |
| I. 폴더 권한 직접 조정 (홈에 샌드박스 그룹 읽기 거부) | 없음 (보안 설정 변경) | 그대로 | Codex가 실행마다 홈 아래에 허용을 다시 붙여 **무력화됨** (실측) | — | — | 불가 |

참고: Codex 관리자 모드 샌드박스도 자체 계정(`CodexSandboxOffline`·`CodexSandboxOnline`)을 쓰지만, 홈 폴더에 읽기 권한을 스스로 붙이므로 계정이 따로라는 것만으로는 경계가 되지 않는다.

## 3. 2차 설계 — 대장 보안 조건별 대응

| 대장 조건 | 설계 | 확인하는 시험 | 상태 |
|---|---|---|---|
| Windows 드라이브 자동 마운트 차단 | `/etc/wsl.conf` `[automount] enabled=false`, `mountFsTab=false`. 수동 마운트는 root만 가능 → 실행 사용자 sudo 없음·root 잠금 | `/mnt/c` 없음, `windowsRead`, `mountEscape`(`mount -t drvfs C:`) | 설계·시험 작성, **실측 대기** |
| Windows 프로세스 실행 연동 차단 | `[interop] enabled=false`, `appendWindowsPath=false`, `[gpu] enabled=false`(Windows 드라이버 공유 끔), 권장: `.wslconfig` `guiApplications=false` | binfmt `WSLInterop` 꺼짐, PATH에 `.exe` 없음, `interopExec`(cmd.exe·powershell.exe·`/mnt/c/...`·`/run/WSL` 소켓·`WSL_INTEROP` 소켓 연결) | 설계·시험 작성, **실측 대기** |
| 폴더 직접 공유보다 작업별 복사·반환 | **공유 폴더 없음.** 엔진이 작업 파일을 tar로 묶어 `wsl.exe` 표준 입력으로 넣고(`tar -x`), 끝나면 표준 출력으로 돌려받는다(`tar -c --format=pax`). `src/작업묶음.js` | `test/작업묶음.test.js`: 왕복, 한글·긴 경로, Windows `tar.exe`와 서로 읽기 | 구현·단위 시험 **통과**, WSL 실측 대기 |
| 필요한 파일만 노출 | 넣을 때 제외: `.git`, `node_modules`, `.env*`, 개인 키·인증서(`id_*`, `*.pem/key/p12/pfx`), `.npmrc`, `.netrc`, 에이전트 설정(`.claude`·`.codex`·`AGENTS.md`·`CLAUDE.md`…). 링크가 있으면 작업 중단. 크기 제한(총 200MB·파일 50MB·2만 개) | 같은 파일 | **통과** (단위) |
| 작업 코드의 Codex 인증정보 접근 제한 | 로그인은 배포판 안 `/home/hqcodex/.codex`(홈 700)에만. Codex가 돌리는 명령은 bubblewrap 프로필로 플랫폼 경로(`:minimal`)와 작업 폴더만 읽음 → `~/.codex` 안 보임. Windows 쪽 `.codex`는 복사하지 않음 | `authRead`: 실제 `auth.json`과 미끼 파일을 1바이트 읽기 시도(내용은 출력하지 않음) | 설계·시험 작성, **실측 대기** |
| 별도 Linux 사용자·bubblewrap 정책 | `hqcodex`: 비밀번호 잠금, sudo·관리 그룹 없음. root 잠금. 작업마다 `/srv/hq/jobs/<id>` (700). root는 작업 폴더 만들기·지우기에만 | `sudo`, 관리 그룹, root 잠김, **같은 사용자의 다른 작업 폴더 읽기**(`outsideRead` — 파일 권한상 허용, Codex 샌드박스만 막을 수 있는 자리) | 설계·시험 작성, **실측 대기** |
| 마운트·링크·외부 경로·프로세스 우회 시험 | 시험 스크립트: 링크로 밖 읽기, `/proc/1/root` 경유, drvfs 마운트, Windows 프로그램, 밖 쓰기·목록. **반환 검사**: 링크·하드링크·장치·`..`·절대 경로·드라이브 문자·에이전트 설정·Windows 금지 이름 → 묶음 전체 거부 | 우회 항목 + 반환 거부 시험(작업 폴더에 링크를 심고 돌려받기) | 반환 검사 **통과**(단위), native에서 링크 우회 **누출 실측**, WSL 실측 대기 |
| WSL만으로 부족하면 별도 계정·VM 검토 | 7절 | — | 검토 완료 (실측 후 재판단) |
| 기존 엔진의 Windows 읽기 권한 문제 별도 추적 | 8절, 정책 `openIssues` 제안 | `AGENT_HQ_CODEX_ISOLATION_TEST=native` | 추적 중 (해결 안 됨) |

## 4. 격리 구조 — 한 작업의 흐름

| 순서 | 어디서 | 하는 일 |
|---|---|---|
| 1 | Windows (엔진) | 기존 작업 폴더 검사(`assertWorkspaceConfigurationSafe`) + `packFolder`: 일반 파일만 tar로 묶음 |
| 2 | 배포판, root | `install -d -o hqcodex -m 700 /srv/hq/jobs/<id>` |
| 3 | 배포판, hqcodex | `tar -x` (표준 입력) — Windows 경로는 배포판에 한 번도 나타나지 않음 |
| 4 | 배포판, hqcodex → bubblewrap | `codex exec --ignore-user-config -c permissions.hq=… -c default_permissions="hq" --cd /srv/hq/jobs/<id> -` (프롬프트는 표준 입력, `--sandbox` 안 씀) |
| 5 | 배포판, hqcodex → Windows | `tar -c --format=pax` (표준 출력) → `unpackReturn`이 검사 → **임시 폴더**에 풀기 |
| 6 | Windows (엔진) | (다음 단계) 바뀐 파일을 프로젝트에 반영 — 기존 대장 규칙(금지 경로)·완료 근거·검증팀 절차 그대로 |
| 7 | 배포판, root | `rm -rf --one-file-system /srv/hq/jobs/<id>` |

세 겹: ① Windows ↔ 배포판: 공유 폴더·드라이브·Windows 프로그램 없음 ② 배포판 안: root 아닌 전용 사용자 ③ Codex가 돌리는 명령: bubblewrap 안에서 작업 폴더만, 네트워크 없음.
Codex 본체(모델과 대화하는 프로세스)만 인터넷에 나간다. 코드는 `src/코덱스격리.js`(명령 만들기·경계 판정·시험 스크립트), `src/작업묶음.js`(묶기·반환 검사), `scripts/코덱스격리-준비.mjs`(배포판 준비·확인).
**정상 실행 경로(`src/실행어댑터.js`·`목표실행.js`·`팀.js`, 서버)는 바꾸지 않았다.** 팀 실행에 붙이는 것은 시험 통과와 대장 승인 뒤다.

## 5. 대장 보고 항목별 현재 상태 (2026-10-18 20:30 실측 반영)

| 항목 | 상태 |
|---|---|
| WSL2 설치 전 확인 사항 | **완료** — `docs/codex-wsl-설치안내.md` 0절 (Win11 23H2 22631, 가상화 켜짐, RAM 32GB, C: 여유 390GB) |
| 시스템 변경·재부팅 | 대장이 WSL 설치(관리자, WSL 3.0.3·커널 6.18). 대장 확인 후 `%UserProfile%\.wslconfig` 생성(`guiApplications=false`). 배포판 `hq-codex`(Debian 13) 설치·준비는 배포판 안에서만. **Windows 폴더 권한은 바꾸지 않음** |
| WSL2 설정·격리 구조 | **실측 확인** — 준비 확인 15개 모두 ✓ (`node scripts/코덱스격리-준비.mjs`) |
| Windows 파일 접근 차단 실측 | **막힘** — drvfs·9p·virtiofs 연결 없음, `/mnt/c` 경로로 Windows 표시 파일 못 읽음, `mount -t drvfs C:` 실패, Windows 실행 파일(`whoami.exe`) 실제 실행 안 됨 |
| 작업 공간 밖 쓰기 차단 실측 | **막힘** — 같은 사용자의 옆 작업 폴더(파일 권한상 쓰기 허용 자리)에 못 씀. 읽기·목록·링크 우회도 막힘 |
| Codex 인증정보 보호 검증 | **막힘** — 실제 로그인 뒤 `~/.codex/auth.json`(600)과 미끼 파일을 샌드박스 안 명령이 열지 못함. 대조(샌드박스 없음)에서는 열림 → 막는 것은 Codex Linux 샌드박스 |
| 실모델 시험 결과와 사용량 | **통과 1회** — 실제 `codex exec`(effort low, 권한 프로필, `--sandbox` 없음)로 같은 시험 스크립트: 모든 항목 막힘, 종료 코드 0, 약 11초. Codex 보고 사용량: 입력 28,871 토큰(캐시 24,576) / 출력 142 토큰. 한계: 이 1회는 모델이 보고한 줄로 판정했고 명령 실행 기록과 자동 대조하지 않았다(값은 샌드박스 단독 실측과 글자까지 같음). 이후 실행부터 시험이 실행 기록과 결과 파일 반환을 자동 대조한다 |
| Windows 기존 ACL 정리 계획 | 8절 (계획만, 실행은 대장 승인 후) — **해결 안 됨** |
| 전용 VM으로 전환해야 할 위험 | 7절 — 실측에서 VM 전환을 요구하는 누출은 **없음**. 남은 위험(R1·R2 커널급, 연동 소켓)은 WSL 구조의 한계로 남김 |
| Codex를 팀 실행에 연결해도 되는가 | **경계 조건은 충족.** 다만 연결은 정상 실행 경로(`실행어댑터.js`·`목표실행.js`)를 바꾸는 핵심 설계 변경이므로 ① 정책 갱신 승인 ② 연결 설계 승인(작업 전 준비 확인 자동 실행, 반환 반영 규칙, 동시 작업 시험) 뒤 별도 커밋으로 진행한다. 지금은 연결하지 않았다 |

WSL 실측 (2026-10-18, codex-cli 0.163.0, Debian 13, bubblewrap):

| 확인 | Codex 샌드박스 안 | 대조: 같은 사용자, 샌드박스 없음 |
|---|---|---|
| 작업 폴더 안 쓰기 | 됨 | 됨 |
| 옆 작업 폴더 읽기 / 목록 / 쓰기 | 막힘 / 막힘 / 막힘 | 뚫림 / 뚫림 / 뚫림 |
| 홈 파일 읽기 | 막힘 | 뚫림 |
| Codex 인증정보 읽기 | 막힘 | 뚫림 (미끼 파일) |
| 링크로 밖 파일 읽기 | 막힘 | 뚫림 |
| TCP / DNS | 막힘 / 막힘 | 뚫림 / 뚫림 |
| WSL 연동 소켓(`/run/WSL`) 접속 | 막힘 | 열림 (Windows 쪽이 실행을 받지 않음) |
| Windows 파일 / drvfs 연결 / Windows 프로그램 / `/proc/1/root` / sudo | 막힘 | 막힘 (배포판 설정·root 없음 겹) |
| 돌려받기에 링크를 심음 | 묶음 전체 거부 | — |

대조 실험에서 누출이 보이므로 시험 자체가 작동하고, 막는 겹이 무엇인지도 구분된다: 작업 폴더 밖·홈·인증정보·네트워크는 **Codex Linux 샌드박스**가,
Windows 쪽 접근은 **배포판 설정과 root 없음**이 막는다. Windows 샌드박스에서 열려 있던 DNS도 여기서는 막혔다.

설치 중 바로잡은 것: Debian의 sudo는 root 잠금 상태에서 지우기를 거부함 → 강제 삭제 설정. 첫 실행 때 남은 빈 `/mnt/c`는 연결이 아님 → 연결 여부로 판정.
binfmt `WSLInterop` 표시는 `enabled`인데 실제 Windows 실행은 안 됨 → 표시가 아니라 실제 실행으로 판정.

아직 검증하지 않은 것: **동시에 도는 두 작업**(이번 시험은 한 번에 하나), 큰 프로젝트에서의 복사·반환 속도, 배포판 재시작·WSL 업데이트 뒤에도 설정이 유지되는지(작업 전 준비 확인 자동 실행으로 다룰 계획).

native(지금의 Windows 샌드박스) 실측, 2026-10-18 2차 (예상대로 **실패**):

```
관측: {"insideWrite":true,"outsideRead":true,"outsideList":true,"outsideWrite":false,"homeRead":true,"symlinkEscape":true,"tcp":false,"dns":true}
실패 · 작업 폴더 밖(옆 폴더) 파일 읽기 / 밖 폴더 목록 / 실행 계정 홈의 파일 읽기 / 작업 폴더 안에 만든 링크로 밖 파일 읽기
남은 위험 · DNS 조회
```

## 6. 경계 시험

| 파일·명령 | 언제 | 내용 |
|---|---|---|
| `test/작업묶음.test.js` | 항상 (`npm test`) | 넣을 파일 고르기(제외 목록·링크면 중단·크기 제한), 반환 거부 15가지, 잘린·변조된 묶음, GNU 긴 이름, Windows `tar.exe`와 서로 읽기 |
| `test/코덱스격리.test.js` 기본 7개 | 항상 | 경계 판정(Linux 전용 항목 6개 포함), 시험 스크립트가 참/거짓만 출력·링크를 남기지 않음, `wsl.conf` 검사, WSL 명령(셸 없음·이름 검사·root는 폴더 만들기/지우기만·Windows 경로 없음), `codex exec`가 `--sandbox` 대신 읽기 제한 프로필 |
| 실측 native | `AGENT_HQ_CODEX_ISOLATION_TEST=native` | 지금의 Windows 샌드박스 (모델 호출 없음) — 해결 전까지 실패가 정상 |
| 실측 wsl ① | `AGENT_HQ_CODEX_ISOLATION_TEST=wsl` | 배포판: `wsl.conf`, `/mnt/c` 없음, Windows 프로그램 연동 꺼짐·PATH, sudo 없음, root 잠김, 관리 그룹 없음 |
| 실측 wsl ② | 같음 | 작업 폴더 2개(같은 사용자) 만들기 → 묶음 넣기 → `codex sandbox`로 시험 스크립트(모델 호출 없음) → 돌려받기 → 링크를 심어 돌려받기 거부 확인 → 정리 |
| 실모델 | 위 + `AGENT_HQ_CODEX_ISOLATION_EXEC=1` | 실제 `codex exec` 한 단계로 같은 시험 스크립트 실행 (구독 사용량 소량) |
| 준비 확인 | `node scripts/코덱스격리-준비.mjs` | 배포판 상태 14가지 ✓/✗ (아무것도 바꾸지 않음). 지금: "배포판 없음" |

경계 정책 (`BOUNDARY_POLICY`): 작업 폴더 안 쓰기는 **되어야** 하고, 밖 읽기·목록·쓰기, 홈 읽기, 링크 우회, TCP는 **막혀야** 한다(공통).
WSL에서는 인증정보 읽기, Windows 파일 읽기, `/proc/1/root` 경유, drvfs 마운트, Windows 프로그램 실행, sudo도 막혀야 한다. DNS는 남은 위험으로 보고만 한다.
보고하지 않은 항목은 통과가 아니라 실패로 친다.

## 7. 남은 위험 — WSL로 충분한가, VM·별도 계정이 필요한가

WSL2 배포판은 Windows 사용자 권한의 연장선이다. 드라이브 자동 연결·Windows 프로그램 실행을 끈 것은 배포판 설정이므로, **배포판 안에서 root가 되면** 설정을 되돌리거나 drvfs를 손으로 연결해 Windows 사용자 파일 전체에 닿을 수 있다.

| 위험 | 막는 장치 | 남는 것 |
|---|---|---|
| R1 배포판 root 획득 → `wsl.conf` 변경·수동 drvfs 연결 | 실행 사용자 sudo 없음·root 잠금, 명령은 bubblewrap 안에서 더 좁게. (다음 단계) 매 작업 전 준비 확인을 자동으로 돌려 설정이 바뀌면 중단 | Linux 커널·setuid 프로그램 취약점 (WSL 커널은 Microsoft 업데이트) |
| R2 WSL VM 탈출 (하이퍼바이저·파일 서버 취약점) | — | 낮지만 0이 아님. 성공하면 대장 Windows 계정 권한 |
| R3 같은 사용자의 작업끼리 분리 | bubblewrap가 작업 폴더만 보임 + 작업 폴더 700 + 끝나면 삭제 | 옆 작업 폴더 읽기·쓰기 막힘 **실측**. 두 작업이 **동시에** 도는 경우는 미실측 |
| R4 네트워크 | 명령은 bubblewrap 네트워크 차단, 배포판 자체는 Codex 본체 때문에 인터넷 필요 | TCP·DNS 막힘 **실측**. 배포판 안에서 샌드박스 밖으로 도는 프로그램(Codex 본체)은 인터넷 가능 |
| R7 WSL 연동 소켓 | `/run/WSL/1_interop`가 누구나 접속 가능하게 열려 있음. 샌드박스 안에서는 접속 막힘, Windows 실행 요청은 Windows 쪽이 받지 않음(실측) | 소켓 자체는 WSL 구성 요소라 지우지 않음 |
| R5 돌려받은 파일 내용 (악성 코드·프롬프트 주입) | 에이전트 설정 파일은 반환 거부, 이후 기존 대장 규칙·감시·검증팀 그대로 | 경계 문제가 아니라 내용 검토 문제 |
| R6 엔진 쪽 `wsl -u root` | 엔진(Windows)은 신뢰 영역, Codex는 Windows에 닿지 못함 | — |

판단:
- **AGENT HQ 프로젝트 코드와 Codex가 쓴 코드를 다루는 일**에는, WSL 실측이 모두 통과하면 WSL 구조로 충분하다고 제안한다 (R1·R2가 커널 취약점급 공격을 요구).
- **출처를 모르는 외부 코드·패키지를 설치하거나 실행하는 일**(네트워크 켠 `npm install` 등)은 WSL 경계로 부족하다 → 그때는 **Hyper-V VM**(Education 판 지원, 기능 켜기 필요)을 쓴다.
  별도 Windows 계정은 대장이 1차에 거절했고, 이 PC에서 Codex 자체 샌드박스 계정도 폴더 권한 부여로 무력화된 것을 봤으므로 VM이 더 낫다.
- WSL 실측(2026-10-18)에서 VM 전환을 요구하는 누출은 **나오지 않았다.** 남은 것은 커널·가상화 취약점급(R1·R2)과 동시 작업 미실측(R3)이다.

## 8. Windows 쪽 기존 권한 문제 — 별도 추적 (해결 안 됨)

- 현상: 홈 아래 폴더(`.codex`·`.claude`·`OneDrive`·`Documents`·`AppData`·`AI-Agent-Teams` 등)에 `CodexSandboxUsers:(OI)(CI)(RX)`.
  이 그룹 계정(`CodexSandboxOffline`·`CodexSandboxOnline`)으로 도는 프로세스 = Windows용 Codex 샌드박스 안의 명령이 읽을 수 있다. 대장 계정 자체의 권한은 바뀌지 않았다.
- 다시 붙는 경로: 엔진 검사용 샌드박스(`src/격리환경.js` — 테스트 실행·화면 검사·문서), Windows에서 Codex 앱·CLI 사용, `allowProviderSwitch`를 켠 프로젝트의 Codex 실행.
- 정리 계획 (**대장 승인 후**, 지금은 아무것도 바꾸지 않음):
  1. 목록 (읽기만, 일반 PowerShell): `Get-ChildItem $env:USERPROFILE -Force -Directory | % { $a = icacls $_.FullName | Select-String 'CodexSandboxUsers:\(OI\)\(CI\)\(RX\)'; if ($a) { $_.Name } }`
  2. 엔진 검사용 실행을 WSL 배포판으로 옮길지 결정 (옮기지 않으면 정리해도 다시 붙음). Node 테스트는 이미 Node 권한 모델로 한 겹 더 막혀 있다.
  3. 정리 (관리자 PowerShell, 폴더마다): `icacls "<폴더>" /remove:g CodexSandboxUsers` — 허용 항목만 지우고 홈 폴더의 거부 항목은 남긴다.
     Windows에서 Codex를 더 쓰지 않기로 하면 `codex sandbox uninstall`(전용 계정·방화벽 규칙 제거)도 후보 — 이 명령이 폴더 권한까지 지우는지는 확인되지 않았다.
  4. 확인: 1번 목록이 비어야 한다. `AGENT_HQ_CODEX_ISOLATION_TEST=native`는 엔진 검사용 샌드박스를 다시 돌리므로 정리 뒤에는 돌리지 않는다.
- 정책에 `openIssues` 항목으로 남기자고 제안한다 (9절).

## 9. `architecture-policy.json` 갱신 제안 (보호 파일 — 커밋하지 않음)

제안 파일과 diff: 세션 공유 노트 폴더의 `policy-restore-proposal.json`, `policy-restore.diff`.
**검증:** 제안 파일을 아키텍처 가드(`checkArchitecture`)에 넣어 돌림 → 13개 검사 모두 통과, 경고 없음. `state`는 `suspended`, `reviewBy`는 2026-11-15 그대로.

```diff
--- a/architecture-policy.json
+++ b/architecture-policy.json (제안)
@@ -23,15 +23,18 @@
   "codexTeamExecution": {
     "state": "suspended",
     "since": "2026-10-17",
-    "reason": "Windows용 Codex 샌드박스(codex-cli 0.163)가 작업 폴더 밖 파일 읽기를 막지 못하는 것을 8차 실측에서 확인. 쓰기·네트워크는 막힘.",
+    "reason": "Windows용 Codex 샌드박스(codex-cli 0.163)가 작업 폴더 밖 파일 읽기를 막지 못하는 것을 8차 실측에서 확인. 쓰기·네트워크는 막힘. 2026-10-18 재확인(0.163.0-alpha.10.2): 관리자 모드 샌드박스가 실행마다 홈 아래 폴더에 샌드박스 계정 읽기 권한을 붙임. 읽기 제한 권한 프로필은 거부되고 deny는 무시됨, MXC는 Windows 11 24H2 이상 필요.",
     "currentPath": "기본값은 모든 팀이 Claude Code. Codex는 대장이 프로젝트 설정에서 다른 구독 사용(allowProviderSwitch)을 허락한 프로젝트에서만, 경고와 함께 실행 (개발팀의 어렵거나 위험한 작업, 사용량 한도 시 전환, 교차 검토).",
     "restorePlan": [
-      "Codex 팀 실행용 격리 환경을 마련한다 (작업 폴더만 보이는 별도 실행 공간 — 예: 전용 Windows 계정·WSL·컨테이너 중 이 PC에서 되는 것)",
-      "격리 환경에서 작업 폴더 밖 읽기가 막히는지 경계 시험을 자동 테스트로 만든다",
+      "[구축 완료 2026-10-18, 대장 승인] Codex 전용 WSL2 배포판 hq-codex(Debian 13): 드라이브 자동 연결·Windows 프로그램 실행·GPU 공유 끔, sudo 제거·root 잠금, 전용 사용자 hqcodex, Windows 폴더 공유 없이 작업별 파일 복사·반환(src/작업묶음.js), Codex Linux 샌드박스(bubblewrap) 읽기 제한 프로필. 준비 확인 15/15 (scripts/코덱스격리-준비.mjs). 근거 docs/codex-격리-복원.md",
+      "[통과 2026-10-18] WSL 경계 시험 test/코덱스격리.test.js: 밖 읽기·쓰기, 홈·인증정보(auth.json), 링크·/proc·drvfs·Windows 프로그램 우회, sudo, TCP·DNS 모두 막힘(대조 실험으로 시험 유효성 확인). 제한된 실모델 시험 1회 통과. 남은 검증: 동시 작업 분리, 작업 전 준비 확인 자동화. 지금의 Windows 샌드박스는 여전히 실패",
       "시험을 통과하면 보안팀·검증팀의 교차 검토를 Codex로 되돌리고, 개발팀의 어려운 작업에 Codex를 다시 배정한다",
       "대시보드에 프로젝트별 Codex 협업 켜기 스위치를 둔다 (지금은 API로만 켤 수 있음)"
     ],
-    "reviewBy": "2026-11-15"
+    "reviewBy": "2026-11-15",
+    "openIssues": [
+      "[추적 2026-10-18] Windows용 Codex 샌드박스가 홈 아래 폴더(.codex·.claude·OneDrive·Documents·AppData 등)에 CodexSandboxUsers 읽기 권한을 남김. 엔진 검사용 샌드박스(src/격리환경.js)가 계속 쓰는 동안 다시 붙음. 정리 계획 docs/codex-격리-복원.md 8절, 대장 승인 후 실행"
+    ]
   },
   "requiredTests": [
     "test/아키텍처가드.test.js",
@@ -39,7 +42,9 @@
     "test/작업배정.test.js",
     "test/안전경계.test.js",
     "test/스케줄러-팀.test.js",
-    "test/업무도메인.test.js"
+    "test/업무도메인.test.js",
+    "test/코덱스격리.test.js",
+    "test/작업묶음.test.js"
   ],
   "protectedFiles": [
     "AGENT_HQ_CONSTITUTION.md",
```

커밋할 때 대장 승인 표시가 필요하다: `AGENT_HQ_ARCH_APPROVED=대장`.

## 10. 대장에게 요청

1. **정책 갱신 승인 여부** — 9절 diff (복원 계획 1·2단계 완료 표시, Windows 권한 문제 추적 항목, 필수 테스트 2개 추가). `state`는 `suspended` 그대로. 승인하면 `AGENT_HQ_ARCH_APPROVED=대장`으로 커밋한다.
2. **팀 실행 연결 설계를 시작할지** — 복원 계획 3단계. 정상 실행 경로(`실행어댑터.js`·`목표실행.js`)를 바꾸는 핵심 설계 변경이라 별도 승인이 필요하다. 연결 전에 할 것: 작업 전 준비 확인 자동 실행(설정이 바뀌면 중단), 동시 작업 분리 시험, 돌려받은 파일을 프로젝트에 반영하는 규칙(기존 대장 규칙·완료 근거 그대로), 큰 프로젝트 복사·반환 속도 측정.
3. **Windows 폴더 권한 정리(8절) 시점** — 엔진 검사용 실행을 WSL로 옮기는 것과 함께 정할 것.

## 출처

- Codex 권한 프로필(`:minimal`·`:workspace_roots`·`deny`, `--sandbox`가 `default_permissions`를 무시함, 일반 모드는 일부 읽기 제한을 거부): https://learn.chatgpt.com/docs/permissions
- 설정 항목(`default_permissions`, `windows.sandbox = mxc | elevated | unelevated`): https://learn.chatgpt.com/docs/config-file/config-reference
- Windows 샌드박스(MXC 빌드 요구, 관리자 모드의 전용 계정·권한 경계·방화벽, WSL2 권장 상황): https://learn.chatgpt.com/codex/windows/windows-sandbox
- 샌드박스 개념(PowerShell은 Windows 샌드박스, WSL2는 Linux 샌드박스): https://learn.chatgpt.com/docs/sandboxing
- OpenAI 엔지니어링 글(기본 모드는 거의 어디든 읽기, 쓰기는 작업 폴더): https://openai.com/index/building-codex-windows-sandbox/
- WSL 설정(`wsl.conf`의 automount·interop·gpu·user, 수동 마운트는 여전히 가능, 8초 규칙·`wsl --terminate`): https://learn.microsoft.com/en-us/windows/wsl/wsl-config
- WSL 기업 환경(WSL 안의 셸은 같은 사용자의 PowerShell과 같은 권한, root여도 Windows 관리자 권한은 없음): https://learn.microsoft.com/en-us/windows/wsl/enterprise
- Codex Linux 샌드박스(bubblewrap, 읽기 제한 지원 — 공개 소스 미러, 설치 후 실측으로 확정): https://forge.lthn.ai/core/core-agent-ide/raw/branch/dev/codex-rs/linux-sandbox/README.md
