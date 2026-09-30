@echo off
rem AGENT HQ (real execution) on http://localhost:4314 - double-click to start.
rem The server runs in the background with no window of its own; this window closes by itself.
rem To stop it: stop-agent-hq.cmd. Starts and stops are written to data/real-test/server.log.
chcp 65001 >nul
cd /d "%~dp0"
node scripts/agent-hq.mjs start %*
if errorlevel 1 pause
