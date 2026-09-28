import { isUsable, validateExecutor } from './models.js';

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
    const { usable, ...stored } = entry;
    return this.store.saveCatalogEntry({ supportEvidence: null, accountCheckedAt: null, available: true, ...stored });
  }

  catalog() { return this.store.listCatalog().map(entry => ({ ...entry, usable: isUsable(entry) })); }
}

function validatePolicy(policy) {
  if (!['auto', 'pinned'].includes(policy.mode)) throw new Error('policy mode must be auto or pinned');
  if (policy.mode === 'pinned' && !policy.model) throw new Error('pinned policy requires a model');
  for (const executor of Object.keys(policy.autoDefaults || {})) validateExecutor(executor);
  return { mode: policy.mode, model: policy.mode === 'pinned' ? policy.model : null,
    allowFallback: Boolean(policy.allowFallback), autoDefaults: { ...policy.autoDefaults } };
}
