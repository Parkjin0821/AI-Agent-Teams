import { spawn } from 'node:child_process';

// 절전 방지: while a team step runs or is due, Windows must not idle-sleep (the re-tests of 2026-10-01 needed a
// keep-awake script started by hand). A small PowerShell child asks for ES_SYSTEM_REQUIRED every minute and lets go
// when it exits; no power setting is changed, and closing the lid or choosing Sleep still sleeps the PC.
// It also ends on its own once the server process is gone (a restart must not leave the PC awake for good).
export const awakeScript = (ownerPid = process.pid) => [
  "Add-Type -Namespace Hq -Name Awake -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
  `while (Get-Process -Id ${Number(ownerPid)} -ErrorAction SilentlyContinue) { [Hq.Awake]::SetThreadExecutionState([uint32]'0x80000001') | Out-Null; Start-Sleep -Seconds 60 }`,
].join('; ');

// A goal keeps the PC awake while it runs, or while it is due to run on its own soon (not held for 대장, not at
// the day's step limit).
export function needsAwake(goals, now, withinMs = 15 * 60_000) {
  return goals.some(g => g.status === 'running' || (g.status === 'scheduled' && g.autoRun === true && !g.reason
    && (!g.nextRunAt || Date.parse(g.nextRunAt) - now <= withinMs)));
}

export class KeepAwake {
  constructor({ platform = process.platform, start = () => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', awakeScript()],
    { stdio: 'ignore', windowsHide: true }) } = {}) {
    Object.assign(this, { platform, start, child: null });
  }
  get on() { return Boolean(this.child); }
  set(active) {
    if (this.platform !== 'win32') return false;
    if (active && !this.child) {
      try {
        this.child = this.start();
        this.child.on?.('exit', () => { this.child = null; });
        this.child.on?.('error', () => { this.child = null; });
      } catch { this.child = null; }
    } else if (!active && this.child) { try { this.child.kill(); } catch { /* already gone */ } this.child = null; }
    return this.on;
  }
}
