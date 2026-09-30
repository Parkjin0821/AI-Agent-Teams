import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

// 승인 대기 (Muse-style "pause for a human yes"). When the Sentinel meets an action that needs 대장
// (a public site not approved yet, or a destructive connector action), it refuses it for now and logs an
// "ask". After the round the engine turns those asks into approval requests and the project waits.
// 대장 answers with a scope; grants live in a small JSON file the Sentinel hook reads before every call.
export const SCOPES = Object.freeze({
  once: '이번 한 번 (다음 단계에서만)',
  project: '이 프로젝트에서 계속',
  day: '24시간 동안 (이 프로젝트)',
  always: '모든 프로젝트에서 계속',
});
const KEY = 'approval.request.';

export function readGrants(file) {
  try { const data = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(data.grants) ? data.grants : []; } catch { return []; }
}
function writeGrants(file, grants) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({ grants }, null, 1));
  renameSync(temp, file);
}

// Does a grant cover this action? Web targets match the host or its subdomains; "*" means any public site.
export function granted(grants, { kind, target, project }, now = Date.now()) {
  return grants.some(g => g.kind === kind
    && (g.scope === 'always' || g.project === project)
    && (!g.expiresAt || Date.parse(g.expiresAt) > now)
    && (kind === 'web' ? g.target === '*' || target === g.target || target.endsWith(`.${g.target}`) : g.target === target));
}

export class Approvals {
  constructor({ store, grantsFile, clock = { now: () => Date.now() } }) {
    Object.assign(this, { store, grantsFile, clock });
  }

  list() {
    return Object.entries(this.store.getSettings()).filter(([k]) => k.startsWith(KEY)).map(([, v]) => v)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  }
  pending(projectId) { return this.list().filter(r => r.status === 'pending' && (!projectId || r.project === projectId)); }
  grants() { return readGrants(this.grantsFile); }

  // From the Sentinel's asks during one round. One pending request per (project, kind, target).
  // `task` is what the team was doing, and `examples` the exact addresses it tried, so 대장 can judge why.
  request(asks, { goalId, project, team, task = '' }) {
    const created = [];
    for (const ask of asks) {
      if (!['web', 'connector', 'path'].includes(ask?.kind) || typeof ask.target !== 'string' || !ask.target) continue;
      const id = createHash('sha256').update(JSON.stringify([project, ask.kind, ask.target])).digest('hex').slice(0, 24);
      const existing = this.store.getSettings()[KEY + id];
      const example = typeof ask.detail === 'string' && ask.detail ? ask.detail.slice(0, 200) : null;
      if (existing?.status === 'pending') {
        const examples = existing.examples ?? [];
        if (example && !examples.includes(example) && examples.length < 5) this.store.setSetting(KEY + id, { ...existing, examples: [...examples, example] });
        continue;
      }
      const entry = { id, kind: ask.kind, target: ask.target.slice(0, 200), project, goalId, team, reason: String(ask.reason ?? '').slice(0, 300),
        task: String(task ?? '').slice(0, 300), tool: typeof ask.tool === 'string' ? ask.tool.slice(0, 100) : null, examples: example ? [example] : [],
        status: 'pending', at: new Date(this.clock.now()).toISOString() };
      this.store.setSetting(KEY + id, entry);
      created.push(entry);
    }
    return created;
  }

  grant(id, scope, { anySite = false } = {}) {
    const request = this.store.getSettings()[KEY + id];
    if (!request || request.status !== 'pending') throw new Error('approval request is not pending');
    if (!Object.hasOwn(SCOPES, scope)) throw new Error('unknown approval scope');
    if (anySite && request.kind !== 'web') throw new Error('only web requests can open every site');
    const now = this.clock.now();
    const grant = { id: randomUUID(), kind: request.kind, target: anySite ? '*' : request.target, scope,
      project: scope === 'always' ? null : request.project, expiresAt: scope === 'day' ? new Date(now + 24 * 3600_000).toISOString() : null,
      grantedAt: new Date(now).toISOString(), by: '대장' };
    writeGrants(this.grantsFile, [...this.grants().filter(g => !g.expiresAt || Date.parse(g.expiresAt) > now), grant]);
    const done = { ...request, status: 'granted', scope, anySite, decidedAt: grant.grantedAt };
    this.store.setSetting(KEY + id, done);
    return done;
  }

  deny(id, note = '') {
    const request = this.store.getSettings()[KEY + id];
    if (!request || request.status !== 'pending') throw new Error('approval request is not pending');
    const done = { ...request, status: 'denied', note: String(note).slice(0, 300), decidedAt: new Date(this.clock.now()).toISOString() };
    this.store.setSetting(KEY + id, done);
    return done;
  }

  // "Once" grants are spent by the next finished round of their project.
  consumeOnce(project) {
    const grants = this.grants();
    const kept = grants.filter(g => !(g.scope === 'once' && g.project === project));
    if (kept.length !== grants.length) writeGrants(this.grantsFile, kept);
  }

  revoke(grantId) {
    const grants = this.grants();
    if (!grants.some(g => g.id === grantId)) throw new Error('grant not found');
    writeGrants(this.grantsFile, grants.filter(g => g.id !== grantId));
    return { revoked: true };
  }
}
