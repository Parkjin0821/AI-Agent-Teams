@echo off
rem AGENT HQ (real execution) on http://localhost:4314 - double-click to start.
rem Runs on its own: no Claude Code chat or Codex app needs to stay open.
rem This window is the server: minimize it to keep AGENT HQ running, close it to stop.
chcp 65001 >nul
title AGENT HQ - 실제 실행 (4314)
cd /d "%~dp0"

rem Already running? Just open the page.
curl -s -o nul -m 2 http://127.0.0.1:4314/ && (
  echo AGENT HQ가 이미 켜져 있습니다. 페이지를 엽니다.
  start "" http://localhost:4314
  timeout /t 3 >nul
  exit /b 0
)

set AGENT_HQ_ENABLE_EXEC=1
set AGENT_HQ_DATA_DIR=data\real-test
set PORT=4314
rem Open the page once the server is up.
start "" /b cmd /c "timeout /t 3 >nul & start "" http://localhost:4314"
node src\server.js
echo.
echo AGENT HQ가 멈췄습니다. 창을 닫거나 아무 키나 누르세요.
pause >nul
