@echo off
rem Stops the AGENT HQ server started by start-agent-hq.cmd.
chcp 65001 >nul
cd /d "%~dp0"
node scripts/agent-hq.mjs stop
timeout /t 3 >nul
