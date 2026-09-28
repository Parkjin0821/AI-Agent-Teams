import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CliAgentAdapter } from './adapters.js';
import { createGoalRunner } from './goal-runner.js';
import { ModelRegistry } from './model-policy.js';
import { Orchestrator } from './orchestrator.js';
import { PersistentStore } from './persistent-store.js';
import { GoalScheduler } from './scheduler.js';
import { ProjectWorkspaces, validateProjectId } from './workspaces.js';

const MAX_BODY = 1_000_000;
const iso = ms => new Date(ms).toISOString();

export function createApp({ root, dataDir, projectsDir, enableExec = false, clock = { now: () => Date.now() }, tickMs = null, adapter: injectedAdapter = null }) {
  const store = new PersistentStore({ dataDir });
  const workspaces = new ProjectWorkspaces(projectsDir);
  const adapter = injectedAdapter ?? new CliAgentAdapter({ enabled: enableExec, cwd: root });
  // Real execution spends subscription usage: the timer then only advances projects 대장 started
  // (plus explicit single-goal runs). In simulation it advances everything.
  const executing = adapter.enabled !== false;
  const autoTick = Boolean(tickMs);
  const autoScope = executing ? 'started' : 'all';
  const orchestrator = new Orchestrator({ store, workspaces, adapter });
  const registry = new ModelRegistry({ store, clock });
  const scheduler = new GoalScheduler({ store, clock, registry, runner: createGoalRunner({ adapter, workspaces, store }) });

  const engineView = () => {
    const byProject = new Map();
    for (const goal of store.listGoals().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (!byProject.has(goal.projectId)) byProject.set(goal.projectId, []);
      byProject.get(goal.projectId).push({ ...goal, runs: store.listRuns(goal.id), model: scheduler.modelStatus(goal.id) });
    }
    return {
      mode: executing ? 'execution' : 'simulation', autoTick, autoScope, now: iso(clock.now()),
      limits: { maxRoundsPerDay: scheduler.policy.maxRoundsPerDay, maxConcurrent: scheduler.policy.maxConcurrent, providerConcurrent: scheduler.policy.providerConcurrent },
      projects: [...byProject].map(([id, goals]) => ({ id, policy: registry.getPolicy(`project:${id}`), goals })),
      catalog: registry.catalog(), events: store.recentEvents(200),
    };
  };

  const routes = [
    ['GET', /^\/api\/state$/, () => orchestrator.snapshot()],
    ['GET', /^\/api\/engine$/, () => engineView()],
    ['POST', /^\/api\/tasks$/, (m, body) => [202, orchestrator.submit(body)]],
    ['POST', /^\/api\/tasks\/([^/]+)\/approve$/, m => orchestrator.approve(m[1])],
    ['POST', /^\/api\/goals$/, (m, body) => [201, scheduler.addGoal(body)]],
    ['POST', /^\/api\/goals\/([^/]+)\/pause$/, m => scheduler.pause(m[1])],
    ['POST', /^\/api\/goals\/([^/]+)\/resume$/, m => scheduler.resume(m[1])],
    // New project: no ID to type — the engine makes one. The AI team works it once started.
    ['POST', /^\/api\/projects$/, (m, body) => [201, scheduler.addGoal({
      projectId: `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, kind: 'team',
      title: body.title, objective: body.objective, completionCriteria: body.completionCriteria, autoRun: body.start === true })]],
    ['POST', /^\/api\/goals\/([^/]+)\/start$/, m => scheduler.start(m[1])],
    ['POST', /^\/api\/goals\/([^/]+)\/stop$/, m => scheduler.stop(m[1])],
    ['POST', /^\/api\/goals\/([^/]+)\/answer$/, (m, body) => scheduler.answer(m[1], body.text)],
    ['POST', /^\/api\/goals\/([^/]+)\/proposal\/accept$/, m => [201, scheduler.acceptProposal(m[1])]],
    ['POST', /^\/api\/goals\/([^/]+)\/proposal\/dismiss$/, m => scheduler.dismissProposal(m[1])],
    ['POST', /^\/api\/goals\/([^/]+)\/confirm$/, (m, body) => scheduler.confirmCriterion(m[1], String(body.criterion ?? ''), body.note)],
    ['POST', /^\/api\/goals\/([^/]+)\/run$/, async m => { await scheduler.runGoal(m[1]); return engineView(); }],
    ['POST', /^\/api\/engine\/tick$/, async () => {
      if (executing) throw new Error('real execution is on: run one goal at a time with /api/goals/:id/run');
      await scheduler.tick();
      return engineView();
    }],
    ['DELETE', /^\/api\/projects\/([^/]+)$/, async (m, body) => {
      const projectId = validateProjectId(m[1]);
      const goals = store.listGoals().filter(g => g.projectId === projectId);
      if (!goals.length) throw new Error('project not found');
      if (goals.some(g => g.status === 'running')) throw new Error('project has a running round; wait for it to finish');
      const removed = store.transaction(() => {
        let runs = 0;
        for (const goal of goals) runs += store.deleteGoalRecords(goal.id).runs;
        store.deletePolicy(`project:${projectId}`);
        return { goals: goals.length, runs };
      });
      // Files the agents made are the user's work: kept unless explicitly asked to delete.
      const filesDeleted = body.deleteFiles === true ? workspaces.remove(projectId) : false;
      await store.emit({ type: 'project.deleted', projectId, goals: removed.goals, filesDeleted });
      return { projectId, ...removed, filesDeleted };
    }],
    ['PUT', /^\/api\/projects\/([^/]+)\/model-policy$/, (m, body) => {
      const changes = {};
      if (body.mode !== undefined) changes.mode = body.mode;
      if (body.model !== undefined) changes.model = typeof body.model === 'string' ? body.model.trim() : body.model;
      if (body.allowFallback !== undefined) changes.allowFallback = body.allowFallback === true;
      return registry.setPolicy(`project:${validateProjectId(m[1])}`, changes, { by: '대장', reason: String(body.reason || 'dashboard') });
    }],
  ];

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return response.end(await readFile(path.join(root, 'outputs', 'dashboard.html')));
      }
      if (request.method === 'GET' && url.pathname === '/api/events') return streamEvents(request, response, store);
      for (const [method, pattern, handler] of routes) {
        const match = url.pathname.match(pattern);
        if (request.method !== method || !match) continue;
        let body = {};
        if (method !== 'GET') {
          // Requiring JSON forces a CORS preflight, so other sites cannot post to this local server.
          if (!/^application\/json\b/i.test(request.headers['content-type'] || '')) return sendJson(response, 415, { error: 'content-type must be application/json' });
          body = await readJson(request);
        }
        const result = await handler(match, body);
        const [status, value] = Array.isArray(result) ? [result[0], await result[1]] : [200, result];
        return sendJson(response, status, value);
      }
      sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
  });

  const timer = autoTick ? setInterval(() => scheduler.tick({ autoOnly: executing }).catch(error => console.error('tick failed:', error.message)), tickMs) : null;
  timer?.unref();
  return {
    server, store, scheduler, registry, orchestrator, workspaces,
    close: () => new Promise(resolve => { if (timer) clearInterval(timer); server.close(() => { store.close(); resolve(); }); }),
  };
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function streamEvents(request, response, store) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  response.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  const unsubscribe = store.subscribe(event => response.write(`data: ${JSON.stringify(event)}\n\n`));
  request.on('close', unsubscribe);
}
