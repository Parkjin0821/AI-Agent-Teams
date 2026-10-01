import { randomUUID } from 'node:crypto';
import { compareModels, validateEval } from './모델평가.js';
import { validateExecutor } from './모델.js';

// discovered -> support_confirmed -> evaluated -> compared -> approved -> applied (-> rolled_back)
// Nothing here changes a policy until a person approves; compare() only produces a recommendation.
const iso = ms => new Date(ms).toISOString();

export class ModelChangePipeline {
  constructor({ store, registry, clock = { now: () => Date.now() } }) {
    Object.assign(this, { store, registry, clock });
  }

  get(id) { return this.store.getCandidate(id); }

  recordEval(record) {
    validateEval(record);
    return this.store.insertEval({ id: randomUUID(), recordedAt: iso(this.clock.now()), ...record });
  }

  discover({ executor, model, label, source }) {
    validateExecutor(executor);
    if (!model || !label || !source) throw new Error('discovery requires model, label and source');
    if (!this.registry.catalog().some(m => m.executor === executor && m.id === model)) {
      this.registry.upsertModel({ executor, id: model, label });
    }
    const candidate = { id: randomUUID(), executor, model, label, source, stage: null, history: [] };
    return this.advance(candidate, null, 'discovered', { source });
  }

  confirmSupport(id, { url, checkedAt }) {
    if (!/^https:\/\//.test(url || '') || !Number.isFinite(Date.parse(checkedAt))) {
      throw new Error('official support needs an https documentation url and checkedAt');
    }
    const candidate = this.get(id);
    this.expect(candidate, 'discovered');
    this.patchCatalog(candidate, { supportEvidence: { url, checkedAt } });
    return this.advance(candidate, 'discovered', 'support_confirmed', { url });
  }

  // A successful isolated run on this account is what proves the model is actually available to us.
  markEvaluated(id) {
    const candidate = this.get(id);
    this.expect(candidate, 'support_confirmed');
    const runs = this.store.listEvals().filter(r => r.source === 'project' && r.isolated === true
      && r.executor === candidate.executor && r.model === candidate.model);
    if (!runs.length) throw new Error('no isolated project evaluation recorded for this candidate');
    this.patchCatalog(candidate, { accountCheckedAt: runs.at(-1).recordedAt, available: true });
    return this.advance(candidate, 'support_confirmed', 'evaluated', { runs: runs.length });
  }

  compare(id, { baseline, evalTaskId, conditionsKey }) {
    const candidate = this.get(id);
    this.expect(candidate, 'evaluated');
    const result = compareModels(this.store.listEvals(), { evalTaskId, conditionsKey, baseline, candidate: candidate.model });
    if (!result.comparable) throw new Error(`cannot compare: ${result.reasons.join('; ')}`);
    candidate.comparison = { baseline, evalTaskId, conditionsKey, recommendation: result.recommendation, reasons: result.reasons };
    this.advance(candidate, 'evaluated', 'compared', { recommendation: result.recommendation });
    return result;
  }

  approve(id, { by }) {
    const candidate = this.get(id);
    this.expect(candidate, 'compared');
    if (!by) throw new Error('approval requires by');
    if (candidate.comparison.recommendation !== 'candidate') throw new Error('comparison did not recommend this candidate');
    return this.advance(candidate, 'compared', 'approved', { by });
  }

  apply(id, { scope, by }) {
    const candidate = this.get(id);
    this.expect(candidate, 'approved');
    const before = this.registry.getPolicy(scope);
    const after = this.registry.setPolicy(scope, { autoDefaults: { ...before.autoDefaults, [candidate.executor]: candidate.model } },
      { by, reason: `approved model change ${candidate.id}` });
    candidate.applied = { scope, previousVersion: before.version, version: after.version };
    return this.advance(candidate, 'approved', 'applied', { by, version: after.version });
  }

  revert(id, { by, reason }) {
    const candidate = this.get(id);
    this.expect(candidate, 'applied');
    const { scope, previousVersion } = candidate.applied;
    const restored = this.registry.rollback(scope, previousVersion, { by, reason });
    return this.advance(candidate, 'applied', 'rolled_back', { by, reason, version: restored.version });
  }

  expect(candidate, stage) {
    if (!candidate) throw new Error('candidate not found');
    if (candidate.stage !== stage) throw new Error(`candidate is at stage ${candidate.stage}, expected ${stage}`);
  }

  advance(candidate, from, to, detail) {
    candidate.stage = to;
    candidate.history.push({ stage: to, from, at: iso(this.clock.now()), ...detail });
    return this.store.saveCandidate(candidate);
  }

  patchCatalog(candidate, changes) {
    const entry = this.registry.catalog().find(m => m.executor === candidate.executor && m.id === candidate.model);
    this.registry.upsertModel({ ...entry, ...changes });
  }
}
