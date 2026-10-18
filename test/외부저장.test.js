import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decide, textSha } from '../src/보안감시.js';
import { githubPush, notionRelay, Publisher } from '../src/외부저장.js';

const PARENT = '2d96029496a28095b8e6d6a7db5b8208';
const CREATE = 'mcp__claude_ai_Notion__notion-create-pages';
const memStore = () => { const s = {}; return { getSettings: () => s, setSetting: (k, v) => { s[k] = v; return s; } }; };

test('9차 2번: the Sentinel lets a Notion page through only with exactly the approved parent, title and text, once', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hq-nw-'));
  const notionWrite = { parent: PARENT, title: 'AGENT HQ · 시험', contentSha: textSha('# 기록\n\n- 완료'), once: path.join(dir, '.once') };
  const mcpAllow = { prefixes: [], tools: [CREATE] };
  const call = (args, nw = notionWrite) => decide({ tool_name: CREATE, tool_input: args }, { workspace: dir, mcpAllow, notionWrite: nw }).decision;
  const good = { parent: { page_id: '2d960294-96a2-8095-b8e6-d6a7db5b8208' }, pages: [{ properties: { title: 'AGENT HQ · 시험' }, content: '# 기록\n- 완료' }] };
  assert.equal(call(good, null), 'deny', 'no approved upload, no page');
  assert.equal(call({ ...good, parent: { page_id: 'f'.repeat(32) } }), 'deny', 'another parent');
  assert.equal(call({ ...good, pages: [{ ...good.pages[0], properties: { title: '바뀐 제목' } }] }), 'deny');
  assert.equal(call({ ...good, pages: [{ ...good.pages[0], content: '# 기록\n- 완료\n- 몰래 넣은 줄' }] }), 'deny', 'changed text');
  assert.equal(call({ ...good, pages: [good.pages[0], good.pages[0]] }), 'deny', 'two pages');
  assert.equal(call({ ...good, creation_mode: 'draft' }), 'deny');
  assert.equal(call(good), 'allow', 'line breaks may differ, the words may not');
  assert.equal(call(good), 'deny', 'only once per upload');
  assert.equal(decide({ tool_name: 'mcp__claude_ai_Notion__notion-update-page', tool_input: {} }, { workspace: dir, mcpAllow, notionWrite }).decision, 'deny', 'no other Notion write');
});

test('requests wait for 대장; a changed record is refused at approval; a cut-off upload is never sent again on its own', async () => {
  const store = memStore();
  let record = '# 기록\n- 완료';
  const sent = [];
  const make = () => new Publisher({ store, record: () => ({ title: '가계부', notionMarkdown: record }), files: () => null, notionParent: () => PARENT,
    notionRelay: async (a) => { sent.push(a); return { url: 'https://www.notion.so/abc' }; }, github: () => ({ repo: null, hasToken: false }) });
  const pub = make();
  const job = pub.request('p1', 'notion');
  assert.deepEqual([job.status, job.title, job.destination], ['approval_required', 'AGENT HQ · 가계부', `Notion 페이지 ${PARENT}`]);
  assert.equal(pub.requests().length, 1);
  assert.throws(() => pub.request('p1', 'notion'), /이미 기다리는/);
  await assert.rejects(pub.approve(job.id, {}), /기다리는 요청이 아님/, 'approval needs confirm');
  assert.equal(sent.length, 0, 'nothing leaves before approval');
  const done = await pub.approve(job.id, { confirm: true });
  assert.deepEqual([done.status, done.url, sent[0].parent, sent[0].title], ['sent', 'https://www.notion.so/abc', PARENT, 'AGENT HQ · 가계부']);
  const second = pub.request('p1', 'notion');
  record = '# 기록\n- 바뀜';
  assert.equal((await pub.approve(second.id, { confirm: true })).status, 'failed', 'changed after the request');
  assert.match(pub.get(second.id).reason, /내용이 바뀜/);
  const third = pub.request('p1', 'notion');
  store.setSetting(`publish.job.${third.id}`, { ...pub.get(third.id), status: 'sending' });
  make(); // restart
  assert.equal(store.getSettings()[`publish.job.${third.id}`].status, 'unknown');
  assert.throws(() => pub.request('p1', 'github'), /GitHub 전용 토큰/);
});

