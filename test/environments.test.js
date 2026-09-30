import test from 'node:test';
import assert from 'node:assert/strict';
import { designConnectors, ENVIRONMENTS, environmentView, EnvironmentMonitor, parseMcpList, SETTINGS, validateSetting } from '../src/environments.js';

const MCP_LIST = [
  'Checking MCP server health…', '',
  'claude.ai Figma: https://mcp.figma.com/mcp - ✔ Connected',
  'claude.ai Canva: https://mcp.canva.com/mcp - ✔ Connected',
  'claude.ai higgsfield: https://mcp.higgsfield.ai/mcp - ✔ Connected',
  'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ! Needs authentication',
  'local-thing: node server.js - ✔ Connected',
].join('\n');

test('the claude.ai connector list is parsed from `claude mcp list`', () => {
  assert.deepEqual(parseMcpList(MCP_LIST), [
    { name: 'Figma', status: 'connected' }, { name: 'Canva', status: 'connected' },
    { name: 'higgsfield', status: 'connected' }, { name: 'Gmail', status: 'needs-auth' }]);
});

const snapshot = { checkedAt: '2026-09-28T10:00:00Z', claude: { installed: true, loggedIn: true }, codex: { installed: true, loggedIn: true },
  connectors: parseMcpList(MCP_LIST), apiKeys: { PERPLEXITY_API_KEY: false, OPENAI_API_KEY: true } };

test('fresh auth lookup revokes cached subscription approval for API-key login or failed commands', async () => {
  let failed = false;
  const monitor = new EnvironmentMonitor({ bins: { claude: { file: 'claude', prefix: [] }, codex: { file: 'codex', prefix: [] } },
    run: async file => failed ? { code: 1, stdout: '' } : file === 'claude'
      ? { code: 0, stdout: '{"loggedIn":true,"authMethod":"api_key"}' }
      : { code: 0, stdout: 'Logged in using an API key' } });
  monitor.snapshot = { claude: { subscription: true }, codex: { subscription: true } };
  const fresh = await monitor.refreshAuthentication();
  assert.equal(fresh.claude.subscription, false);
  assert.equal(fresh.codex.subscription, false);
  failed = true;
  const rejected = await monitor.refreshAuthentication();
  assert.equal(rejected.claude.loggedIn, false);
  assert.equal(rejected.codex.loggedIn, false);
});

test('design connectors are used only when 대장 turned them on and they are connected', () => {
  assert.deepEqual(designConnectors(snapshot, {}), [], 'all off by default');
  assert.deepEqual(designConnectors(snapshot, { 'design.figma': true, 'design.higgsfield': true }), ['Figma']);
  const figmaDown = { ...snapshot, connectors: [{ name: 'Figma', status: 'needs-auth' }] };
  assert.deepEqual(designConnectors(figmaDown, { 'design.figma': true }), []);
  assert.deepEqual(designConnectors(null, { 'design.figma': true }), []);
});

test('every environment gets an honest status, billing and who uses it', () => {
  const view = environmentView(snapshot, { 'design.canva': true });
  const by = Object.fromEntries(view.map(v => [v.id, v]));
  assert.equal(by['claude-code'].statusL, '연결됨');
  assert.equal(by.web.statusL, '사용 가능');
  assert.deepEqual([by.figma.statusL, by.figma.enabled], ['연결됨 · 꺼짐', false]);
  assert.deepEqual([by.canva.statusL, by.canva.enabled], ['연결됨 · 디자인팀 사용', true]);
  assert.equal(by.perplexity.statusL, '구독 전용 정책으로 차단');
  assert.equal(by['openai-images'].statusL, '구독 전용 정책으로 차단');
  assert.equal(by.higgsfield.enabled, false);
  assert.equal(by.midjourney.statusL, '연결 불가');
  assert.match(by.midjourney.note, /공식 API/);
  for (const env of ENVIRONMENTS) assert.ok(env.docs.startsWith('https://'), `${env.id} links official docs`);
  assert.equal(environmentView(null, {})[0].statusL, '확인 전');
});

test('only known settings with the right type are accepted', () => {
  assert.deepEqual(Object.keys(SETTINGS), ['design.figma', 'design.canva', 'design.higgsfield', 'tools.npmAudit', 'limits.maxRoundsPerDay', 'limits.autoSwitch', 'sentinel.web', 'trust.required',
    'digest.time', 'digest.daily', 'digest.weekly', 'attach.maxMB']);
  assert.equal(validateSetting('attach.maxMB', 100), 100);
  for (const bad of [0, 101, 2.5]) assert.throws(() => validateSetting('attach.maxMB', bad), /1 to 100/, String(bad));
  assert.equal(validateSetting('digest.time', '18:30'), '18:30');
  for (const bad of ['9:00', '24:00', '18:60', 'noon']) assert.throws(() => validateSetting('digest.time', bad), /wrong format/, bad);
  assert.throws(() => validateSetting('digest.weekly', 'monday'), /one of off, mon/);
  assert.equal(validateSetting('sentinel.web', 'open'), 'open');
  assert.throws(() => validateSetting('sentinel.web', 'anything'), /one of ask, open/);
  assert.equal(validateSetting('trust.required', 0), 0, 'trust reviews can be switched off');
  assert.throws(() => validateSetting('trust.required', 11), /0 to 10/);
  assert.equal(validateSetting('limits.maxRoundsPerDay', 25), 25);
  for (const bad of [0, 101, 2.5, '10']) assert.throws(() => validateSetting('limits.maxRoundsPerDay', bad), /limits\.maxRoundsPerDay/, String(bad));
  assert.equal(validateSetting('design.figma', true), true);
  assert.throws(() => validateSetting('design.higgsfield', true), /subscription-only/);
  assert.throws(() => validateSetting('design.figma', 'yes'), /boolean/);
  assert.throws(() => validateSetting('admin.everything', true), /unknown setting/);
});

test('the monitor asks the official commands and never reads key values', async () => {
  const asked = [];
  const run = async (file, args, env) => {
    asked.push([file, args.join(' '), env.ENABLE_CLAUDEAI_MCP_SERVERS]);
    if (args.join(' ') === 'auth status') return { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}' };
    if (args.join(' ') === 'mcp list') return { code: 0, stdout: MCP_LIST };
    if (args.join(' ') === 'login status') return { code: 0, stdout: '', stderr: 'Logged in using ChatGPT' }; // codex prints this on stderr
    return { code: 1, stdout: '' };
  };
  const monitor = new EnvironmentMonitor({ bins: { claude: { file: 'claude', prefix: [] }, codex: { file: 'codex', prefix: [] } }, run,
    env: { PERPLEXITY_API_KEY: 'pk-secret-value' }, clock: { now: () => Date.parse('2026-09-28T10:00:00Z') } });
  const snap = await monitor.refresh();
  assert.deepEqual([snap.claude.loggedIn, snap.codex.loggedIn, snap.connectors.length], [true, true, 4]);
  assert.deepEqual([snap.claude.subscription, snap.codex.subscription], [true, true]);
  assert.deepEqual(snap.apiKeys, { PERPLEXITY_API_KEY: true, OPENAI_API_KEY: false });
  assert.ok(!JSON.stringify(snap).includes('pk-secret-value'), 'key values are never kept');
  assert.equal(asked.find(a => a[1] === 'mcp list')[2], 'true', 'the connector list is read with connectors enabled');
});
