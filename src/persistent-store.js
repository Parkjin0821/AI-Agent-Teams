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
      + ' CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, round INTEGER NOT NULL, attempt INTEGER NOT NULL, body TEXT NOT NULL, UNIQUE(goal_id, round, attempt));');
    this.listeners = new Set();
  }
  listGoals() { return this.db.prepare('SELECT body FROM goals').all().map(r => JSON.parse(r.body)); }
  getGoal(id) { const row = this.db.prepare('SELECT body FROM goals WHERE id=?').get(id); return row ? JSON.parse(row.body) : undefined; }
  saveGoal(goal) { this.db.prepare('INSERT INTO goals VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(goal.id, JSON.stringify(goal)); return goal; }
  listRuns(goalId) { return this.db.prepare('SELECT body FROM runs WHERE goal_id=? ORDER BY round, attempt').all(goalId).map(r => JSON.parse(r.body)); }
  insertRun(run) { this.db.prepare('INSERT INTO runs VALUES (?,?,?,?,?)').run(run.id, run.goalId, run.round, run.attempt, JSON.stringify(run)); return run; }
  saveRun(run) { this.db.prepare('UPDATE runs SET body=? WHERE id=?').run(JSON.stringify(run), run.id); return run; }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  listTasks() { return this.db.prepare('SELECT body FROM tasks').all().map(r => JSON.parse(r.body)).sort((a,b) => b.createdAt.localeCompare(a.createdAt)); }
  getTask(id) { const row = this.db.prepare('SELECT body FROM tasks WHERE id=?').get(id); return row ? JSON.parse(row.body) : undefined; }
  saveTask(task) { task.updatedAt = new Date().toISOString(); this.db.prepare('INSERT INTO tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(task.id, JSON.stringify(task)); return task; }
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
