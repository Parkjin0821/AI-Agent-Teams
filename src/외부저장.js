import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { textSha } from './보안감시.js';
import { buildCommand, connectorTool } from './실행어댑터.js';
import { readProbe } from './커넥터.js';

// 외부 저장 (9차 2번): the engine puts a project's results outside the PC only through a request 대장 approves, each time.
//   Notion — the project's work record (engine-written; no conversation, answers, paths or tool output) as a new sub-page
//     of the page 대장 set. A small relay step (Claude Code) makes the one call; the Sentinel lets it through only with
//     exactly the approved parent, title and text, once (보안감시.js). Existing pages are never changed.
//   GitHub — the project's text sources (the same scope and checks as 자동 저장: at most 100 text files and 1 MB, secret,
//     license and setting-file checks) as one commit in the one repository 대장's own fine-grained token can write. The
//     engine calls the GitHub API itself; no model is involved. The token is read from the environment and never logged.
// A request whose content changed after it was made is refused (make a new one). An upload cut off midway is marked
// "확인 필요" and never retried on its own, so nothing is written twice.
export const PUBLISH_KEY = 'publish.job.';
// Notion 자동 기록 (10차): per project, the record page the engine keeps up to date ({ pageId, url, digest, at, status }).
export const NOTION_PAGE_KEY = 'publish.notionPage.';
// The page id at the end of a Notion address (…/AI-3e96029496a280aebbcbee4e8cf1beab or …/p/3e96…).
export const notionPageId = url => (String(url ?? '').replace(/-/g, '').match(/([0-9a-f]{32})(?![0-9a-f])/i) ?? [])[1]?.toLowerCase() ?? null;
const sha = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const NOTION_ID = /^[0-9a-f]{32}$/;

export function githubConfig(env = process.env) {
  const repo = String(env.AGENT_HQ_GITHUB_REPO ?? '').trim();
  const token = String(env.AGENT_HQ_GITHUB_TOKEN ?? '').trim();
  return { repo: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : null, hasToken: token.length >= 20, token };
}

