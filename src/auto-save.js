import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateProjectId } from './workspaces.js';
import { assertWorkspaceConfigurationSafe } from './adapters.js';
import { textFiles, inspectExport, licenseReport, scanSecrets } from './checks.js';
import { projectRecord } from './records.js';

export const DEFAULT_NOTION_PARENT = '2d96029496a28095b8e6d6a7db5b8208';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class AutoSave {
  constructor({ store, workspaces, transport = {
    status: () => ({ github: 'external_adapter_not_connected', notion: 'external_adapter_not_connected' }),
    save: async () => { throw Object.assign(new Error('authentication_required'), { kind: 'authentication_required' }); },
  }, clock = { now: () => Date.now() } }) {
    Object.assign(this, { store, workspaces, transport, clock });
    this.pending = null;
    // Ambiguous external writes are reconciled by adapters, never blindly duplicated.
    for (const job of this.jobs()) if (job.status === 'saving') this.saveJob({ ...job, status: 'pending' });
  }
  key(id) { return `autosave.policy.${validateProjectId(id)}`; }
  policy(id) { return this.store.getSettings()[this.key(id)] ?? { github: false, notion: false, githubOwner: 'Parkjin0821', notionParent: DEFAULT_NOTION_PARENT }; }
  configure(id, input) {
    if (!this.store.listGoals().some(g => g.projectId === id)) throw new Error('project not found');
    if (Object.keys(input).some(k => !['github','notion','githubOwner','notionParent'].includes(k))) throw new Error('unsupported auto-save setting');
    const p = { ...this.policy(id), ...input };
    if (typeof p.github !== 'boolean' || typeof p.notion !== 'boolean' || !/^[A-Za-z0-9-]{1,39}$/.test(p.githubOwner)
      || !/^[a-f0-9]{32}$/i.test(p.notionParent)) throw new Error('invalid auto-save policy');
    this.store.setSetting(this.key(id), p);
    return p;
  }
  jobs(id = null) { return Object.entries(this.store.getSettings()).filter(([k]) => k.startsWith('autosave.job.')).map(([,v]) => v).filter(j => !id || j.projectId === id); }
  saveJob(j) { this.store.setSetting(`autosave.job.${j.id}`, j); return j; }
  view(id) { return { policy: this.policy(id), jobs: this.jobs(id).map(({ payload, ...j }) => j),
    warning: this.store.getSettings()[`autosave.warning.${id}`] ?? null, authentication: this.transport.status() }; }
  prepare(id) {
    const goals = this.store.listGoals().filter(g => g.projectId === id);
    if (!goals.length || goals.some(g => g.status === 'running')) return null;
    const runs = goals.flatMap(g => this.store.listRuns(g.id));
    if (!runs.some(r => r.status === 'finished' && !r.simulated)) return null;
    const cwd = this.workspaces.resolve(id);
    assertWorkspaceConfigurationSafe(cwd);
    const paths = textFiles(cwd, { max: 101 }).filter(f => !f.split('/').some(s => s.startsWith('.')));
    if (paths.length > 100) throw new Error('export_limit');
    const files = paths.map(file => ({ path: file, content: readFileSync(path.join(cwd, file), 'utf8') }));
    if (files.reduce((n,f) => n + Buffer.byteLength(f.content), 0) > 1000000) throw new Error('export_limit');
    if (scanSecrets(cwd).findings.length || inspectExport(files).length) throw new Error('security_review_required');
    const licenses = licenseReport(cwd);
    if (licenses.packages.some(p => p.flag !== 'ok') || licenses.python.length) throw new Error('license_review_required');
    const record = projectRecord(this.store, id);
    const first = goals[0];
    const name = `${(first.title || id).normalize('NFKD').replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 40).replace(/^-|-$/g, '') || 'project'}-${id}`.slice(0, 100);
    return { projectId: id, repoName: name, files, markdown: record.markdown, digest: hash({ files, record: record.digest }),
      // Team outcome plus code scale, not an invented model-based judgement.
      githubNeeded: goals.some(g => g.status === 'verified') || files.length >= 5 || files.reduce((n,f) => n + f.content.length, 0) >= 32000 };
  }
  tick() {
    this.pending ??= this.work().finally(() => { this.pending = null; });
    return this.pending;
  }
  async work() {
    const ids = [...new Set(this.store.listGoals().map(g => g.projectId))];
    for (const id of ids) {
      const policy = this.policy(id);
      if (!policy.github && !policy.notion) continue;
      let payload;
      try { payload = this.prepare(id); }
      catch (e) {
        this.store.setSetting(`autosave.warning.${id}`, ['export_limit','security_review_required','license_review_required'].includes(e.message) ? e.message : 'workspace_review_required');
        continue;
      }
      if (!payload) continue;
      this.store.setSetting(`autosave.warning.${id}`, null);
      for (const provider of ['github','notion']) {
        if (!policy[provider] || (provider === 'github' && !payload.githubNeeded)) continue;
        const jobId = hash({ provider, digest: payload.digest, id, destination: provider === 'github' ? policy.githubOwner : policy.notionParent });
        let job = this.jobs(id).find(j => j.id === jobId);
        if (job && ['saved','blocked'].includes(job.status)) continue;
        if (job?.nextAt > this.clock.now()) continue;
        job ??= { id: jobId, projectId: id, provider, digest: payload.digest, attempts: 0, status: 'pending' };
        this.saveJob({ ...job, status: 'saving', attempts: job.attempts + 1 });
        try {
          const { files, ...metadata } = payload;
          const result = await this.transport.save(provider, provider === 'github' ? payload : metadata, policy);
          this.saveJob({ ...job, attempts: job.attempts + 1, status: 'saved', url: result.url, savedAt: this.clock.now() });
          await this.store.emit({ type: 'autosave.saved', projectId: id, provider });
        } catch (e) {
          const attempts = job.attempts + 1;
          const reason = ['authentication_required','destination_conflict','permission_denied'].includes(e.kind) ? e.kind : 'remote_error';
          this.saveJob({ ...job, attempts, status: reason !== 'remote_error' || attempts >= 3 ? 'blocked' : 'pending',
            reason, nextAt: this.clock.now() + [60000,300000,900000][Math.min(attempts - 1, 2)] });
        }
      }
    }
  }
}