test('GitHub: one commit through the data API; a retry finds its own commit and makes no second one', async () => {
  const calls = [];
  let commits = [];
  const fetcher = async (url, opts) => {
    const u = url.replace('https://api.github.com', ''); calls.push(`${opts.method} ${u.split('?')[0]}`);
    assert.equal(opts.headers.Authorization, 'Bearer tok_1234567890abcdefghij');
    const json = body => ({ ok: true, status: 200, json: async () => body });
    if (u === '/repos/me/results') return json({ default_branch: 'main' });
    if (u.startsWith('/repos/me/results/commits')) return json(commits);
    if (u.startsWith('/repos/me/results/git/ref/')) return json({ object: { sha: 'h1' } });
    if (u === '/repos/me/results/git/commits/h1') return json({ sha: 'h1', tree: { sha: 't1' } });
    if (u.endsWith('/git/blobs')) return json({ sha: 'b' + calls.length });
    if (u.endsWith('/git/trees')) return json({ sha: 't2' });
    if (u.endsWith('/git/commits')) { const body = JSON.parse(opts.body); commits = [{ commit: { message: body.message }, html_url: 'https://github.com/me/results/commit/c2' }]; return json({ sha: 'c2', html_url: 'https://github.com/me/results/commit/c2' }); }
    if (u.includes('/git/refs/heads/')) return json({});
    throw new Error(u);
  };
  const push = githubPush({ token: 'tok_1234567890abcdefghij', fetcher });
  const job = { repo: 'me/results', folder: 'projects/가계부', files: [{ path: '합계.js', content: 'x' }, { path: 'README.md', content: 'y' }], jobId: 'abcd1234-0000-0000-0000-000000000000' };
  assert.equal((await push(job)).url, 'https://github.com/me/results/commit/c2');
  assert.equal(calls.filter(c => c.endsWith('/git/blobs')).length, 2);
  assert.ok(calls.includes('PATCH /repos/me/results/git/refs/heads/main'));
  const before = calls.length;
  assert.equal((await push(job)).url, 'https://github.com/me/results/commit/c2', 'the marker in the last commit message stops a second commit');
  assert.ok(!calls.slice(before).some(c => c.startsWith('POST')));
  const denied = githubPush({ token: 'tok_1234567890abcdefghij', fetcher: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await assert.rejects(denied(job), e => /토큰이 거부됨/.test(e.message) && !e.message.includes('tok_'), 'the token never appears in an error');
});

test('the Notion relay runs with only notion-create-pages offered and the approved upload handed to the Sentinel', async () => {
  let seen;
  const run = async (command) => { seen = command; return { code: 0, stdout: [
    JSON.stringify({ type: 'system', subtype: 'init', tools: [CREATE] }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: CREATE, input: {} }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', is_error: false, content: 'https://www.notion.so/page-1' }] } }),
    JSON.stringify({ type: 'result', is_error: false, result: 'https://www.notion.so/page-1' })].join('\n') }; };
  const relay = notionRelay({ bins: { claude: { file: 'claude', prefix: [] } }, sentinel: { script: 's.mjs' }, knownConnectors: ['Notion', 'Gmail'], plugins: [],
    deny: [CREATE, 'mcp__claude_ai_Notion__notion-update-page'], run });
  const r = await relay({ parent: PARENT, title: 'T', content: '본문', jobId: 'j1' });
  assert.equal(r.url, 'https://www.notion.so/page-1');
  assert.ok(seen.args.includes(`--allowedTools=${CREATE}`));
  assert.ok(seen.args.includes('--disallowedTools=mcp__claude_ai_Gmail,mcp__claude_ai_Notion__notion-update-page'));
  const nw = JSON.parse(seen.env.AGENT_HQ_NOTION_WRITE);
  assert.deepEqual([nw.parent, nw.title, nw.contentSha], [PARENT, 'T', textSha('본문')]);
});

test('10차 Notion 자동 기록: the Sentinel lets the record page be replaced only on that page, with the exact text, once', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hq-nu-'));
  const UPDATE = 'mcp__claude_ai_Notion__notion-update-page';
  const PAGE = '3e96029496a280aebbcbee4e8cf1beab';
  const nw = { pageId: PAGE, contentSha: textSha('# 기록\n- 2단계 완료'), once: path.join(dir, '.once') };
  const call = (args, w = nw) => decide({ tool_name: UPDATE, tool_input: args }, { workspace: dir, mcpAllow: { prefixes: [], tools: [UPDATE] }, notionWrite: w }).decision;
  const good = { page_id: '3e960294-96a2-80ae-bbcb-ee4e8cf1beab', command: 'replace_content', new_str: '# 기록\n\n- 2단계 완료' };
  assert.equal(call(good, null), 'deny', 'no auto record, no change');
  assert.equal(call(good, { parent: PAGE, title: 'x', contentSha: nw.contentSha }), 'deny', 'a create permission does not open updates');
  assert.equal(call({ ...good, page_id: 'f'.repeat(32) }), 'deny', 'another page');
  assert.equal(call({ ...good, command: 'update_content' }), 'deny', 'only a full replace');
  assert.equal(call({ ...good, new_str: '# 기록\n- 2단계 완료\n- 몰래 넣은 줄' }), 'deny', 'changed text');
  assert.equal(call({ ...good, allow_deleting_content: true }), 'deny', 'never the option that deletes child pages');
  assert.equal(call(good), 'allow');
  assert.equal(call(good), 'deny', 'once per update');
  assert.equal(decide({ tool_name: CREATE, tool_input: { parent: { page_id: PAGE }, pages: [{ properties: { title: 'x' }, content: 'y' }] } },
    { workspace: dir, mcpAllow: { prefixes: [], tools: [CREATE] }, notionWrite: nw }).decision, 'deny', 'an update permission does not make pages');
});

test('10차 Notion 자동 기록: first sync makes the page, later ones replace its text; unchanged is skipped; off means off', async () => {
  const { notionPageId } = await import('../src/외부저장.js');
  assert.equal(notionPageId('https://app.notion.com/p/AI-3e96029496a280aebbcbee4e8cf1beab?source=copy_link'), '3e96029496a280aebbcbee4e8cf1beab');
  assert.equal(notionPageId('https://www.notion.so/AGENT-HQ-3e960294-96a2-80ae-bbcb-ee4e8cf1beab'), '3e96029496a280aebbcbee4e8cf1beab');
  assert.equal(notionPageId('https://www.notion.so/'), null);
  const store = Object.assign(memStore(), { emit: async () => {} });
  let record = '# 기록\n- 1단계', auto = true;
  const calls = [];
  let relay = async (a) => { calls.push(a.mode); return a.mode === 'create' ? { url: 'https://www.notion.so/AGENT-HQ-' + 'a'.repeat(32) } : {}; };
  const pub = new Publisher({ store, record: () => ({ title: '가계부', notionMarkdown: record }), files: () => null, notionParent: () => PARENT,
    notionRelay: (a) => relay(a), notionAuto: () => auto });
  await pub.sync('p1');
  assert.deepEqual(calls, ['create']);
  assert.equal(pub.notionPage('p1').pageId, 'a'.repeat(32));
  await pub.sync('p1');
  assert.deepEqual(calls, ['create'], 'nothing changed, nothing sent');
  record = '# 기록\n- 1단계\n- 2단계';
  await pub.sync('p1');
  assert.deepEqual(calls, ['create', 'update']);
  assert.equal(pub.notionPage('p1').syncs, 2);
  auto = false; record += '\n- 3단계';
  await pub.sync('p1');
  assert.deepEqual(calls, ['create', 'update'], 'off means off');
  await pub.sync('p1', { force: true });
  assert.deepEqual(calls, ['create', 'update', 'update'], "대장's button works while auto is off");
  // a create whose answer was lost is never made again on its own
  auto = true;
  relay = async () => { throw Object.assign(new Error('응답을 확인하지 못함'), { unknown: true }); };
  await pub.sync('p2');
  assert.equal(pub.notionPage('p2').status, 'unknown');
  relay = async (a) => { calls.push('again-' + a.mode); return {}; };
  await pub.sync('p2');
  assert.ok(!calls.some(c => c.startsWith('again')), 'not made a second time');
});
