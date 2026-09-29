import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { childEnv, resolveBins } from './adapters.js';
import { STOP_AT_REMAINING } from './policy.js';
import path from 'node:path';

// Limit state Claude Code reported during team runs (status only, no percentages), kept per window.
const LIMIT_FILE = 'claude-limit-status.json';
const limitWrites = new Map();
export function recordRateLimits(dataDir, limits, now = Date.now()) {
  const key = path.resolve(dataDir);
  const pending = (limitWrites.get(key) ?? Promise.resolve()).catch(() => {}).then(() => writeRateLimits(key, limits, now));
  limitWrites.set(key, pending);
  void pending.finally(() => { if (limitWrites.get(key) === pending) limitWrites.delete(key); }).catch(() => {});
  return pending;
}
async function writeRateLimits(dataDir, limits, now) {
  if (!Array.isArray(limits) || !limits.length) return;
  let saved = {};
  try { saved = JSON.parse(await readFile(`${dataDir}/${LIMIT_FILE}`, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const at = new Date(now).toISOString();
  const severity = s => s === 'rejected' ? 3 : s === 'allowed_warning' ? 2 : s === 'allowed' ? 0 : 1;
  for (const l of limits) {
    const previous = saved[l.window];
    const active = previous && (!previous.resetsAt || Date.parse(previous.resetsAt) > now);
    saved[l.window] = { status: active && severity(previous.status) > severity(l.status) ? previous.status : l.status,
      resetsAt: active && severity(previous.status) > severity(l.status) ? previous.resetsAt : l.resetsAt,
      usingOverage: l.usingOverage === true || (active && previous.usingOverage === true), observedAt: at };
  }
  await mkdir(dataDir, { recursive: true });
  const temp = `${dataDir}/${LIMIT_FILE}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(saved));
  await rename(temp, `${dataDir}/${LIMIT_FILE}`);
}

async function readLimitStatus(dataDir, now) {
  try {
    const saved = JSON.parse(await readFile(`${dataDir}/${LIMIT_FILE}`, 'utf8'));
    // A window whose reset time has passed no longer says anything about now.
    return Object.entries(saved).filter(([, v]) => !v.resetsAt || Date.parse(v.resetsAt) > now)
      .map(([window, v]) => ({ window, ...v }));
  } catch { return []; }
}

// 대장's rule: stop starting new rounds once the 5-hour window has 20% or less left, or the weekly
// window 10% or less — past that a run can be cut off at any moment.
export { STOP_AT_REMAINING } from './policy.js';

export function normalizeUsage(provider, data, now = Date.now()) {
  const windows = [];
  const add = (period, used, reset) => {
    if (!Number.isFinite(used) || used < 0 || used > 100 || !Number.isFinite(reset) || reset * 1000 <= now) return;
    const remaining = 100 - used;
    windows.push({ period, used, remaining, resetAt: new Date(reset * 1000).toISOString(),
      stopAt: STOP_AT_REMAINING[period], blocked: remaining <= STOP_AT_REMAINING[period] });
  };
  if (provider === 'claude') {
    for (const [key, period] of [['five_hour', 'five_hour'], ['seven_day', 'weekly']]) {
      const w = data.rate_limits?.[key]; add(period, w?.used_percentage, w?.resets_at);
    }
  } else {
    const limits = data.rateLimitsByLimitId?.codex ?? data.rateLimits;
    for (const w of [limits?.primary, limits?.secondary]) {
      if (w?.windowDurationMins === 300) add('five_hour', w.usedPercent, w.resetsAt);
      else if (w?.windowDurationMins === 10080) add('weekly', w.usedPercent, w.resetsAt);
    }
  }
  return { provider, windows, tokens: null, observedAt: new Date(now).toISOString(),
    source: provider === 'codex' ? 'Codex App Server' : 'Claude Code statusLine' };
}

// Read-only RPCs: never starts a model turn or accesses credential files.
export function readCodexUsage(timeoutMs = 15000) {
  const bin = resolveBins().codex;
  return new Promise((resolve, reject) => {
    const child = spawn(bin.file, [...bin.prefix, 'app-server', '--stdio'], { env: childEnv(), shell: false, windowsHide: true });
    let done = false, result;
    const finish = (err) => { if (done) return; done = true; clearTimeout(timer); lines.close(); child.kill(); err ? reject(err) : resolve(result); };
    const timer = setTimeout(() => finish(new Error('Codex usage query timed out')), timeoutMs);
    const lines = createInterface({ input: child.stdout });
    child.stderr.resume();
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    child.stdin.on('error', () => finish(new Error('Codex usage connection closed')));
    child.on('error', () => finish(new Error('Codex CLI unavailable')));
    child.on('close', () => { if (!done) finish(new Error('Codex usage query exited')); });
    lines.on('line', line => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.error && [0,1,2].includes(msg.id)) {
        if (msg.id === 2) return finish();
        return finish(new Error('Codex official usage query failed; check login'));
      }
      if (msg.id === 0) { send({ method: 'initialized' }); send({ id: 1, method: 'account/rateLimits/read' }); }
      if (msg.id === 1) { result = normalizeUsage('codex', msg.result ?? {}); finish(); }
    });
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'agent_hq_usage', version: '0.1.0' } } });
  });
}

// Claude only reports usage to the status line of an interactive session, so the last value can be old.
// It is still shown, with its age: windows whose reset time has passed are dropped by normalizeUsage.
export async function readClaudeUsage(dataDir, now = Date.now()) {
  const claude = { provider: 'claude', windows: [], tokens: null, source: 'Claude Code statusLine', stale: false,
    note: '터미널에서 Claude Code 응답을 한 번 받으면 표시됩니다 · 미수집' };
  try {
    const saved = JSON.parse(await readFile(`${dataDir}/claude-usage.json`, 'utf8'));
    const age = now - Date.parse(saved.observedAt);
    if (age >= 0) {
      const minutes = Math.floor(age / 60_000);
      const stale = age > 300_000;
      Object.assign(claude, normalizeUsage('claude', saved, now), { observedAt: saved.observedAt, stale,
        note: stale ? `${minutes < 60 ? `${minutes}분` : `${Math.floor(minutes / 60)}시간`} 전 값 · 참고용 (터미널 Claude Code 응답 때마다 갱신)` : '' });
      if (!claude.windows.length) claude.note = '마지막 수집값의 한도 기간이 초기화됨 · 새 응답 필요';
    }
  } catch { /* no official statusLine snapshot yet */ }
  claude.limitStatus = await readLimitStatus(dataDir, now);
  return claude;
}

export async function readUsage(dataDir) {
  const claude = await readClaudeUsage(dataDir);
  let codex;
  try { codex = await readCodexUsage(); } catch (error) { codex = { provider: 'codex', windows: [], tokens: null, note: error.message, source: 'Codex App Server' }; }
  return { items: [claude, codex] };
}
