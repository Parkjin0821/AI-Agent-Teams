import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

// 대장 규칙: 대장's own rules on top of the Sentinel's fixed ones — for a site, a file path in the work folder, or a
// connected tool: 허용 (allow), 승인 필요 (ask), 금지 (deny); for all projects or one. The fixed safety rules (outside the
// work folder, settings files, secrets, internal addresses) always come first and no rule can open them. The rules
// live in a small JSON file the Sentinel hook process reads, like the site grants.
export const RULE_KINDS = ['site', 'path', 'connector'];
export const RULE_ACTIONS = ['allow', 'ask', 'deny'];
export const ACTION_L = { allow: '허용', ask: '승인 필요', deny: '금지' };
export const KIND_L = { site: '사이트', path: '파일 경로', connector: '연결 도구' };
const RANK = { deny: 3, ask: 2, allow: 1 };

export function readRules(file) {
  try { const data = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(data.rules) ? data.rules : []; } catch { return []; }
}

// A path pattern: "docs/" (that folder), "*.env" style globs with * (one level) and ** (any depth), or an exact path.
export function matchPath(pattern, rel) {
  const p = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
  const r = String(rel).replace(/\\/g, '/');
  if (!p) return false;
  if (p.endsWith('/')) return r.startsWith(p);
  if (!p.includes('*')) return r === p || r.startsWith(`${p}/`);
  const re = new RegExp(`^${p.split('**').map(part => part.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`);
  return re.test(r) || (!p.includes('/') && re.test(r.split('/').pop()));
}
const matches = (rule, target) => {
  if (rule.kind === 'site') return target === rule.target || target.endsWith(`.${rule.target}`);
  if (rule.kind === 'path') return matchPath(rule.target, target);
  return target.toLowerCase().includes(rule.target.toLowerCase());
};

// The strongest rule that applies (금지 > 승인 필요 > 허용), or null.
export function ruleFor(rules, { kind, target, project }) {
  let best = null;
  for (const r of rules ?? []) {
    if (r.kind !== kind || (r.project && r.project !== project) || !matches(r, String(target ?? ''))) continue;
    if (!best || RANK[r.action] > RANK[best.action]) best = r;
  }
  return best;
}

// Files a step added or changed that a 금지 or 승인 필요 path rule covers (checked after every step, since Codex's
// actions cannot be stopped one by one; for Claude the Sentinel already stopped them).
export function pathViolations(rules, project, changed = []) {
  const out = [];
  for (const file of changed) {
    const rule = ruleFor(rules, { kind: 'path', target: file, project });
    if (rule && rule.action !== 'allow') out.push({ file, rule: { id: rule.id, target: rule.target, action: rule.action, note: rule.note ?? '' } });
  }
  return out;
}

// A short block for the team prompt so teams do not spend steps on what is forbidden.
export function rulesPrompt(rules, project) {
  const mine = (rules ?? []).filter(r => !r.project || r.project === project);
  if (!mine.length) return '';
  const line = r => `- ${ACTION_L[r.action]} · ${KIND_L[r.kind]} ${r.target}${r.note ? ` (${r.note})` : ''}`;
  return `\n[대장 규칙 · 반드시 지킨다. 금지는 하지 말고, 승인 필요는 대장 승인 전에는 하지 않는다]\n${mine.map(line).join('\n')}\n`;
}

export class Rules {
  constructor({ file, clock = { now: () => Date.now() } }) { Object.assign(this, { file, clock }); }
  list() { return readRules(this.file); }
  write(rules) {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ rules }, null, 1));
    renameSync(temp, this.file);
  }
  add(input = {}) {
    const kind = input.kind, action = input.action;
    if (!RULE_KINDS.includes(kind)) throw new Error('rule kind must be site, path or connector');
    if (!RULE_ACTIONS.includes(action)) throw new Error('rule action must be allow, ask or deny');
    let target = String(input.target ?? '').trim();
    if (kind === 'site') target = target.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
    if (kind === 'path') target = target.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!target || target.length > 200) throw new Error('rule target is required');
    if (kind === 'site' && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(target)) throw new Error('site must be a host name like example.com');
    if (kind === 'path' && (target.startsWith('..') || /^[a-zA-Z]:/.test(target))) throw new Error('path rules apply inside the work folder only');
    const rule = { id: randomUUID(), kind, target, action, project: input.project ? String(input.project) : null,
      note: String(input.note ?? '').trim().slice(0, 200), at: new Date(this.clock.now()).toISOString(), by: '대장' };
    this.write([...this.list(), rule]);
    return rule;
  }
  remove(id) {
    const rules = this.list();
    if (!rules.some(r => r.id === id)) throw new Error('rule not found');
    this.write(rules.filter(r => r.id !== id));
    return { removed: id };
  }
}
