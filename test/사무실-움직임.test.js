import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 사무실 움직임 (디지털 오피스): the dashboard's own office code, run on its own — who walks where, for which event, and
// never twice for the same one. Walks come only from the engine's team.handoff records (by their stored ids).
const html = readFileSync(new URL('../outputs/대시보드.html', import.meta.url), 'utf8');
const start = html.indexOf('// ── 사무실 (2026-10-18');
const end = html.indexOf('class Component extends DCLogic');
assert.ok(start > 0 && end > start, 'office section found');
const SECTION = html.slice(start, end) + '\n;({ OFFICE, OFFICE_DESKS, OFFICE_ROOMS, OFFICE_CORRIDOR_Y, OFFICE_PAUSE, officePlay, officeWalkerAt, officeRoute, officeSeat, officeStand });';

function load({ motion = 'on' } = {}) {
  const store = { 'hq.officeMotion': motion };
  const ctx = vm.createContext({ Math, Date, Number, String, Array, Object, JSON, setTimeout: () => 0, requestAnimationFrame: () => 1,
    scheduleRender: () => {}, localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = v; } }, document: { querySelector: () => null } });
  return vm.runInContext(SECTION, ctx);
}
const ev = (id, from, to, extra = {}) => ({ type: 'team.handoff', id, from, to, projectId: 'p1', at: '2026-10-18T09:00:00Z', ...extra });

test('사무실: a walk goes out beside the desk, along the corridor and in beside the other desk — never through a desk', () => {
  const o = load();
  const r = o.officeRoute('dev', 'qa', o.officeSeat('dev'), o.officeStand('qa'));
  assert.deepEqual(r[0], o.officeSeat('dev'));
  assert.deepEqual(r.at(-1), o.officeStand('qa'));
  assert.ok(r.some(p => p[1] === o.OFFICE_CORRIDOR_Y), 'through the corridor');
  for (let i = 1; i < r.length; i++) assert.ok(r[i][0] === r[i - 1][0] || r[i][1] === r[i - 1][1], 'straight lines only (no diagonal across the room)');
  const lane = o.OFFICE_DESKS.dev[0] - 8;
  assert.equal(r[1][0], lane, 'leaves in the gap beside its own desk');
  for (const [id, x] of Object.entries(o.OFFICE_DESKS)) {
    for (const [other, y] of Object.entries(o.OFFICE_DESKS)) if (id !== other && x[1] === y[1]) assert.ok(Math.abs(x[0] - y[0]) >= 180, `${id} and ${other} do not overlap`);
  }
});

test('사무실: the paper goes out, is handed over at the desk, and the walk back is empty-handed', () => {
  const o = load();
  o.officePlay([], 0);
  o.officePlay([ev(7, 'research', 'dev')], 1000);
  const w = o.OFFICE.walkers[0];
  assert.equal(w.team, 'research');
  const at = t => o.officeWalkerAt(w, w.t0 + t);
  assert.deepEqual([at(0).x, at(0).y, at(0).carrying], [w.home[0], w.home[1], true]);
  assert.deepEqual([at(w.dur).x, at(w.dur).y], Array.from(w.there), 'at the other desk when the way out is done');
  assert.equal(at(w.dur + o.OFFICE_PAUSE / 2 + 10).handed, true);
  assert.equal(at(w.dur + o.OFFICE_PAUSE + 10).carrying, false);
  assert.equal(o.officeWalkerAt(w, w.end), null, 'back at the desk, the walk is over');
  assert.equal(at(w.dur / 2).step !== '', true, 'legs move while walking');
});

test('사무실: each hand-off walks once — not again for the same event, not after a reload, not for what came before the page', () => {
  const o = load();
  const before = [ev(1, 'plan', 'dev'), ev(2, 'dev', 'qa')];
  o.officePlay(before, 0);
  assert.equal(o.OFFICE.walkers.length, 0, 'records from before the page opened only set the starting point');
  o.officePlay([...before, ev(3, 'qa', 'plan')], 1000);
  o.officePlay([...before, ev(3, 'qa', 'plan')], 1500);
  o.officePlay([ev(3, 'qa', 'plan'), ev(3, 'qa', 'plan')], 2000);
  assert.deepEqual([o.OFFICE.seen, o.OFFICE.played], [1, 1], 'event 3 delivered three times, walked once');
  // a reload (or a server restart: ids are the engine's stored ones) starts from the newest record again
  const again = load();
  again.officePlay([...before, ev(3, 'qa', 'plan')], 0);
  again.officePlay([...before, ev(3, 'qa', 'plan')], 1000);
  assert.equal(again.OFFICE.played, 0, 'nothing replayed after a reload');
  again.officePlay([ev(4, 'plan', 'design')], 2000);
  assert.equal(again.OFFICE.played, 1);
  // not a hand-off, or no id: no walk
  again.officePlay([{ type: 'team.handoff', from: 'dev', to: 'qa' }, { ...ev(9, 'dev', 'qa'), type: 'goal.verified' }], 3000);
  assert.equal(again.OFFICE.played, 1);
});

test('사무실: asking 대장 walks to 대장\'s desk (and the answer is carried back by the team); motion off shows it in words only', () => {
  const o = load();
  o.officePlay([], 0);
  o.officePlay([ev(5, 'qa', 'boss'), ev(6, 'boss', 'plan')], 1000);
  const [up, down] = o.OFFICE.walkers;
  assert.deepEqual([up.team, up.to], ['qa', 'boss']);
  assert.deepEqual(up.there, o.officeStand('boss', 'qa'));
  assert.deepEqual([down.team, down.to], ['plan', 'boss'], 'the team that takes 대장\'s answer goes to fetch it');
  const still = load({ motion: 'off' });
  still.officePlay([], 0);
  still.officePlay([ev(8, 'dev', 'qa')], 1000);
  assert.deepEqual([still.OFFICE.walkers.length, still.OFFICE.notes.length, still.OFFICE.seen], [0, 1, 1], 'a notice, nobody walks');
});
