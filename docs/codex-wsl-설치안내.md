# Codex 격리용 WSL2 설치 안내 (대장이 직접 따라 하는 순서)

_2026-10-18 · 근거와 설계: `docs/codex-격리-복원.md`. 이 순서는 AGENT HQ의 지금 실행 경로(Claude Code 팀, 서버)를 바꾸지 않는다._

AI가 하지 않는 일: 관리자 권한 설치, 재부팅, Codex 로그인, 보호 파일 변경. 아래 ①~③·⑤는 대장이 직접 한다.
④는 대장이 하거나, "설치 끝" 이라고 알려 주면 AI 세션이 실행한다(배포판 안에서만 바꾸고 Windows 관리자 권한은 쓰지 않는다).

## 0. 설치 전 확인 (2026-10-18, 관리자 권한 없이 확인 완료)

| 항목 | 이 PC | 필요 조건 |
|---|---|---|
| Windows | 11 Education 23H2, build 22631 | WSL2: build 19041 이상 ✓ |
| CPU 가상화 (펌웨어) | 켜짐 | 켜짐 ✓ |
| 하이퍼바이저 | 동작 중 | — |
| RAM / C: 여유 | 31.9GB / 약 390GB | 배포판 1~2GB ✓ |
| WSL | **미설치** (`wsl.exe`가 설치 안내만 출력, WSL 서비스 없음) | 설치 필요 |
| Docker·Podman·Windows Sandbox | 없음 | 쓰지 않음 |

## ① WSL 설치 — **관리자 PowerShell**, 재부팅 필요할 수 있음

시작 메뉴에서 "PowerShell" → 오른쪽 클릭 → **관리자 권한으로 실행**:

```
wsl --install --no-distribution
```

- 배포판은 아직 설치하지 않는다(`--no-distribution`). Microsoft Store가 막혀 있으면 `wsl --install --no-distribution --web-download`.
- "다시 시작해야 합니다" 가 나오면 **재부팅**한다. (Virtual Machine Platform 기능이 켜짐 — 시스템 변경)
- 확인 (재부팅 후, 일반 PowerShell): `wsl --version` → `WSL 버전: 2.x` 가 보이면 됨.

## ② (권장) WSL 전체 설정 — 일반 PowerShell

WSL의 그래픽 앱 기능(WSLg)은 Codex에 필요 없고 Windows 쪽과 통로가 하나 더 생기므로 끈다. `%UserProfile%\.wslconfig` 파일에 다음 두 줄:

```
[wsl2]
guiApplications=false
```

이 파일은 이 PC의 모든 WSL 배포판에 적용된다(지금은 이번에 만들 배포판 하나뿐). 건너뛰어도 아래 시험은 돌아간다.

## ③ 전용 배포판 설치 — 일반 PowerShell (관리자 아님)

```
wsl --install Debian --name hq-codex --no-launch
```

- Store가 막혀 있으면 끝에 `--web-download`.
- `--no-launch`: 처음 실행 때 나오는 "사용자 이름/비밀번호 만들기"를 하지 않는다. **혹시 그 질문이 나오면 만들지 말고 창을 닫는다** (sudo 권한 사용자가 생기기 때문).
- 확인: `wsl -l -v` → `hq-codex  Stopped  2` (VERSION 2).
- Debian을 고른 이유: 기본에 sudo가 없고 설치 크기가 작다.
- `--name` 을 모른다는 오류가 나면(옛 WSL) 이름을 바꿔 들여온다:
  `wsl --install -d Debian --no-launch` → `wsl --export Debian $env:TEMP\debian.tar` →
  `wsl --import hq-codex $env:LOCALAPPDATA\hq-codex $env:TEMP\debian.tar` → `wsl --unregister Debian` → `del $env:TEMP\debian.tar`

## ④ 배포판 준비 — 일반 PowerShell, 리포 폴더에서 (대장 승인: Node.js·Codex CLI·bubblewrap 설치)

```
cd <AI-Agent-Teams 리포 폴더>
node scripts/코덱스격리-준비.mjs --provision
```

배포판 안에서 root로 하는 일 (Windows 쪽은 바꾸지 않음):

- `apt-get install` : `bubblewrap`, `nodejs`, `npm`, `ca-certificates`, `tar` (Debian 공식 저장소)
- `npm install -g @openai/codex@0.163.0` (버전 고정)
- 작업 전용 사용자 `hqcodex` 생성 — **비밀번호 잠금, sudo 없음**, 홈 `/home/hqcodex` 권한 700. **root 비밀번호도 잠금.**
- 작업 폴더 뿌리 `/srv/hq/jobs` (hqcodex 소유, 700)
- `/etc/wsl.conf` : 드라이브 자동 연결 끔·`/etc/fstab` 처리 끔·Windows 프로그램 실행 끔·Windows PATH 끔·GPU 드라이버 공유 끔·기본 사용자 hqcodex
- 끝나면 `wsl --terminate hq-codex` 로 배포판만 껐다 켜서 설정을 적용하고 ⑥의 확인을 바로 돌린다.

## ⑤ Codex 로그인 — **대장이 직접** (ChatGPT 구독, API 키 쓰지 않음)

```
wsl -d hq-codex -u hqcodex --cd ~ -- codex login --device-auth
```

화면에 나온 주소를 Windows 브라우저로 열고 코드를 넣어 ChatGPT 계정으로 승인한다. 로그인 정보는 배포판 안 `/home/hqcodex/.codex/` 에만 저장된다.
Windows 쪽 `.codex` 폴더를 복사해 넣지 않는다.

## ⑥ 확인 — 일반 PowerShell

```
node scripts/코덱스격리-준비.mjs
```

모든 줄이 ✓ 여야 한다: 배포판 실행, wsl.conf, `/mnt/c` 없음, Windows 프로그램 연동 꺼짐, PATH에 Windows 프로그램 없음, sudo 없음, root 잠김,
관리 그룹 없음, `/srv/hq/jobs` 700, 홈 700, bubblewrap, node, codex 0.163.0, 로그인 = ChatGPT 구독(출력 내용은 보여 주지 않고 판정만).

## ⑦ 그다음 (AI 세션이 함)

1. 경계 시험 (모델 호출 없음): `AGENT_HQ_CODEX_ISOLATION_TEST=wsl` 로 `node --test test/코덱스격리.test.js`
2. 통과하면 제한된 실모델 시험 1회 (`AGENT_HQ_CODEX_ISOLATION_EXEC=1`, effort low, 구독 사용량 소량)
3. 결과 보고 → 대장이 정책 갱신·팀 연결 여부 결정

## 되돌리기

배포판만 지우면 된다 (안의 로그인 정보·작업 폴더도 함께 사라짐): `wsl --unregister hq-codex`.
WSL 자체를 지우려면 설정 → 앱에서 "Windows Subsystem for Linux" 제거.
