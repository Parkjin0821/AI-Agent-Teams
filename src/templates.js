import { randomUUID } from 'node:crypto';
import { FRESH_CRITERION } from './routines.js';

// 템플릿: a finished project's recipe — objective, completion criteria and 대장's per-team model picks — saved under a
// name so a new project can start from it with new input (e.g. the same price survey for another product). Files and
// conversation are not copied; the new project gets its own empty work folder.
const KEY = 'templates';
const MAX = 50;

export class Templates {
  constructor({ store, registry = null, clock = { now: () => Date.now() } }) {
    Object.assign(this, { store, registry, clock });
  }

  list() { return this.store.getSettings()[KEY] ?? []; }
  get(id) { return this.list().find(t => t.id === id) ?? null; }

  save({ projectId, name }) {
    const goals = this.store.listGoals().filter(g => g.projectId === projectId && g.kind === 'team')
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const goal = goals.find(g => g.status === 'verified') ?? goals[0];
    if (!goal) throw new Error('project not found');
    if (!goal.completionCriteria?.length) throw new Error('a template needs completion criteria (approve them first)');
    const label = String(name ?? '').trim().slice(0, 60) || String(goal.title || goal.objective).slice(0, 60);
    const policy = this.registry?.getPolicy(`project:${projectId}`) ?? {};
    const template = {
      id: randomUUID(), name: label, fromProject: projectId, fromTitle: goal.title ?? null, verified: goal.status === 'verified',
      // a routine round's note and its "updated this round" criterion belong to routines, not to the recipe
      objective: String(goal.objective).replace(/\n\n\[반복 실행 [\s\S]*$/, '').slice(0, 4000),
      completionCriteria: goal.completionCriteria.filter(c => c !== FRESH_CRITERION).slice(0, 20),
      teamModels: policy.teamModels ?? {}, createdAt: new Date(this.clock.now()).toISOString(), used: 0,
    };
    this.store.setSetting(KEY, [template, ...this.list()].slice(0, MAX));
    return template;
  }

  remove(id) {
    const list = this.list();
    if (!list.some(t => t.id === id)) throw new Error('template not found');
    this.store.setSetting(KEY, list.filter(t => t.id !== id));
    return { removed: id };
  }

  markUsed(id) {
    this.store.setSetting(KEY, this.list().map(t => t.id === id ? { ...t, used: (t.used ?? 0) + 1, lastUsedAt: new Date(this.clock.now()).toISOString() } : t));
  }
}