export class Publisher {
  // record(projectId) → { title, notionMarkdown }; files(projectId) → AutoSave.prepare payload; notionParent() → 32-hex id
  constructor({ store, clock = { now: () => Date.now() }, record, files, notionParent, notionRelay = null, githubPush = null, github = () => githubConfig(), notionAuto = () => false }) {
    Object.assign(this, { store, clock, record, files, notionParent, notionRelay, githubPush, github, notionAuto });
    this.syncing = Promise.resolve();
    this.waiting = new Set();
    // A page being made when the server died is never made again on its own (it may exist); 대장 checks Notion.
    for (const p of this.notionPages()) if (p.status === 'sending') this.store.setSetting(NOTION_PAGE_KEY + p.projectId, { ...p, status: p.pageId ? 'idle' : 'unknown', reason: p.pageId ? null : '만드는 중 서버가 꺼짐 · Notion에서 확인 필요' });
    // An upload the server died in the middle of: never sent again on its own.
    for (const job of this.list()) if (job.status === 'sending') this.save({ ...job, status: 'unknown', reason: '보내는 중 서버가 꺼짐 · 상대 서비스에서 올라갔는지 확인 필요' });
  }
  list() { return Object.entries(this.store.getSettings()).filter(([k, v]) => k.startsWith(PUBLISH_KEY) && v).map(([, v]) => v).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); }
  get(id) { return this.store.getSettings()[PUBLISH_KEY + id] ?? null; }
  save(job) { this.store.setSetting(PUBLISH_KEY + job.id, job); return job; }
  requests() { return this.list().filter(j => j.status === 'approval_required'); }
  notionPages() { return Object.entries(this.store.getSettings()).filter(([k, v]) => k.startsWith(NOTION_PAGE_KEY) && v).map(([, v]) => v); }
  notionPage(projectId) { return this.store.getSettings()[NOTION_PAGE_KEY + projectId] ?? null; }

  // Notion 자동 기록: bring the project's record page up to date — made the first time, its text replaced afterwards.
  // 대장 turned this on for one parent page, so no request waits in the inbox; the Sentinel still holds each write to
  // that page and the engine's exact text. One sync at a time; a project already waiting is not queued twice; nothing
  // is sent when the record has not changed; a page whose creation went unconfirmed is never made again on its own.
  sync(projectId, { force = false } = {}) {
    if ((!this.notionAuto() && !force) || this.waiting.has(projectId)) return this.syncing;
    this.waiting.add(projectId);
    this.syncing = this.syncing.then(() => this.syncNow(projectId)).catch(() => null).finally(() => this.waiting.delete(projectId));
    return this.syncing;
  }
  async syncNow(projectId) {
    const key = NOTION_PAGE_KEY + projectId, at = () => new Date(this.clock.now()).toISOString();
    const was = this.notionPage(projectId) ?? { projectId };
    if (was.status === 'unknown') return was;
    let p;
    try { p = this.payload(projectId, 'notion'); } catch (e) { const f = { ...was, projectId, status: 'failed', reason: String(e.message).slice(0, 200), at: at() }; this.store.setSetting(key, f); return f; }
    if (was.pageId && was.digest === p.digest && was.status === 'idle') return was;
    this.store.setSetting(key, { ...was, projectId, status: 'sending', at: at() });
    try {
      const jobId = randomUUID();
      const r = was.pageId ? await this.notionRelay({ mode: 'update', pageId: was.pageId, content: p.content, jobId })
        : await this.notionRelay({ mode: 'create', parent: p.parent, title: p.title, content: p.content, jobId });
      const pageId = was.pageId ?? notionPageId(r.url);
      const next = pageId ? { projectId, pageId, url: was.url ?? r.url ?? null, digest: p.digest, status: 'idle', reason: null, at: at(), syncs: (was.syncs ?? 0) + 1 }
        : { projectId, url: r.url ?? null, status: 'unknown', reason: '페이지는 만들었지만 주소를 확인하지 못함 · Notion에서 확인 필요', at: at() };
      this.store.setSetting(key, next);
      await this.store.emit({ type: 'publish.synced', projectId, provider: 'notion', created: !was.pageId });
      return next;
    } catch (e) {
      const next = { ...was, projectId, status: e.unknown && !was.pageId ? 'unknown' : was.pageId ? 'idle' : 'failed', reason: String(e.message).slice(0, 300), at: at(), failedAt: at() };
      this.store.setSetting(key, next);
      await this.store.emit({ type: 'publish.failed', projectId, provider: 'notion', auto: true });
      return next;
    }
  }

  // What would be sent, computed from the engine's records now (also at approval, to refuse a changed request).
  payload(projectId, provider) {
    if (provider === 'notion') {
      const parent = String(this.notionParent() ?? '').replace(/-/g, '').toLowerCase();
      if (!NOTION_ID.test(parent)) throw new Error('Notion 부모 페이지가 정해지지 않음');
      const { title, notionMarkdown } = this.record(projectId);
      const content = String(notionMarkdown).slice(0, 12000);
      return { destination: `Notion 페이지 ${parent}`, parent, title: `AGENT HQ · ${String(title).slice(0, 80)}`, content, digest: textSha(content) };
    }
    if (provider === 'github') {
      const gh = this.github();
      if (!gh.repo || !gh.hasToken) throw new Error('GitHub 전용 토큰과 저장소가 설정되지 않음 (AGENT_HQ_GITHUB_TOKEN, AGENT_HQ_GITHUB_REPO)');
      const p = this.files(projectId);
      if (!p) throw new Error('올릴 결과가 없음 (실제 실행 기록이 없거나 진행 중)');
      return { destination: `GitHub ${gh.repo} · projects/${p.repoName}/`, repo: gh.repo, folder: `projects/${p.repoName}`, files: p.files, digest: sha(p.files) };
    }
    throw new Error('unknown provider');
  }

  request(projectId, provider) {
    if (this.list().some(j => j.projectId === projectId && j.provider === provider && ['approval_required', 'sending'].includes(j.status))) throw new Error('이미 기다리는 요청이 있음');
    const p = this.payload(projectId, provider);
    const job = { id: randomUUID(), projectId, provider, status: 'approval_required', destination: p.destination, digest: p.digest,
      createdAt: new Date(this.clock.now()).toISOString(),
      ...(provider === 'notion' ? { title: p.title, preview: p.content.slice(0, 1500), length: p.content.length } : { files: p.files.map(f => f.path).slice(0, 100), bytes: p.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) }) };
    return this.save(job);
  }

  refuse(id) {
    const job = this.get(id);
    if (job?.status !== 'approval_required') throw new Error('기다리는 요청이 아님');
    return this.save({ ...job, status: 'refused', decidedAt: new Date(this.clock.now()).toISOString() });
  }

  async approve(id, { confirm } = {}) {
    const job = this.get(id);
    if (confirm !== true || job?.status !== 'approval_required') throw new Error('기다리는 요청이 아님');
    let p;
    try { p = this.payload(job.projectId, job.provider); } catch (e) { return this.save({ ...job, status: 'failed', reason: String(e.message).slice(0, 200) }); }
    if (p.digest !== job.digest) return this.save({ ...job, status: 'failed', reason: '요청한 뒤 내용이 바뀜 · 새로 요청' });
    this.save({ ...job, status: 'sending', approvedAt: new Date(this.clock.now()).toISOString() });
    try {
      const r = job.provider === 'notion'
        ? await this.notionRelay({ parent: p.parent, title: p.title, content: p.content, jobId: job.id })
        : await this.githubPush({ repo: p.repo, folder: p.folder, files: p.files, jobId: job.id });
      return this.save({ ...this.get(id), status: 'sent', url: r.url ?? null, sentAt: new Date(this.clock.now()).toISOString() });
    } catch (e) {
      return this.save({ ...this.get(id), status: e.unknown ? 'unknown' : 'failed', reason: String(e.message).slice(0, 300) });
    }
  }
}

