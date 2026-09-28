import { validateExecutor } from './models.js';

// Two kinds of record: 'project' = our own run of an eval task under fixed conditions (comparable),
// 'public_benchmark' = a published score (reference only, never mixed into project comparisons).
const RATES = ['criteriaPassRate', 'testPassRate'];

export function validateEval(record) {
  if (record?.source === 'public_benchmark') {
    for (const key of ['model', 'benchmark', 'url']) if (!record[key]) throw new Error(`public benchmark requires ${key}`);
    if (!Number.isFinite(record.score)) throw new Error('public benchmark requires numeric score');
    return record;
  }
  if (record?.source !== 'project') throw new Error('source must be project or public_benchmark');
  for (const key of ['model', 'modelVersion', 'reasoning', 'executorVersion', 'evalTaskId', 'conditionsKey']) {
    if (typeof record[key] !== 'string' || !record[key].trim()) throw new Error(`evaluation requires ${key}`);
  }
  validateExecutor(record.executor);
  const m = record.metrics ?? {};
  for (const key of RATES) if (!(m[key] >= 0 && m[key] <= 1)) throw new Error(`${key} must be between 0 and 1`);
  for (const key of ['reworkCount', 'violations']) if (!Number.isInteger(m[key]) || m[key] < 0) throw new Error(`${key} must be a non-negative integer`);
  if (!(m.durationMs >= 0)) throw new Error('durationMs must be non-negative');
  if (m.usage != null) {
    if (m.usage.estimated) throw new Error('estimated usage is not accepted; record null when usage is unverified');
    if (!Number.isFinite(m.usage.value) || !m.usage.unit || !m.usage.verifiedSource) {
      throw new Error('usage needs value, unit and verifiedSource');
    }
  }
  return record;
}

export function compareModels(records, { evalTaskId, conditionsKey, baseline, candidate }) {
  const same = records.filter(r => r.source === 'project' && r.evalTaskId === evalTaskId && r.conditionsKey === conditionsKey);
  const result = {
    evalTaskId, conditionsKey,
    baseline: aggregate(same.filter(r => r.model === baseline), baseline),
    candidate: aggregate(same.filter(r => r.model === candidate), candidate),
    publicBenchmarks: records.filter(r => r.source === 'public_benchmark' && [baseline, candidate].includes(r.model)),
  };
  if (!result.baseline.runs || !result.candidate.runs) {
    return { ...result, comparable: false, recommendation: 'insufficient_data', reasons: ['no runs under the same task and conditions'] };
  }
  const b = result.baseline, c = result.candidate, reasons = [];
  if (c.violations > 0) reasons.push(`candidate had ${c.violations} permission violation(s) or unapproved action(s)`);
  if (c.criteriaPassRate < b.criteriaPassRate) reasons.push('lower completion-criteria pass rate');
  if (c.testPassRate < b.testPassRate) reasons.push('lower test pass rate');
  if (c.reworkCount > b.reworkCount) reasons.push('more rework');
  // A recommendation only; changing the default model still needs approval (see model-changes.js).
  return { ...result, comparable: true, recommendation: reasons.length ? 'keep_baseline' : 'candidate', reasons };
}

function aggregate(runs, model) {
  const mean = key => runs.length ? runs.reduce((sum, r) => sum + r.metrics[key], 0) / runs.length : null;
  const usages = runs.map(r => r.metrics.usage);
  const usageKnown = runs.length && usages.every(u => u && u.unit === usages[0].unit);
  return {
    model, runs: runs.length,
    criteriaPassRate: mean('criteriaPassRate'), testPassRate: mean('testPassRate'),
    reworkCount: mean('reworkCount'), durationMs: mean('durationMs'),
    violations: runs.reduce((sum, r) => sum + r.metrics.violations, 0),
    usage: usageKnown ? { value: usages.reduce((s, u) => s + u.value, 0) / usages.length, unit: usages[0].unit } : null,
    versions: [...new Set(runs.map(r => `${r.modelVersion} · ${r.reasoning} · ${r.executor}@${r.executorVersion}`))],
  };
}
