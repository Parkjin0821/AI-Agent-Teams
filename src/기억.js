import { createHash, randomUUID } from 'node:crypto';
import { TEAMS } from './팀.js';

// 기억 (Muse-style memory 대장 can see, edit and forget). Kept across projects:
//   scope 'all'  — applies to every team (e.g. "답은 한국어로", "GPT-5.6 계열은 쓰지 않는다")
//   scope <team> — applies to one team (e.g. 디자인팀: "색은 남색 계열")
// Teams may only propose a memory in their report; it takes effect after 대장 approves it.
const KEY = 'memory.items';
const MAX_ITEMS = 60;

const clean = (text, max) => {
  const t = typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
  if (!t || t.length > max) throw new Error(`memory text must be 1 to ${max} characters`);
  return t;
};
const validScope = scope => scope === 'all' || Object.hasOwn(TEAMS, scope);

export class Memory {
  constructor({ store, clock = { now: () => Date.now() } }) { Object.assign(this, { store, clock }); }

  list() { return this.store.getSettings()[KEY] ?? []; }
  save(items) { this.store.setSetting(KEY, items.slice(-MAX_ITEMS)); }
  at() { return new Date(this.clock.now()).toISOString(); }

  add({ scope = 'all', text }) {
    if (!validScope(scope)) throw new Error('unknown memory scope');
    const item = { id: randomUUID(), scope, text: clean(text, 300), by: '대장', status: 'active', at: this.at() };
    this.save([...this.list(), item]);
    return item;
  }

  edit(id, { scope, text }) {
    const items = this.list();
    const item = items.find(i => i.id === id);
    if (!item) throw new Error('memory not found');
    if (scope !== undefined && !validScope(scope)) throw new Error('unknown memory scope');
    const next = { ...item, ...(scope !== undefined ? { scope } : {}), ...(text !== undefined ? { text: clean(text, 300) } : {}), editedAt: this.at() };
    this.save(items.map(i => (i.id === id ? next : i)));
    return next;
  }

  forget(id) {
    const items = this.list();
    if (!items.some(i => i.id === id)) throw new Error('memory not found');
    this.save(items.filter(i => i.id !== id));
    return { forgotten: true };
  }

  reset() { this.save([]); return { reset: true }; }

  approve(id) {
    const items = this.list();
    const item = items.find(i => i.id === id && i.status === 'pending');
    if (!item) throw new Error('no pending memory with that id');
    const next = { ...item, status: 'active', approvedAt: this.at() };
    this.save(items.map(i => (i.id === id ? next : i)));
    return next;
  }

  // A team's suggestions from its report (at most 3 per round, deduplicated). Never active until approved.
  propose(raw, { team, project }) {
    if (!Array.isArray(raw)) return [];
    const items = this.list();
    const seen = new Set(items.map(i => createHash('sha256').update(`${i.scope}|${i.text}`).digest('hex')));
    const added = [];
    for (const r of raw.slice(0, 3)) {
      const text = typeof r === 'string' ? r : r?.text;
      const scope = typeof r === 'object' && validScope(r?.scope) ? r.scope : 'all';
      let t; try { t = clean(text, 200); } catch { continue; }
      const h = createHash('sha256').update(`${scope}|${t}`).digest('hex');
      if (seen.has(h)) continue;
      seen.add(h);
      added.push({ id: randomUUID(), scope, text: t, by: TEAMS[team]?.name ?? team, project, status: 'pending', at: this.at() });
    }
    if (added.length) this.save([...items, ...added]);
    return added;
  }

  // What one team is told: 대장's approved memory for everyone and for that team.
  forTeam(team) {
    const active = this.list().filter(i => i.status === 'active');
    return { common: active.filter(i => i.scope === 'all').map(i => i.text), team: active.filter(i => i.scope === team).map(i => i.text) };
  }
}