// The Notion relay: one Claude Code run that may call one Notion write tool — notion-create-pages for a new page, or
// notion-update-page to replace the text of the record page it made before — with the Sentinel holding it to those
// exact arguments. deny: every other Notion tool (from the read-only connector check), so none is even offered.
export function notionRelay({ bins, sentinel, knownConnectors, plugins, deny = [], model = 'claude-sonnet-5-5', timeoutMs = 240_000, run = runClaude }) {
  return async ({ mode = 'create', parent, pageId, title, content, jobId }) => {
    const create = `${connectorTool('Notion')}__${mode === 'update' ? 'notion-update-page' : 'notion-create-pages'}`;
    const cwd = mkdtempSync(path.join(tmpdir(), 'hq-publish-'));
    try {
      const log = path.join(cwd, '.sentinel.jsonl');
      const command = buildCommand('claude', { cwd, model, access: 'read', bins, knownConnectors, plugins,
        readOnly: [{ name: 'Notion', allow: [create], deny: deny.filter(t => t !== create) }],
        sentinel: { ...sentinel, log, project: 'publish', team: 'publish', webMode: 'ask' },
        notionWrite: mode === 'update' ? { pageId, contentSha: textSha(content), once: path.join(cwd, `.once-${jobId}`) }
          : { parent, title, contentSha: textSha(content), once: path.join(cwd, `.once-${jobId}`) } });
      const args = mode === 'update' ? { page_id: pageId, command: 'replace_content', new_str: content }
        : { parent: { page_id: parent }, pages: [{ properties: { title }, content }] };
      const prompt = `아래 JSON 을 인수로 ${create} 를 정확히 한 번 호출하라. 인수는 한 글자도 바꾸지 않는다. `
        + '다른 도구는 쓰지 않는다. 호출이 끝나면 ' + (mode === 'update' ? '"갱신함" 한 단어만' : '만들어진 페이지 주소만 한 줄로') + ' 답한다.\n\n' + JSON.stringify(args);
      const out = await run(command, prompt, timeoutMs);
      const probe = readProbe(out.stdout);
      const call = probe.calls.find(c => c.name === create);
      let sentinelSaid = [];
      try { sentinelSaid = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.tool === create); } catch { /* none */ }
      if (sentinelSaid.some(e => e.decision === 'deny') && !sentinelSaid.some(e => e.decision === 'allow')) throw new Error(`감시 에이전트가 막음: ${sentinelSaid.find(e => e.decision === 'deny').reason}`);
      if (!call) throw new Error('Notion 쓰기 도구를 호출하지 않음');
      if (call.error !== false) throw Object.assign(new Error('Notion 쓰기 결과를 확인하지 못함 · Notion에서 확인 필요'), { unknown: call.error === null });
      const url = (String(out.stdout).match(/https:\/\/(?:www\.notion\.so|app\.notion\.com)\/[^\s"\\)]+/) ?? [])[0] ?? null;
      return { url };
    } finally { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* temp */ } }
  };
}

function runClaude(command, prompt, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(command.file, command.args, { cwd: command.cwd, env: command.env, shell: false, windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', c => { if (out.length < 4_000_000) out += c; });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, stdout: out }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout: out }); });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// GitHub: one commit with the project's files under projects/<name>/ on the default branch, through the Git data API.
// A commit whose message carries this job's id already there (a retry after a lost answer) is not made again.
export function githubPush({ token, fetcher = fetch }) {
  const api = async (method, url, body) => {
    const res = await fetcher(`https://api.github.com${url}`, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'AGENT-HQ', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (res.status === 401) throw new Error('GitHub 토큰이 거부됨 (만료되었거나 잘못됨)');
    if (res.status === 403 || res.status === 404) throw new Error('이 토큰으로 그 저장소에 쓸 수 없음 (저장소 이름·토큰 권한 확인)');
    if (!res.ok) throw new Error(`GitHub 응답 ${res.status}`);
    return res.json();
  };
  return async ({ repo, folder, files, jobId }) => {
    const marker = `[agent-hq ${jobId.slice(0, 8)}]`;
    const info = await api('GET', `/repos/${repo}`);
    const branch = info.default_branch;
    const recent = await api('GET', `/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=20`);
    const done = (Array.isArray(recent) ? recent : []).find(c => String(c.commit?.message ?? '').includes(marker));
    if (done) return { url: done.html_url };
    const ref = await api('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    const head = await api('GET', `/repos/${repo}/git/commits/${ref.object.sha}`);
    const tree = [];
    for (const f of files) {
      const blob = await api('POST', `/repos/${repo}/git/blobs`, { content: f.content, encoding: 'utf-8' });
      tree.push({ path: `${folder}/${f.path}`, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const newTree = await api('POST', `/repos/${repo}/git/trees`, { base_tree: head.tree.sha, tree });
    const commit = await api('POST', `/repos/${repo}/git/commits`, { message: `AGENT HQ: ${folder} 결과 올리기 ${marker}`, tree: newTree.sha, parents: [head.sha] });
    await api('PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha });
    return { url: commit.html_url ?? `https://github.com/${repo}/commit/${commit.sha}` };
  };
}
