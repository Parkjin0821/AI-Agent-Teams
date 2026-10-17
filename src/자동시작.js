import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// 자동 시작 (9차 5번): AGENT HQ starts by itself when 대장 signs in to Windows, from the user's own Startup folder
// (no administrator, no service, no system setting). With 재시작 복구 the work cut off by a reboot then goes on.
// Turned on and off only by 대장 (node scripts/에이전트-관리.mjs autostart on|off), never by the engine.
export const STARTUP_NAME = 'AGENT-HQ-자동시작.cmd';

export function startupFile(env = process.env) {
  if (!env.APPDATA) return null;
  return path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', STARTUP_NAME);
}

// The file the Startup folder runs: start the server with no page opened (the start script does nothing if it runs).
export function startupScript(root, nodePath = process.execPath) {
  return ['@echo off', 'rem AGENT HQ 자동 시작 - 끄려면: node scripts\\에이전트-관리.mjs autostart off', 'chcp 65001 >nul',
    `cd /d "${root}"`, `"${nodePath}" scripts\\에이전트-관리.mjs start --no-open`, ''].join('\r\n');
}

export function autostartStatus(env = process.env) {
  const file = startupFile(env);
  if (!file) return { on: false, file: null, note: 'APPDATA 를 몰라 확인할 수 없음' };
  if (!existsSync(file)) return { on: false, file };
  const text = readFileSync(file, 'utf8');
  return { on: true, file, root: /cd \/d "([^"]+)"/.exec(text)?.[1] ?? null };
}

export function enableAutostart(root, env = process.env, nodePath = process.execPath) {
  const file = startupFile(env);
  if (!file) throw new Error('APPDATA 를 몰라 시작 프로그램 폴더를 찾을 수 없음');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, startupScript(root, nodePath), 'utf8');
  return autostartStatus(env);
}

export function disableAutostart(env = process.env) {
  const file = startupFile(env);
  if (file && existsSync(file)) rmSync(file);
  return autostartStatus(env);
}
