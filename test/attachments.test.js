import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { safeName, saveAttachment } from '../src/attachments.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

test('attachments: only images, PDF and text; content must match the type; no secrets; safe names', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'hq-att-'));
  const now = new Date(2026, 8, 29, 17, 30, 5).getTime();
  const a = saveAttachment(cwd, '화면 캡처.png', PNG, now);
  assert.deepEqual(a, { path: 'attachments/20260929-173005-화면 캡처.png', name: '화면 캡처.png', kind: 'image', size: PNG.length });
  assert.ok(existsSync(path.join(cwd, a.path)));
  assert.equal(saveAttachment(cwd, '화면 캡처.png', PNG, now).path, 'attachments/20260929-173005-2-화면 캡처.png', 'same name never overwrites');
  assert.equal(safeName('../../etc/passwd.txt'), 'passwd.txt');
  assert.equal(safeName('..\\..\\secret<>.md'), 'secret__.md');
  assert.throws(() => saveAttachment(cwd, 'tool.exe', Buffer.from('MZ')), /unsupported attachment type/);
  assert.throws(() => saveAttachment(cwd, '.env', Buffer.from('A=1')), /unsupported attachment type/);
  assert.throws(() => saveAttachment(cwd, 'fake.png', Buffer.from('MZ not a png')), /does not match its type/);
  assert.throws(() => saveAttachment(cwd, 'keys.txt', Buffer.from('token sk-ant-api03-' + 'a'.repeat(40))), /secret/);
  assert.throws(() => saveAttachment(cwd, 'empty.txt', Buffer.alloc(0)), /empty/);
  assert.equal(saveAttachment(cwd, '메모.md', Buffer.from('# 요구사항\n버튼은 파란색'), now).kind, 'text');
  // default limit 30MB; an image over what Claude reads in one go (~7.5MB) is kept but flagged
  const big = saveAttachment(cwd, '고해상도.png', Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]), now);
  assert.match(big.warning, /7\.5MB/);
  assert.equal(saveAttachment(cwd, '작은.png', PNG, now).warning, undefined);
  assert.throws(() => saveAttachment(cwd, 'huge.pdf', Buffer.concat([Buffer.from('%PDF-1.7'), Buffer.alloc(2 * 1024 * 1024)]), now, { maxMB: 1 }), /larger than 1MB/);
});

test('대장 attaches a screenshot to a message: it is saved in the project, shown in the thread and its path reaches the teams', async () => {
  const prompts = [];
  const adapter = { enabled: true, run: async (provider, prompt) => { prompts.push(prompt);
    return { outcome: 'completed', answer: 'AGENT_HQ_PLAN {"next_task":"x","team":"dev","reviews":[]}' }; } };
  const projectsDir = mkdtempSync(path.join(tmpdir(), 'hq-att-p-'));
  const app = createApp({ root: path.resolve('.'), dataDir: mkdtempSync(path.join(tmpdir(), 'hq-att-d-')), projectsDir, adapter });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const upload = async (projectId, name, bytes) => {
    const res = await fetch(`${base}/api/projects/${projectId}/attachments?name=${encodeURIComponent(name)}`, { method: 'POST',
      headers: { 'content-type': 'application/octet-stream', origin: base }, body: bytes });
    return { status: res.status, body: await res.json() };
  };
  try {
    const g = (await call('POST', '/api/projects', { objective: '가계부 앱', completionCriteria: ['c'] })).body;
    const shot = await upload(g.projectId, '캡처.png', PNG);
    assert.equal(shot.status, 201);
    assert.match(shot.body.path, /^attachments\/\d{8}-\d{6}-캡처\.png$/);
    assert.ok(readFileSync(path.join(projectsDir, g.projectId, shot.body.path)).equals(PNG));
    app.store.setSetting('attach.maxMB', 1);
    assert.match((await upload(g.projectId, 'big.png', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]))).body.error, /larger than 1MB/, "the size limit is 대장's setting");
    app.store.setSetting('attach.maxMB', 30);
    assert.match((await upload('no-such-project', 'a.png', PNG)).body.error, /project not found/);

    assert.match((await call('POST', `/api/goals/${g.id}/messages`, { text: 'x', attachments: [{ path: 'attachments/../../evil.png' }] })).body.error, /attachments folder/);
    assert.match((await call('POST', `/api/goals/${g.id}/messages`, { text: 'x', attachments: [{ path: 'attachments/missing.png' }] })).body.error, /not found/);
    // a screenshot alone is a valid message
    assert.equal((await call('POST', `/api/goals/${g.id}/messages`, { text: '', attachments: [shot.body] })).status, 200);
    const goal = app.store.getGoal(g.id);
    assert.deepEqual(goal.messages.at(-1).attachments, [{ path: shot.body.path, name: '캡처.png', kind: 'image', size: PNG.length }]);
    assert.equal(goal.messages.at(-1).text, '');
    assert.match(goal.team.feedback, new RegExp(`\\[대장 첨부 · 작업 폴더 안 파일 · 직접 열어서 확인\\] ${shot.body.path.replace('.', '\\.')} \\(이미지\\)`));
    await app.scheduler.runGoal(g.id);
    assert.ok(prompts.at(-1).includes(shot.body.path), 'the planning team is told where the screenshot is');
  } finally { await app.close(); }
});
