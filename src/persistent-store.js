import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export class PersistentStore {
  constructor({ dataDir }) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, 'hq.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);'
      + ' CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, body TEXT NOT NULL);'
      // UNIQUE(goal_id, round, attempt) is the last line of defence against duplicate rounds.
      + ' CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, round INTEGER NOT NULL, attempt INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(goal_id, round, attempt));'
      + ' CREATE TABLE IF NOT EXISTS policy_versions (scope TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope, version));'
      + ' CREATE TABLE IF NOT EXISTS model_catalog (executor TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(executor, id));'
      + ' CREATE TABLE IF NOT EXISTS model_evals (id TEXT PRIMARY KEY, body TEXT NOT NULL);'
      + ' CREATE TABLE IF NOT EXISTS model_candidates (id TEXT PRIMARY KEY, body TEXT NOT NULL);'
      + ' CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    this.listeners = new Set();
  }
  listGoals() { return this.db.prepare('SELECT body FROM goals').all().map(r => JSON.parse(r.body)); }
  getGoal(id) { const row = this.db.prepare('SELECT body FROM goals WHERE id=?').get(id); return row ? JSON.parse(row.body) : undefined; }
  saveGoal(goal) { this.db.prepare('INSERT INTO goals VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(goal.id, JSON.stringify(goal)); return goal; }
  listRuns(goalId) { return this.db.prepare('SELECT body FROM runs WHERE goal_id=? ORDER BY round, attempt').all(goalId).map(r => JSON.parse(r.body)); }
  insertRun(run) { this.db.prepare('INSERT INTO runs VALUES (?,?,?,?,?)').run(run.id, run.goalId, run.round, run.attempt, JSON.stringify(run)); return run; }
  saveRun(run) { this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(run), run.id); return run; }
  policyVersions(scope) { return this.db.prepare('SELECT body FROM policy_versions WHERE scope=? ORDER BY version').all(scope).map(r => JSON.parse(r.body)); }
  insertPolicyVersion(scope, record) { this.db.prepare('INSERT INTO policy_versions VALUES (?,?,?)').run(scope, record.version, JSON.stringify(record)); return record; }
  listCatalog() { return this.db.prepare('SELECT body FROM model_catalog ORDER BY executor, id').all().map(r => JSON.parse(r.body)); }
  saveCatalogEntry(entry) { this.db.prepare('INSERT INTO model_catalog VALUES (?,?,?) ON CONFLICT(executor, id) DO UPDATE SET body=excluded.body').run(entry.executor, entry.id, JSON.stringify(entry)); return entry; }
  listEvals() { return this.db.prepare('SELECT body FROM model_evals').all().map(r => JSON.parse(r.body)); }
  insertEval(record) { this.db.prepare('INSERT INTO model_evals VALUES (?,?)').run(record.id, JSON.stringify(record)); return record; }
  getCandidate(id) { const row = this.db.prepare('SELECT body FROM model_candidates WHERE id=?').get(id); return row ? JSON.parse(row.body) : undefined; }
  saveCandidate(candidate) { this.db.prepare('INSERT INTO model_candidates VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(candidate.id, JSON.stringify(candidate)); return candidate; }
  getSettings() { return Object.fromEntries(this.db.prepare('SELECT key, value FROM settings').all().map(r => [r.key, JSON.parse(r.value)])); }
  setSetting(key, value) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); return this.getSettings(); }
  deleteGoalRecords(goalId) {
    const runs = Number(this.db.prepare('DELETE FROM runs WHERE goal_id=?').run(goalId).changes);
    const events = Number(this.db.prepare("DELETE FROM events WHERE json_extract(body, '$.goalId')=?").run(goalId).changes);
    this.db.prepare('DELETE FROM goals WHERE id=?').run(goalId);
    return { runs, events };
  }
  deletePolicy(scope) { return Number(this.db.prepare('DELETE FROM policy_versions WHERE scope=?').run(scope).changes); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  listTasks() { return this.db.prepare('SELECT body FROM tasks').all().map(r => JSON.parse(r.body)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  getTask(id) { const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id); return row ? JSON.parse(row.body) : undefined; }
  saveTask(task) { task.updatedAt = new Date().toISOString(); this.db.prepare('INSERT INTO tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(task.id, JSON.stringify(task)); return task; }
  recentEvents(limit = 200) { return this.db.prepare('SELECT body, id FROM events ORDER BY id DESC LIMIT ?').all(limit).map(r => ({ ...JSON.parse(r.body), id: r.id })); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async emit(event) {
    const record = { at: new Date().toISOString(), ...event };
    const { lastInsertRowid } = this.db.prepare('INSERT INTO events(body) VALUES (?)').run(JSON.stringify(record));
    record.id = Number(lastInsertRowid);
    for (const listener of this.listeners) { try { listener(record); } catch { /* Disconnected UI must not stop work. */ } }
    return record;
  }
  close() { this.db.close(); }
}
