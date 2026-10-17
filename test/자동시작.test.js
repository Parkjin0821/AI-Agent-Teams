import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { autostartStatus, disableAutostart, enableAutostart, startupFile } from '../src/자동시작.js';

test('9차 5번: autostart is one file in the user\'s Startup folder that starts the server without opening a page', () => {
  const env = { APPDATA: mkdtempSync(path.join(tmpdir(), 'hq-auto-')) };
  const root = 'C:\\Users\\me\\AI-Agent-Teams', node = 'C:\\node\\node.exe';
  assert.equal(autostartStatus(env).on, false);
  const st = enableAutostart(root, env, node);
  assert.equal(st.on, true);
  assert.equal(st.root, root);
  assert.ok(st.file.endsWith(path.join('Start Menu', 'Programs', 'Startup', 'AGENT-HQ-자동시작.cmd')));
  const text = readFileSync(startupFile(env), 'utf8');
  assert.ok(text.includes('chcp 65001'));
  assert.ok(text.includes(`cd /d "${root}"`));
  assert.ok(text.includes(`"${node}" scripts\\에이전트-관리.mjs start --no-open`));
  assert.equal(disableAutostart(env).on, false);
  assert.equal(existsSync(startupFile(env)), false);
  assert.equal(autostartStatus({}).on, false, 'no APPDATA: nothing is written');
  assert.throws(() => enableAutostart('C:/x', {}), /APPDATA/);
});
