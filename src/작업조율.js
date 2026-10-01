import { buildHandoff, chooseProvider, createTask, TaskStatus } from './업무도메인.js';
import { DEFAULT_POLICY, assessUsage } from './정책.js';

export class Orchestrator {
  constructor({ store, adapter, workspaces, policy = DEFAULT_POLICY }) {
    this.workspaces = workspaces;
    this.store = store; this.adapter = adapter; this.policy = policy;
    this.active = new Map(); this.exhausted = new Set(); this.queue = [];
    this.usage = { claude: { windows: [] }, codex: { windows: [] } };
    for (const task of store.listTasks()) {
      if (['running','queued','handoff'].includes(task.status)) {
        task.status = 'recovery_required';
        task.checkpoint.nextAction = 'Inspect workspace before resuming interrupted execution';
        store.saveTask(task);
      }
    }
  }
  get availability() {
    return Object.fromEntries(['claude','codex'].map(p => [p,
      this.exhausted.has(p) ? 'exhausted' : this.adapter.enabled === false ? 'available' : assessUsage(this.usage[p]).state]));
  }
  snapshot() {
    return { tasks: this.store.listTasks(), availability: this.availability, usage: this.usage,
      mode: this.adapter.enabled === false ? 'simulation' : 'execution', active: this.active.size, policy: this.policy };
  }
  async submit(input) {
    const task = createTask(input);
    if (this.adapter.enabled !== false && (!this.workspaces || !task.completionCriteria.length)) {
      throw new Error('Execution requires project workspaces and explicit completion criteria');
    }
    task.status = task.requiresApproval ? TaskStatus.AWAITING_APPROVAL : TaskStatus.QUEUED;
    this.store.saveTask(task);
    await this.store.emit({ type: 'task.created', taskId: task.id, projectId: task.projectId });
    if (!task.requiresApproval) this.enqueue(task.id);
    return task;
  }
  async approve(id) {
    const task = this.store.getTask(id);
    if (!task || task.status !== TaskStatus.AWAITING_APPROVAL) throw new Error('task is not awaiting approval');
    task.status = TaskStatus.QUEUED; this.store.saveTask(task);
    await this.store.emit({ type: 'approval.granted', taskId: id }); this.enqueue(id); return task;
  }
  enqueue(id) { if (!this.queue.includes(id) && !this.active.has(id)) this.queue.push(id); queueMicrotask(() => this.drain()); }
  drain() {
    for (let i = 0; i < this.queue.length && this.active.size < this.policy.maxConcurrent;) {
      const task = this.store.getTask(this.queue[i]);
      const availability = { ...this.availability };
      for (const p of ['claude','codex']) {
        if ([...this.active.values()].filter(a => a.provider === p).length >= this.policy.providerConcurrent[p]) availability[p] = 'busy';
      }
      if ([...this.active.values()].some(a => a.projectId === task.projectId)) { i++; continue; }
      const provider = chooseProvider(task, availability);
      if (!provider) { task.status = 'waiting_capacity'; this.store.saveTask(task); i++; continue; }
      this.queue.splice(i, 1); this.active.set(task.id, { provider, projectId: task.projectId });
      this.execute(task, provider).catch(async error => {
        task.status = TaskStatus.FAILED; task.error = error.message; this.store.saveTask(task);
        await this.store.emit({ type: 'task.failed', taskId: task.id, message: error.message });
      }).finally(() => { this.active.delete(task.id); this.drain(); });
    }
  }
  async execute(task, provider) {
    if (this.adapter.enabled !== false && (!this.workspaces || !task.completionCriteria?.length)) {
      throw new Error('Execution requires project workspaces and explicit completion criteria');
    }
    const cwd = this.workspaces?.resolve(task.projectId);
    if (cwd) task.workspace = cwd;
    task.provider = provider; task.status = TaskStatus.RUNNING;
    task.checkpoint.nextAction = `Continue with ${provider}`; this.store.saveTask(task);
    await this.store.emit({ type: 'task.started', taskId: task.id, provider });
    const pending = [];
    const prompt = [task.prompt, '', 'Completion criteria:', ...(task.completionCriteria || []).map(item => `- ${item}`),
      'Report evidence against each criterion. Do not claim completion without verification.'].join('\n');
    const result = await this.adapter.run(provider, prompt, event => { pending.push(this.store.emit({ ...event, taskId: task.id })); }, { cwd });
    await Promise.all(pending);
    if (result.outcome === 'limited') {
      this.exhausted.add(provider);
      task.status = 'waiting_capacity'; task.handoffs = (task.handoffs || 0) + 1;
      const target = provider === 'claude' ? 'codex' : 'claude';
      task.prompt = buildHandoff(task, result.summary, target);
      task.checkpoint.nextAction = 'Inspect workspace and obtain fresh usage before continuing';
      this.store.saveTask(task);
      await this.store.emit({ type: 'task.handoff_pending', taskId: task.id, from: provider, to: target });
      if (task.handoffs < 2) this.queue.push(task.id);
      return;
    }
    task.status = result.outcome === 'simulated' ? 'simulated'
      : result.outcome === 'completed' ? 'awaiting_verification' : TaskStatus.FAILED;
    task.lastResult = result.summary;
    task.checkpoint.nextAction = task.status === 'awaiting_verification' ? 'Collect and verify completion evidence' : 'Inspect execution result';
    this.store.saveTask(task);
    await this.store.emit({ type: `task.${task.status}`, taskId: task.id, provider, message: result.summary });
  }
}
