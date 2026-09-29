import { createServer } from 'node:http';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { CliAgentAdapter, resolveBins } from './adapters.js';
import { designConnectors, EnvironmentMonitor, environmentView, validateSetting } from './environments.js';
import { createGoalRunner } from './goal-runner.js';
import { ModelRegistry } from './model-policy.js';
import { Orchestrator } from './orchestrator.js';
import { PersistentStore } from './persistent-store.js';
import { GoalScheduler } from './scheduler.js';
import { SandboxRunner } from './sandbox.js';
import { TEAMS } from './teams.js';
import { Digests } from './digest.js';
import { checkAttachments, DEFAULT_MAX_MB, saveAttachment } from './attachments.js';
import { toolkitView } from './toolkit.js';
import { ProjectWorkspaces, validateProjectId } from './workspaces.js';
import { readUsage, recordRateLimits } from './usage.js';
import { projectRecord } from './records.js';
import { capacityBasis, subscriptionCapacity } from './subscription-safety.js';
import { artifactList, readArtifact } from './artifacts.js';
import { detectTests } from './checks.js';
import { npmCommand } from './sandbox.js';
import { AutoSave } from './auto-save.js';
import { ModelChoices } from './model-choices.js';
import { SkillLibrary } from './skills.js';
import { Approvals, SCOPES } from './approvals.js';
import { Memory } from './memory.js';

const MAX_BODY = 1_000_000;
const iso = ms => new Date(ms).toISOString();

