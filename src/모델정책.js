import { isUsable, validateExecutor } from './모델.js';

const DEFAULT_POLICY = Object.freeze({ mode: 'auto', allowFallback: false, autoDefaults: {} });
const iso = ms => new Date(ms).toISOString();

// Versioned model policies and the verified model catalog, persisted in SQLite.
// Policy versions are append-only: a rollback is a new version that copies an old body.
export class ModelRegistry {
  constructor({ store, clock = { now: () => Date.now() } }) {
    Object.assign(this, { store, clock });
  }

  getPolicy(scope) {
    const latest = this.store.policyVersions(scope).at(-1);
    return latest ? { ...latest.policy, version: latest.version } : { ...DEFAULT_POLICY, autoDefaults: {}, version: 0 };
  }

  history(scope) { return this.store.policyVersions(scope); }

  setPolicy(scope, changes, meta = {}) {
    const { version, ...current } = this.getPolicy(scope);
    return this.writeVersion(scope, validatePolicy({ ...current, ...changes }), meta, { changedFrom: version });
  }

  rollback(scope, version, meta = {}) {
    // Version 0 is the implicit default that existed before any change.
    const target = version === 0 ? { policy: { ...DEFAULT_POLICY, model: null, autoDefaults: {} } }
      : this.history(scope).find(h => h.version === version);
    if (!target) throw new Error(`policy version ${version} not found for ${scope}`);
    return this.writeVersion(scope, target.policy, meta, { rolledBackTo: version });
  }

  writeVersion(scope, policy, { by, reason = '' }, extra) {
    if (!by) throw new Error('policy change requires by (who approved it)');
    const record = { version: this.getPolicy(scope).version + 1, policy, by, reason, at: iso(this.clock.now()), ...extra };
    this.store.insertPolicyVersion(scope, record);
    return { ...policy, version: record.version };
  }

  upsertModel(entry) {
    validateExecutor(entry.executor);
    if (!entry.id || !entry.label) throw new Error('model id and label are required');
    if (entry.tier !== undefined && (!Number.isInteger(entry.tier) || entry.tier < 0 || entry.tier > 2)) throw new Error('model tier must be 0 to 2');
    if (entry.efforts !== undefined && (!Array.isArray(entry.efforts) || !entry.efforts.length
      || entry.efforts.some(e => !['low','medium','high','xhigh','max','ultra'].includes(e)
        || (entry.executor === 'claude-code' && e === 'ultra')))) throw new Error('invalid supported efforts');
    const { usable, ...stored } = entry;
    return this.store.saveCatalogEntry({ supportEvidence: null, accountCheckedAt: null, available: true, ...stored });
  }

  catalog() { return this.store.listCatalog().map(entry => ({ ...entry, usable: isUsable(entry) })); }

  registerModel(input) {
    const { executor, id, label, tier, efforts, capabilities } = input;
    validateExecutor(executor);
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(id)) throw new Error('invalid model id');
    if (typeof label !== 'string' || !label.trim() || label.length > 100) throw new Error('invalid model label');
    if (!Number.isInteger(tier) || !Array.isArray(efforts) || !efforts.length
      || !Array.isArray(capabilities) || !capabilities.length || capabilities.some(c => !['text','code','web','image','connectors'].includes(c))) throw new Error('complete model profile required');
    // Re-registering a changed profile revokes prior attestation instead of silently reusing it.
    return this.upsertModel({ executor, id, label: label.trim(), tier, efforts: [...new Set(efforts)],
      capabilities: [...new Set(capabilities)], available: false, supportEvidence: null,
      accountCheckedAt: null, verification: { state: 'pending' } });
  }

  attestModel(executor, id, input) {
    const entry = this.catalog().find(e => e.executor === executor && e.id === id);
    if (!entry) throw new Error('register model first');
    if (input.confirm !== true || input.source !== 'manual_official_ui') throw new Error('explicit official UI attestation required');
    let url;
    try { url = new URL(input.supportUrl); } catch { throw new Error('official support URL required'); }
    const domains = executor === 'codex' ? ['learn.chatgpt.com','developers.openai.com','platform.openai.com']
      : ['code.claude.com','claude.com','www.anthropic.com','docs.anthropic.com'];
    if (url.protocol !== 'https:' || !domains.includes(url.hostname) || url.username || url.password) throw new Error('official support URL required');
    if (typeof input.note !== 'string' || !input.note.trim() || input.note.length > 500) throw new Error('account confirmation note required');
    const at = iso(this.clock.now());
    const result = this.upsertModel({ ...entry, available: true, supportEvidence: { url: url.href, checkedAt: at }, accountCheckedAt: at,
      verification: { state: 'attested', source: 'manual_official_ui', by: '대장', at, note: input.note.trim() } });
    void this.store.emit({ type: 'model.attested', executor, model: id, source: 'manual_official_ui' });
    return { ...result, usable: isUsable(result) };
  }
}

function validatePolicy(policy) {
  if (policy.strategy && !['adaptive','legacy'].includes(policy.strategy)) throw new Error('unknown strategy');
  if (policy.permissionMode != null && !['auto', 'careful'].includes(policy.permissionMode)) throw new Error('permission mode must be auto or careful');
  if (!['auto', 'pinned'].includes(policy.mode)) throw new Error('policy mode must be auto or pinned');
  if (policy.mode === 'pinned' && !policy.model) throw new Error('pinned policy requires a model');
  for (const executor of Object.keys(policy.autoDefaults || {})) validateExecutor(executor);
  // Per-team picks: { [team]: { executor, model|null, effort|null } }. Checked against the official
  // choices by the API before they get here; here only the shape is enforced.
  const teamModels = {};
  for (const [team, pick] of Object.entries(policy.teamModels ?? {})) {
    if (!/^[a-z]{2,20}$/.test(team) || !pick || typeof pick !== 'object') throw new Error('invalid team model choice');
    validateExecutor(pick.executor);
    if ((pick.model !== null && typeof pick.model !== 'string') || (pick.effort !== null && typeof pick.effort !== 'string')) throw new Error('invalid team model choice');
    if (pick.model || pick.effort) teamModels[team] = { executor: pick.executor, model: pick.model || null, effort: pick.effort || null };
  }
  return { mode: policy.mode, model: policy.mode === 'pinned' ? policy.model : null, teamModels,
    allowFallback: Boolean(policy.allowFallback), ...(policy.allowProviderSwitch !== undefined ? { allowProviderSwitch: policy.allowProviderSwitch === true } : {}), autoDefaults: { ...policy.autoDefaults }, ...(policy.strategy ? { strategy: policy.strategy } : {}),
    // 권한 모드 for this project only (null = the global setting).
    ...(policy.permissionMode ? { permissionMode: policy.permissionMode } : {}) };
}
