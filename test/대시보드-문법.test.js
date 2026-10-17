import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 2026-10-18: a confirm message's "\n" was written as real line breaks inside a quoted string, so the whole dashboard
// script failed to parse and the page stayed blank. Every inline script must at least compile.
test('대시보드: every inline script in the dashboard compiles', () => {
  const html = readFileSync(new URL('../outputs/대시보드.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.trim());
  assert.ok(scripts.length > 0);
  for (const [i, code] of scripts.entries()) assert.doesNotThrow(() => new vm.Script(code, { filename: `대시보드-script-${i}.js` }));
});
