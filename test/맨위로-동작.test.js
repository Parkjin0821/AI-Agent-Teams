import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../outputs/대시보드.html', import.meta.url), 'utf8');
const code = html.slice(html.indexOf('// 맨 위로: outside #app')).split('</script>')[0];
function setup(reduce = false) {
  const events = {}, buttonEvents = {}, frames = new Map(), positions = [], style = { scrollBehavior: '' };
  let serial = 0;
  const window = { scrollY: 2000, matchMedia: () => ({ matches: reduce }),
    addEventListener: (name, callback) => { events[name] = callback; },
    scrollTo: ({ top }) => { positions.push(top); window.scrollY = top; } };
  const button = { classList: { toggle() {} }, setAttribute() {}, addEventListener: (name, callback) => { buttonEvents[name] = callback; } };
  vm.runInNewContext(code, { window, document: { documentElement: { style }, getElementById: () => button },
    performance: { now: () => 0 }, requestAnimationFrame: cb => { frames.set(++serial, cb); return serial; }, cancelAnimationFrame: id => frames.delete(id) });
  const tick = time => { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(time); };
  return { events, click: buttonEvents.click, frames, positions, style, tick };
}
test('scroll to top eases out and restores the original scroll behavior', () => {
  const s = setup(); s.click();
  s.tick(0); s.tick(105); s.tick(210); s.tick(315); s.tick(420);
  assert.equal(s.positions[0], 2000);
  assert.equal(s.positions.at(-1), 0);
  const distances = s.positions.slice(1).map((p, i) => s.positions[i] - p);
  assert.ok(distances.every((d, i) => i === 0 || d < distances[i - 1]));
  assert.equal(s.frames.size, 0);
  assert.equal(s.style.scrollBehavior, '');
});
test('manual scrolling cancels the animation and reduced motion jumps without animation', () => {
  const s = setup(); s.click(); s.events.wheel();
  assert.equal(s.frames.size, 0);
  assert.equal(s.style.scrollBehavior, '');
  const reduced = setup(true); reduced.click();
  assert.deepEqual(reduced.positions, [0]);
  assert.equal(reduced.frames.size, 0);
  assert.equal(reduced.style.scrollBehavior, '');
});
