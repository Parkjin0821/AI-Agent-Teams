import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export class MemoryStore {
  constructor({ dataDir = path.join(process.cwd(), "data") } = {}) {
    this.tasks = new Map();
    this.events = [];
    this.dataDir = dataDir;
    this.listeners = new Set();
  }

  listTasks() { return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  getTask(id) { return this.tasks.get(id); }
  saveTask(task) { task.updatedAt = new Date().toISOString(); this.tasks.set(task.id, task); return task; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async emit(event) {
    const record = { id: this.events.length + 1, at: new Date().toISOString(), ...event };
    this.events.push(record);
    if (this.events.length > 500) this.events.shift();
    for (const listener of this.listeners) listener(record);
    await mkdir(this.dataDir, { recursive: true });
    await appendFile(path.join(this.dataDir, "audit.jsonl"), `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }
}
