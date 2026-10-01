@echo off
rem Stops the AGENT HQ server started by 에이전트-시작.cmd.
chcp 65001 >nul
cd /d "%~dp0"
node scripts/에이전트-관리.mjs stop
timeout /t 3 >nul
