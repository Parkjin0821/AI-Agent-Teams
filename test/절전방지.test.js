import test from 'node:test';
import assert from 'node:assert/strict';
import { KeepAwake, awakeScript, needsAwake } from '../src/절전방지.js';

const now = Date.parse('2026-10-01T13:00:00Z');
const at = min => new Date(now + min * 60_000).toISOString();

test('the PC stays awake while a started project runs or is due soon, not while it waits for 대장 or the next day', () => {
  assert.equal(needsAwake([{ status: 'running' }], now), true);
  assert.equal(needsAwake([{ status: 'scheduled', autoRun: true, reason: null, nextRunAt: at(1) }], now), true);
  assert.equal(needsAwake([{ status: 'scheduled', autoRun: true, reason: null, nextRunAt: at(120) }], now), false, 'far off');
  assert.equal(needsAwake([{ status: 'scheduled', autoRun: true, reason: 'daily_cap', nextRunAt: at(1) }], now), false, 'step limit');
  assert.equal(needsAwake([{ status: 'scheduled', autoRun: false, reason: null, nextRunAt: at(1) }], now), false, 'not started by 대장');
  assert.equal(needsAwake([{ status: 'review_required', reason: 'needs_decision' }, { status: 'verified' }], now), false);
});

test('one keep-awake child at a time, gone when idle; nothing outside Windows; the child watches the server process', () => {
  const started = [];
  const fake = () => { const c = { killed: false, kill() { this.killed = true; }, on() {} }; started.push(c); return c; };
  const k = new KeepAwake({ platform: 'win32', start: fake });
  assert.equal(k.set(true), true);
  k.set(true);
  assert.equal(started.length, 1);
  assert.equal(k.set(false), false);
  assert.equal(started[0].killed, true);
  assert.equal(new KeepAwake({ platform: 'linux', start: fake }).set(true), false);
  assert.match(awakeScript(4242), /Get-Process -Id 4242[\s\S]*SetThreadExecutionState\(\[uint32\]'0x80000001'\)/);
});
