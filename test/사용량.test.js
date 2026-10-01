import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage } from '../src/사용량.js';
test('concurrent limit records preserve every window and never erase active rejection', async () => {
  const { recordRateLimits } = await import('../src/사용량.js');
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(`${tmpdir()}/hq-limits-`);
  const resetsAt = new Date(Date.now() + 3600000).toISOString();
  await Promise.all(Array.from({ length: 20 }, (_, i) => recordRateLimits(dir,
    [{ window: `window-${i}`, status: 'rejected', resetsAt, usingOverage: true }])));
  let saved = JSON.parse(readFileSync(`${dir}/claude-limit-status.json`, 'utf8'));
  assert.equal(Object.keys(saved).length, 20);
  await recordRateLimits(dir, [{ window: 'window-0', status: 'allowed', resetsAt, usingOverage: false }]);
  saved = JSON.parse(readFileSync(`${dir}/claude-limit-status.json`, 'utf8'));
  assert.equal(saved['window-0'].status, 'rejected');
  assert.equal(saved['window-0'].usingOverage, true);
});
test('official percentages become remaining windows without inventing token counts', () => {
  const now = Date.now();
  const resets = Math.floor(now / 1000) + 3600;
  const c = normalizeUsage('codex', { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: resets } } }, now);
  assert.equal(c.windows[0].remaining, 75);
  assert.equal(c.windows[0].period, 'five_hour');
  assert.equal(c.tokens, null);
  const a = normalizeUsage('claude', { rate_limits: { seven_day: { used_percentage: 90, resets_at: resets } } }, now);
  assert.equal(a.windows[0].remaining, 10);
  assert.equal(a.windows[0].blocked, true);
  assert.deepEqual(normalizeUsage('claude', { rate_limits: { five_hour: { used_percentage: 120, resets_at: resets } } }, now).windows, []);
  assert.deepEqual(normalizeUsage('claude', { rate_limits: { five_hour: { used_percentage: 20, resets_at: 1 } } }, now).windows, []);
});