export function createApp({ root, dataDir, projectsDir, enableExec = false, clock = { now: () => Date.now() }, tickMs = null,
  adapter: injectedAdapter = null, monitor: injectedMonitor = null, sandbox: injectedSandbox = null, detectEnvironments = false,
  enforceSafety = false, usageReader = readUsage, saveTransport = undefined, modelChoices = new ModelChoices({ clock }) }) {
  const store = new PersistentStore({ dataDir });
  const skills = new SkillLibrary({ store });
  const approvals = new Approvals({ store, grantsFile: path.join(dataDir, 'sentinel-grants.json'), clock });
  const memory = new Memory({ store, clock });
  const setting = (key, fallback) => store.getSettings()[key] ?? fallback;
  // 신뢰 쌓기 counters: how many results of each work team 대장 has accepted (all projects).
  const trust = { required: () => setting('trust.required', 3), count: team => setting(`trust.count.${team}`, 0),
    add: team => store.setSetting(`trust.count.${team}`, setting(`trust.count.${team}`, 0) + 1),
    // 대장 decides this kind of work has earned trust: later results continue without a review.
    complete: team => store.setSetting(`trust.count.${team}`, Math.max(setting(`trust.count.${team}`, 0) + 1, setting('trust.required', 3))) };
  const digests = new Digests({ store, approvals, clock, setting });
  const sentinelLog = path.join(dataDir, 'sentinel.jsonl');
  const workspaces = new ProjectWorkspaces(projectsDir);
  const autoSave = new AutoSave({ store, workspaces, transport: saveTransport, clock });
  const adapter = injectedAdapter ?? new CliAgentAdapter({ enabled: enableExec, cwd: root });
  // Real execution spends subscription usage: the timer then only advances projects 대장 started
  // (plus explicit single-goal runs). In simulation it advances everything.
  const executing = adapter.enabled !== false;
  const autoTick = Boolean(tickMs);
  const autoScope = executing ? 'started' : 'all';
  const orchestrator = new Orchestrator({ store, workspaces, adapter });
  const registry = new ModelRegistry({ store, clock });
  // Connection status comes from the tools' own commands (run only when asked, never in tests by default).
  const monitor = injectedMonitor ?? (detectEnvironments ? new EnvironmentMonitor({ bins: resolveBins(), clock }) : null);
  if (monitor && !monitor.snapshot) monitor.refresh().catch(() => {});
  // Only the design team gets claude.ai connectors, and only the ones 대장 turned on; the rest are denied.
  const toolsFor = (team) => (team === 'design'
    ? { connectors: designConnectors(monitor?.snapshot, store.getSettings()), knownConnectors: (monitor?.snapshot?.connectors ?? []).map(c => c.name) }
    : {});
  // Project tests run in the Codex sandbox (no model call, no network); only used in real execution.
  const sandbox = injectedSandbox ?? (executing ? new SandboxRunner({ codex: resolveBins().codex }) : null);
  let quota = [], quotaCheckedAt = 0;
  const refreshUsage = async () => {
    await monitor?.refreshAuthentication?.();
    quota = await usageReader(dataDir); quotaCheckedAt = Date.now();
    for (const item of quota.items ?? []) item.basis = capacityBasis(item);
    return quota;
  };
  const guarded = executing && (!injectedAdapter || enforceSafety);
  const capacity = executor => {
    if (store.getSettings()['safety.limitStorageFailed'] === true) return false;
    const account = monitor?.snapshot?.[executor === 'codex' ? 'codex' : 'claude'];
    const q = (quota.items ?? []).find(q => q.provider === (executor === 'codex' ? 'codex' : 'claude'));
    // An old statusLine reading is shown on the usage page but never counts as headroom here, and a
    // team run that saw the limit near or hit ("allowed_warning" / "rejected") holds new rounds until its reset.
    return subscriptionCapacity(account, q, quotaCheckedAt);
  };
  const scheduler = new GoalScheduler({ store, clock, registry,
    capacity: guarded ? capacity : null,
    dailyCap: () => store.getSettings()['limits.maxRoundsPerDay'],
    trust,
    capabilities: team => ({ 'claude-code': ['text','code', ...(TEAMS[team]?.web ? ['web'] : []),
      ...(toolsFor(team).connectors?.length ? ['connectors'] : [])], codex: ['text','code'] }),
    runner: createGoalRunner({ adapter, workspaces, store, toolsFor, sandbox, settings: () => store.getSettings(),
      onRateLimits: async limits => {
        try { await recordRateLimits(dataDir, limits); }
        catch (error) {
          store.setSetting('safety.limitStorageFailed', true);
          await store.emit({ type: 'usage.storage_failed', message: '한도 상태 저장 실패 · 실제 실행 차단' });
          throw error;
        }
      }, catalog: () => registry.catalog(),
      // 감시 에이전트: checks every Claude tool call before it runs (see src/sentinel.js).
      sentinel: { script: path.join(root, 'scripts', 'sentinel-hook.mjs'), log: sentinelLog, grants: approvals.grantsFile },
      approvals, memory }) });
  const teamsView = () => {
    const settings = store.getSettings();
    const tools = toolkitView(monitor?.snapshot ?? null, settings, environmentView(monitor?.snapshot ?? null, settings));
    return { checkedAt: monitor?.snapshot?.checkedAt ?? null,
      teams: Object.values(TEAMS).map(t => ({ id: t.id, name: t.name, executor: t.executor, access: t.access, tools: tools[t.id] ?? [] })) };
  };

  const engineView = () => {
    const byProject = new Map();
    for (const goal of store.listGoals().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      if (!byProject.has(goal.projectId)) byProject.set(goal.projectId, []);
      byProject.get(goal.projectId).push({ ...goal, runs: store.listRuns(goal.id), model: scheduler.modelStatus(goal.id) });
    }
    return {
      mode: executing ? 'execution' : 'simulation', autoTick, autoScope, now: iso(clock.now()),
      limits: { attachMaxMB: setting('attach.maxMB', DEFAULT_MAX_MB), maxRoundsPerDay: scheduler.dailyLimit(), maxRoundsPerDayDefault: scheduler.policy.maxRoundsPerDay, maxConcurrent: scheduler.policy.maxConcurrent, providerConcurrent: scheduler.policy.providerConcurrent },
      projects: [...byProject].map(([id, goals]) => ({ id, policy: registry.getPolicy(`project:${id}`), goals, autoSave: autoSave.view(id) })),
      catalog: registry.catalog(), events: store.recentEvents(200),
      limitStorageFailed: store.getSettings()['safety.limitStorageFailed'] === true,
    };
  };
  const existingWorkspace = projectId => {
    const id = validateProjectId(projectId);
    if (!store.listGoals().some(g => g.projectId === id)) throw new Error('project not found');
    return workspaces.resolve(id);
  };
  const testConsoleBusy = new Set();

  // Attachments named in a message must already be saved in that goal's project folder.
  const attachmentsFor = (goalId, list) => {
    if (list === undefined || list === null || (Array.isArray(list) && !list.length)) return [];
    const goal = store.getGoal(goalId);
    if (!goal) throw new Error('goal not found');
    return checkAttachments(existingWorkspace(goal.projectId), list);
  };
  const routes = [
    ['GET', /^\/api\/skills$/, () => ({items:skills.list(),discovery:store.getSettings()['skill.discovery'] || null})],
    ['POST', /^\/api\/skills$/, (m,body) => skills.register(body)],
    ['POST', /^\/api\/skills\/draft$/, (m,body) => skills.draft(body)],
    ['POST', /^\/api\/skills\/discover$/, (m,body) => skills.discover(body)],
    ['POST', /^\/api\/skills\/import$/, (m,body) => skills.importGitHub(body)],
    ['POST', /^\/api\/skills\/([a-f0-9]{64})\/review$/, (m,body) => skills.review(m[1],body)],
    ['POST', /^\/api\/skills\/([a-f0-9]{64})\/activate$/, (m,body) => skills.activate(m[1],body)],
    ['POST', /^\/api\/skills\/([a-f0-9]{64})\/disable$/, m => skills.disable(m[1])],
    ['GET', /^\/api\/projects\/([^/]+)\/auto-save$/, m => { existingWorkspace(m[1]); return autoSave.view(m[1]); }],
    ['PUT', /^\/api\/projects\/([^/]+)\/auto-save$/, (m, body) => autoSave.configure(validateProjectId(m[1]), body)],
    ['POST', /^\/api\/projects\/([^/]+)\/auto-save\/check$/, async m => {
      existingWorkspace(m[1]); await autoSave.tick(); return autoSave.view(m[1]);
    }],
    ['GET', /^\/api\/projects\/([^/]+)\/artifacts$/, m => ({ items: artifactList(existingWorkspace(m[1])) })],
    ['POST', /^\/api\/projects\/([^/]+)\/console\/test$/, async (m, body) => {
      const id = validateProjectId(m[1]), cwd = existingWorkspace(id);
      if (body.confirm !== true || Object.keys(body).some(k => k !== 'confirm')) throw new Error('fixed test command requires confirmation; arbitrary commands forbidden');
      if (store.listGoals().some(g => g.projectId === id && g.status === 'running') || testConsoleBusy.has(id)) throw new Error('project is busy');
      if (!sandbox?.available) throw new Error('sandbox unavailable; no fallback outside sandbox');
      const spec = detectTests(cwd);
      if (!spec) throw new Error('no project test command found');
      const command = spec.runner === 'npm' ? npmCommand(['test']) : spec.runner === 'node' ? [process.execPath, '--test'] : ['python', '-m', 'unittest'];
      testConsoleBusy.add(id);
      try {
        const result = await sandbox.run(cwd, command);
        await store.emit({ type: 'project.console_test', projectId: id, status: result.status });
        // No raw test output is stored: project code can print credentials.
        return { label: spec.label, status: result.status, code: result.code, outputHidden: true,
          note: '테스트 원문에는 비밀정보가 있을 수 있어 출력하지 않습니다. 테스트 결과 상태만 표시합니다.' };
      } finally { testConsoleBusy.delete(id); }
    }],
    ['POST', /^\/api\/safety\/limit-storage\/recover$/, async (m, body) => {
      if (body.confirm !== true) throw new Error('explicit recovery confirmation required');
      if (store.listGoals().some(g => g.status === 'running')) throw new Error('wait for running checkpoints');
      await recordRateLimits(dataDir, []);
      try { JSON.parse(await readFile(path.join(dataDir, 'claude-limit-status.json'), 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const probe = path.join(dataDir, `limit-probe-${randomUUID()}`);
      try { await writeFile(probe, '{}', { flag: 'wx' }); await rename(probe, `${probe}.ok`); }
      finally { await unlink(probe).catch(() => {}); await unlink(`${probe}.ok`).catch(() => {}); }
      store.setSetting('safety.limitStorageFailed', false);
      await store.emit({ type: 'usage.storage_recovered', by: '대장' });
      return { recovered: true, resumed: false };
    }],
    ['POST', /^\/api\/goals\/([^/]+)\/criteria\/approve$/, (m, body) => {
      const g = store.getGoal(m[1]);
      if (body.confirm !== true || !g?.criteriaApprovalPending || g.status !== 'review_required') throw new Error('criteria approval unavailable');
      if (JSON.stringify(body.criteria) !== JSON.stringify(g.completionCriteria)) throw new Error('completion criteria changed; review again');
      const at = new Date(clock.now()).toISOString();
      scheduler.update(g, { criteriaApprovalPending: false, messages: [...(g.messages ?? []),
        { role: 'user', kind: 'approval', text: `완료 조건 ${g.completionCriteria.length}개를 승인했습니다.`, at }].slice(-100) });
      void store.emit({ type: 'goal.criteria_approved', goalId: g.id, by: '대장' });
      return scheduler.resume(g.id);
    }],
    ['GET', /^\/api\/usage$/, refreshUsage],
    ['GET', /^\/api\/state$/, () => orchestrator.snapshot()],
    ['GET', /^\/api\/engine$/, () => engineView()],
    ['GET', /^\/api\/environments$/, () => ({ checkedAt: monitor?.snapshot?.checkedAt ?? null,
      items: environmentView(monitor?.snapshot ?? null, store.getSettings()), settings: store.getSettings() })],
    ['POST', /^\/api\/environments\/refresh$/, async () => {
      if (!monitor) throw new Error('environment detection is off');
      await monitor.refresh();
      return { checkedAt: monitor.snapshot.checkedAt, items: environmentView(monitor.snapshot, store.getSettings()), settings: store.getSettings() };
    }],
    ['GET', /^\/api\/teams$/, () => teamsView()],
    ['GET', /^\/api\/models$/, () => ({ items: registry.catalog(), verificationMode: 'manual_official_ui', automaticAccountVerification: false })],
    ['POST', /^\/api\/models$/, (m, body) => [201, registry.registerModel(body)]],
    ['POST', /^\/api\/models\/attest$/, (m, body) => registry.attestModel(body.executor, body.id, body)],
    ['GET', /^\/api\/projects\/([^/]+)\/records$/, m => projectRecord(store, validateProjectId(m[1]))],
    ['PUT', /^\/api\/settings$/, (m, body) => {
      const key = String(body.key);
      const settings = store.setSetting(key, validateSetting(key, body.value));
      // A changed daily limit is re-checked now: projects held until midnight try again at the next tick
      // (and go back to waiting if they are still over the new limit).
      if (key === 'limits.maxRoundsPerDay') {
        for (const g of store.listGoals().filter(g => g.reason === 'daily_cap')) scheduler.update(g, { reason: null, nextRunAt: new Date(clock.now()).toISOString() });
      }
      return settings;
    }],
    ['POST', /^\/api\/tasks$/, (m, body) => [202, orchestrator.submit(body)]],
    ['POST', /^\/api\/tasks\/([^/]+)\/approve$/, m => orchestrator.approve(m[1])],
    ['POST', /^\/api\/goals$/, (m, body) => [201, scheduler.addGoal(body)]],
    ['POST', /^\/api\/goals\/([^/]+)\/pause$/, m => scheduler.pause(m[1])],
    ['POST', /^\/api\/goals\/([^/]+)\/resume$/, m => scheduler.resume(m[1])],
    // New project: no ID to type — the engine makes one. The AI team works it once started.
    ['POST', /^\/api\/projects$/, (m, body) => {
      const goal = scheduler.addGoal({
      projectId: `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, kind: 'team',
      title: body.title, objective: body.objective, conversation: body.conversation === true, completionCriteria: body.completionCriteria, autoRun: body.start === true });
      // New projects start on each app's default model; 대장 picks a model per team in the project settings.
      return [201, goal];
    }],
    ['POST', /^\/api\/goals\/([^/]+)\/messages$/, (m, body) => scheduler.message(m[1], body.text, attachmentsFor(m[1], body.attachments))],
    ['PUT', /^\/api\/goals\/([^/]+)\/autonomy$/, (m, body) => scheduler.setAutonomy(m[1], body)],
    ['POST', /^\/api\/goals\/([^/]+)\/start$/, m => scheduler.start(m[1])],
    ['POST', /^\/api\/goals\/([^/]+)\/stop$/, m => scheduler.stop(m[1])],
    ['POST', /^\/api\/goals\/([^/]+)\/answer$/, (m, body) => scheduler.answer(m[1], body.text, attachmentsFor(m[1], body.attachments))],
    ['POST', /^\/api\/goals\/([^/]+)\/proposal\/accept$/, m => [201, scheduler.acceptProposal(m[1])]],
    ['POST', /^\/api\/goals\/([^/]+)\/proposal\/dismiss$/, m => scheduler.dismissProposal(m[1])],
    ['POST', /^\/api\/goals\/([^/]+)\/confirm$/, (m, body) => scheduler.confirmCriterion(m[1], String(body.criterion ?? ''), body.note)],
    ['POST', /^\/api\/goals\/([^/]+)\/run$/, async m => { if (guarded) await refreshUsage(); await scheduler.runGoal(m[1]); await autoSave.tick(); return engineView(); }],
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
    ['GET', /^\/api\/model-choices$/, () => modelChoices.get()],
    // ── 정기 요약 (엔진이 기록으로 작성, 모델 호출 없음) ──
    ['GET', /^\/api\/digests$/, () => ({ items: digests.list(), schedule: digests.schedule() })],
    ['POST', /^\/api\/digests$/, (m, body) => [201, digests.make(String(body.kind ?? 'daily'))]],
    ['POST', /^\/api\/digests\/clear$/, (m, body) => { if (body.confirm !== true) throw new Error('confirm clearing all summaries'); return digests.clear(); }],
    ['DELETE', /^\/api\/digests\/([0-9a-f-]{36})$/, m => digests.remove(m[1])],
    // ── 승인함: 감시 에이전트 승인 요청 · 결과 확인(신뢰 쌓기) · 기억 제안을 한곳에 ──
    ['GET', /^\/api\/inbox$/, () => {
      const goals = store.listGoals();
      const title = id => { const g = goals.find(x => x.projectId === id); return g ? (g.title || g.objective.slice(0, 40)) : id; };
      return {
        scopes: SCOPES, webMode: setting('sentinel.web', 'ask'),
        approvals: approvals.pending().map(r => ({ ...r, projectTitle: title(r.project) })),
        decided: approvals.list().filter(r => r.status !== 'pending').slice(0, 20).map(r => ({ ...r, projectTitle: title(r.project) })),
        grants: approvals.grants().map(g => ({ ...g, projectTitle: g.project ? title(g.project) : '모든 프로젝트' })),
        reviews: goals.filter(g => g.reason === 'trust_review' && g.trustReview).map(g => {
          const run = store.listRuns(g.id).filter(r => r.team === g.trustReview.team && r.status === 'finished').at(-1);
          return { goalId: g.id, projectId: g.projectId, projectTitle: title(g.projectId), ...g.trustReview,
            answer: run?.answer ?? null, tools: run?.tools ?? [], evidence: run?.evidence ?? [], checkpoint: run?.checkpoint
              ? { added: run.checkpoint.added ?? [], modified: run.checkpoint.modified ?? [], removed: run.checkpoint.removed ?? [] } : null };
        }),
        memoryProposals: memory.list().filter(i => i.status === 'pending'),
        trust: { required: trust.required(), teams: ['research', 'dev', 'design'].map(t => ({ team: t, name: TEAMS[t].name, count: trust.count(t) })) },
      };
    }],
    ['POST', /^\/api\/approvals\/([a-f0-9]{24})\/(grant|deny)$/, (m, body) => {
      const done = m[2] === 'grant' ? approvals.grant(m[1], String(body.scope), { anySite: body.anySite === true }) : approvals.deny(m[1], body.note);
      // When a project has no open requests left, its held step runs again (refusals go to planning).
      if (!approvals.pending(done.project).length) {
        for (const g of store.listGoals().filter(g => g.projectId === done.project && g.reason === 'approval_required')) {
          const refused = approvals.list().filter(r => r.goalId === g.id && r.status === 'denied' && !r.noted);
          for (const r of refused) store.setSetting(`approval.request.${r.id}`, { ...r, noted: true });
          scheduler.releaseApprovals(g.id, refused.map(r => r.target));
        }
      }
      void store.emit({ type: `approval.${done.status}`, projectId: done.project, target: done.target, scope: done.scope ?? null });
      return done;
    }],
    ['DELETE', /^\/api\/grants\/([0-9a-f-]{36})$/, m => approvals.revoke(m[1])],
    ['POST', /^\/api\/goals\/([^/]+)\/trust-review$/, (m, body) => scheduler.trustReview(m[1], { accept: body.accept === true, note: body.note, trustFully: body.trustFully === true })],
    ['GET', /^\/api\/memory$/, () => ({ items: memory.list() })],
    ['POST', /^\/api\/memory$/, (m, body) => [201, memory.add({ scope: body.scope ?? 'all', text: body.text })]],
    ['POST', /^\/api\/memory\/reset$/, (m, body) => { if (body.confirm !== true) throw new Error('confirm reset'); return memory.reset(); }],
    ['POST', /^\/api\/memory\/([0-9a-f-]{36})\/approve$/, m => memory.approve(m[1])],
    ['PUT', /^\/api\/memory\/([0-9a-f-]{36})$/, (m, body) => memory.edit(m[1], { scope: body.scope, text: body.text })],
    ['DELETE', /^\/api\/memory\/([0-9a-f-]{36})$/, m => memory.forget(m[1])],
    ['GET', /^\/api\/projects\/([^/]+)\/sentinel$/, async m => {
      const projectId = validateProjectId(m[1]);
      let lines = [];
      try { lines = (await readFile(sentinelLog, 'utf8')).split('\n').filter(Boolean).slice(-5000); } catch { /* nothing checked yet */ }
      const entries = lines.flatMap(l => { try { const e = JSON.parse(l); return e.project === projectId ? [e] : []; } catch { return []; } });
      return { projectId, total: entries.length, blocked: entries.filter(e => e.decision === 'deny').length, entries: entries.slice(-100).reverse() };
    }],
    ['PUT', /^\/api\/projects\/([^/]+)\/model-policy$/, async (m, body) => {
      const changes = {};
      const scope = `project:${validateProjectId(m[1])}`;
      if (body.teamModel !== undefined) {
        // One team's model · reasoning level, from the tool's official list ("" = the app's default).
        const { team, model = '', effort = '' } = body.teamModel ?? {};
        if (!Object.hasOwn(TEAMS, team)) throw new Error('unknown team');
        const pick = await modelChoices.validate(TEAMS[team].executor, String(model ?? ''), String(effort ?? ''));
        const { teamModels = {} } = registry.getPolicy(scope);
        changes.teamModels = { ...teamModels, [team]: pick };
      }
      if (body.mode !== undefined) changes.mode = body.mode;
      if (body.strategy !== undefined) changes.strategy = body.strategy;
      if (body.model !== undefined) changes.model = typeof body.model === 'string' ? body.model.trim() : body.model;
      if (body.allowFallback !== undefined) changes.allowFallback = body.allowFallback === true;
      if (body.allowProviderSwitch !== undefined) changes.allowProviderSwitch = body.allowProviderSwitch === true;
      return registry.setPolicy(scope, changes, { by: '대장', reason: String(body.reason || 'dashboard') });
    }],
  ];

  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host?.toLowerCase();
      const port = server.address()?.port;
      const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
      if (!allowedHosts.includes(host)) return sendJson(response, 403, { error: 'untrusted Host' });
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) return sendJson(response, 403, { error: 'untrusted Origin' });
      if (request.headers['sec-fetch-site'] === 'cross-site') return sendJson(response, 403, { error: 'cross-site request blocked' });
      // Browser writes require Origin; non-browser loopback diagnostics may omit it.
      if (!['GET','HEAD','OPTIONS'].includes(request.method) && request.headers['sec-fetch-site'] && !origin)
        return sendJson(response, 403, { error: 'browser write requires Origin' });
      const url = new URL(request.url, 'http://localhost');
      // 대장's attachment upload: the raw file (a screenshot can exceed the 1MB JSON limit), saved under attachments/.
      const uploadMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/attachments$/);
      if (request.method === 'POST' && uploadMatch) {
        const cwd = existingWorkspace(uploadMatch[1]);
        const maxMB = setting('attach.maxMB', DEFAULT_MAX_MB);
        const bytes = await readRaw(request, maxMB);
        return sendJson(response, 201, saveAttachment(cwd, url.searchParams.get('name'), bytes, clock.now(), { maxMB }));
      }
      const artifactMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/preview$/);
      if (request.method === 'GET' && artifactMatch) {
        const artifact = readArtifact(existingWorkspace(artifactMatch[1]), url.searchParams.get('path'));
        response.writeHead(200, { 'content-type': artifact.type, 'x-content-type-options': 'nosniff',
          'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
          'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'" });
        return response.end(artifact.bytes);
      }
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

  const timer = autoTick ? setInterval(async () => {
    try { if (guarded) await refreshUsage(); await scheduler.tick({ autoOnly: executing }); await autoSave.tick(); digests.tick(); }
    catch (error) { console.error('tick failed:', error.message); }
  }, tickMs) : null;
  timer?.unref();
  return {
    server, store, scheduler, registry, orchestrator, workspaces, autoSave, digests,
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

async function readRaw(request, maxMB) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxMB * 1024 * 1024) throw new Error(`attachment is larger than ${maxMB}MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function streamEvents(request, response, store) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  response.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  const unsubscribe = store.subscribe(event => response.write(`data: ${JSON.stringify(event)}\n\n`));
  request.on('close', unsubscribe);
}