test('an old Claude reading is still shown with its age; a reading whose window has reset is not', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { readClaudeUsage } = await import('../src/사용량.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'hq-usage-'));
  const now = Date.parse('2026-09-29T01:00:00Z');
  const save = (observedAt, resetsAt) => writeFileSync(path.join(dir, 'claude-usage.json'), JSON.stringify({ observedAt,
    rate_limits: { five_hour: { used_percentage: 10, resets_at: resetsAt }, seven_day: { used_percentage: 30, resets_at: resetsAt + 86400 } } }));
  assert.match((await readClaudeUsage(dir, now)).note, /미수집/);
  save('2026-09-29T00:58:00Z', now / 1000 + 3600);
  const fresh = await readClaudeUsage(dir, now);
  assert.deepEqual([fresh.stale, fresh.note, fresh.windows.map(w => w.remaining)], [false, '', [90, 70]]);
  save('2026-09-29T00:33:00Z', now / 1000 + 3600);
  const old = await readClaudeUsage(dir, now);
  assert.deepEqual([old.stale, old.windows.length], [true, 2]);
  assert.match(old.note, /^27분 전 값/);
  save('2026-09-28T20:00:00Z', now / 1000 - 60);
  const reset = await readClaudeUsage(dir, now);
  assert.deepEqual(reset.windows.map(w => w.period), ['weekly'], 'the 5-hour window already reset, so it is dropped');
});
test('limit states from team runs are kept per window, and a window past its reset is dropped', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { readClaudeUsage, recordRateLimits } = await import('../src/사용량.js');
  const { rateLimitFrom } = await import('../src/실행어댑터.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'hq-limit-'));
  const now = Date.parse('2026-09-29T01:00:00Z');
  const event = (type, status, resetsAt) => ({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt, rateLimitType: type, overageStatus: 'allowed', isUsingOverage: false } });
  assert.deepEqual(rateLimitFrom(event('five_hour', 'allowed', now / 1000 + 3600)),
    { window: 'five_hour', status: 'allowed', resetsAt: '2026-09-29T02:00:00.000Z', usingOverage: false });
  assert.equal(rateLimitFrom({ type: 'result', result: 'x' }), null);
  assert.equal(rateLimitFrom({ type: 'rate_limit_event', rate_limit_info: { status: 1 } }), null);
  await recordRateLimits(dir, [rateLimitFrom(event('five_hour', 'allowed', now / 1000 + 3600)), rateLimitFrom(event('seven_day', 'allowed', now / 1000 - 60))], now - 60_000);
  await recordRateLimits(dir, [rateLimitFrom(event('five_hour', 'allowed_warning', now / 1000 + 3600))], now);
  const c = await readClaudeUsage(dir, now);
  assert.deepEqual(c.limitStatus.map(l => [l.window, l.status]), [['five_hour', 'allowed_warning']], 'latest state wins; the reset weekly window is gone');
  assert.equal(c.windows.length, 0, 'status never invents percentages');
});
test('newer Claude Code runs report percentages too; the newest of runs and the status line is shown', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { readClaudeUsage, recordRateLimits } = await import('../src/사용량.js');
  const { rateLimitFrom } = await import('../src/실행어댑터.js');
  const dir = mkdtempSync(path.join(tmpdir(), 'hq-runusage-'));
  const now = Date.parse('2026-10-01T05:00:00Z'), r5 = now / 1000 + 3600, r7 = now / 1000 + 86400;
  // The shape Claude Code 2.1.284 printed in a real run (2026-10-01).
  const event = { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: r5, rateLimitType: 'five_hour', isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.04, resetsAt: r5 }, seven_day: { utilization: 0.75, resetsAt: r7 } } } };
  const limit = rateLimitFrom(event);
  assert.deepEqual(limit.usage, { five_hour: { used_percentage: 4, resets_at: r5 }, seven_day: { used_percentage: 75, resets_at: r7 } });
  assert.equal(rateLimitFrom({ ...event, rate_limit_info: { ...event.rate_limit_info, unifiedWindows: { five_hour: { utilization: 7, resetsAt: r5 } } } }).usage, undefined,
    'a value outside 0–1 is not trusted');
  // An old status line reading (two days before) loses to the run's.
  writeFileSync(path.join(dir, 'claude-usage.json'), JSON.stringify({ observedAt: '2026-09-29T06:41:00Z',
    rate_limits: { seven_day: { used_percentage: 37, resets_at: r7 } } }));
  await recordRateLimits(dir, [limit], now - 60_000);
  const c = await readClaudeUsage(dir, now);
  assert.deepEqual([c.source, c.stale, c.windows.map(w => [w.period, w.remaining])], ['Claude Code 팀 실행 응답', false, [['five_hour', 96], ['weekly', 25]]]);
  // A later terminal reading wins again.
  writeFileSync(path.join(dir, 'claude-usage.json'), JSON.stringify({ observedAt: '2026-10-01T04:59:30Z',
    rate_limits: { seven_day: { used_percentage: 76, resets_at: r7 } } }));
  assert.deepEqual((await readClaudeUsage(dir, now)).windows.map(w => w.remaining), [24]);
});
test('rounds stop at 20% left in the 5-hour window and 10% left in the weekly window (Claude weekly: 15%)', async () => {
  const { normalizeUsage, STOP_AT_REMAINING } = await import('../src/사용량.js');
  assert.deepEqual({ ...STOP_AT_REMAINING }, { five_hour: 20, weekly: 10 });
  const now = Date.now(), reset = Math.floor(now / 1000) + 3600;
  const blocked = (key, used) => normalizeUsage('claude', { rate_limits: { [key]: { used_percentage: used, resets_at: reset } } }, now).windows[0].blocked;
  assert.deepEqual([blocked('five_hour', 79), blocked('five_hour', 80), blocked('seven_day', 84), blocked('seven_day', 85)], [false, true, false, true], 'Claude weekly line is 15% (대장, 2026-10-01)');
  const codex = normalizeUsage('codex', { rateLimits: { primary: { usedPercent: 81, windowDurationMins: 300, resetsAt: reset } } }, now);
  assert.equal(codex.windows[0].blocked, true, 'the same rule applies to Codex');
});
