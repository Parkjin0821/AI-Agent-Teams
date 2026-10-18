import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildHandoff } from './업무도메인.js';
import { routeStep } from './모델라우팅.js';
import { PersistentStore } from './영구저장소.js';
import { extractReturn, packFolder, sha256, unpackReturn } from './작업묶음.js';
import { applyPlan, digestOf, excludedOf, hashFolder, planReturn } from './코덱스격리실행.js';
import { jobCommands, linuxProfileArgs, wslCommand } from './코덱스격리.js';

// 협업 하네스 (docs/codex-격리-복원.md 15절, 대장 지시 2026-10-18): Claude Code와 Codex가 실제로 함께 일하는 시험을, 운영과
// 분리된 저장소(dataDir)와 시험 프로젝트에서 돌린다. 운영 스케줄러의 "같은 프로젝트 1개 실행" 제한은 그대로이며, 이 하네스는
// 운영 경로를 부르지도 바꾸지도 않는다. 기록은 운영과 같은 모양(goals·runs·events)으로 남겨 관측(관측.js)·작업 기록이 읽게 한다.

const now = () => new Date().toISOString();
const diff = (before, after) => ({
  added: Object.keys(after).filter(p => !(p in before)).sort(),
  modified: Object.keys(after).filter(p => p in before && before[p] !== after[p]).sort(),
  removed: Object.keys(before).filter(p => !(p in after)).sort(),
});

// ── 작업 일지: 중복 실행 방지와 중단 복구 ──────────────────────────────────────────────────────────────────────
// key 하나는 외부 작업 하나(시험·단계·시도). 'started'로 남은 것은 다시 시작하지 않고, 실패한 것은 retry 를 줄 때만 다시 한다.
export class Journal {
  constructor(file) { this.file = file; }
  read() { try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return {}; } }
  write(all) { const temp = `${this.file}.tmp-${randomBytes(3).toString('hex')}`; writeFileSync(temp, JSON.stringify(all, null, 2)); renameSync(temp, this.file); }
  begin(key, { retry = false, info = {} } = {}) {
    const all = this.read(), e = all[key];
    if (e?.status === 'started') throw new Error(`이미 시작된 작업 (중단됐을 수 있음, 먼저 복구): ${key}`);
    if (e?.status === 'finished') throw new Error(`이미 끝난 작업: ${key}`);
    if (e && !retry) throw new Error(`${e.status === 'held' ? '보류된' : e.status === 'interrupted' ? '중단된' : '실패한'} 작업 — 다시 하려면 retry: ${key}`);
    all[key] = { status: 'started', attempts: (e?.attempts ?? 0) + 1, startedAt: now(), ...info };
    this.write(all);
    return all[key];
  }
  update(key, extra) { const all = this.read(); all[key] = { ...all[key], ...extra }; this.write(all); }
  finish(key, status, extra = {}) { const all = this.read(); all[key] = { ...all[key], status, finishedAt: now(), ...extra }; this.write(all); }
  // After a crash: whatever was 'started' is now 'interrupted' (never silently re-run).
  recover() {
    const all = this.read(), found = [];
    for (const [key, e] of Object.entries(all)) if (e.status === 'started') { all[key] = { ...e, status: 'interrupted', recoveredAt: now() }; found.push({ key, ...all[key] }); }
    if (found.length) this.write(all);
    return found;
  }
}

// Claude Code stream-json ends with a result event that carries the token usage.
export function claudeUsage(stdout) {
  let usage = null;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try { const e = JSON.parse(line); if (e.type === 'result' && e.usage) usage = { input_tokens: e.usage.input_tokens, output_tokens: e.usage.output_tokens, cache_read_input_tokens: e.usage.cache_read_input_tokens, cache_creation_input_tokens: e.usage.cache_creation_input_tokens }; } catch { /* not JSON */ }
  }
  return usage;
}

export class CollaborationHarness {
  // claude: an adapter with run(provider, prompt, onEvent, opts) (CliAgentAdapter). codex: a CodexIsolatedRunner.
  // usage(): { 'claude-code': state, codex: state }. sentinel: { script } — Claude steps run under the Sentinel.
  constructor({ dataDir, claude, codex, sentinel = null, usage = () => ({ 'claude-code': 'available', codex: 'available' }), claudeModel = 'sonnet', claudeEffort = 'low', codexModel = null, codexEffort = 'low' }) {
    mkdirSync(dataDir, { recursive: true });
    Object.assign(this, { dataDir, claude, codex, sentinel, usage, claudeModel, claudeEffort, codexModel, codexEffort });
    this.store = new PersistentStore({ dataDir });
    this.journal = new Journal(path.join(dataDir, 'journal.json'));
    this.sentinelLog = path.join(dataDir, 'sentinel.jsonl');
    this.rounds = new Map();
  }
  close() { this.store.close(); }

  goal({ id = `hg-${randomBytes(4).toString('hex')}`, projectId, title, criteria = [] }) {
    return this.store.saveGoal({ id, projectId, title, status: 'running', harness: true, completionCriteria: criteria, createdAt: now() });
  }

  async route({ team, kind, workerExecutor = null, needs = [], approvals = {} }) {
    if (!this.codexPre || Date.now() - (this.codexPre.at ?? 0) > 45_000) this.codexPre = await this.codex.preflight();
    const pre = this.codexPre;
    return { pre, route: routeStep({ team, kind, needs, workerExecutor, approvals, usage: this.usage(), mode: 'harness',
      codex: { state: 'suspended', isolation: pre.ok ? 'ready' : 'blocked', trust: pre.trust } }) };
  }

  newRun(goal, { team, executor, access, route, key }) {
    const round = (this.rounds.get(goal.id) ?? 0) + 1;
    this.rounds.set(goal.id, round);
    const run = { id: `${goal.id}-r${round}`, goalId: goal.id, round, attempt: 1, status: 'running', startedAt: now(), executor, team, access,
      requestedModel: executor === 'codex' ? (this.codexModel ?? 'codex 기본값') : this.claudeModel, selectionReason: route.reasons.join(' · '), routing: route, harness: { key } };
    this.store.insertRun(run);
    this.store.emit({ type: 'goal.run_started', goalId: goal.id, round, attempt: 1, team, executor });
    return run;
  }
  finishRun(run, fields) {
    const done = { ...run, status: 'finished', finishedAt: now(), ...fields };
    this.store.saveRun(done);
    this.store.emit({ type: 'harness.step', goalId: run.goalId, round: run.round, team: run.team, executor: run.executor, outcome: done.outcome,
      model: done.actualModel ?? null, changed: done.checkpoint ? [...done.checkpoint.added, ...done.checkpoint.modified, ...done.checkpoint.removed] : [],
      conflicts: done.isolation?.plan?.conflicts?.length ?? 0, usage: done.usage ?? null });
    return done;
  }
  handoff(goal, { from, to, text }) {
    const record = { type: 'team.handoff', goalId: goal.id, projectId: goal.projectId, from: from.team, to: to.team, fromExecutor: from.executor, toExecutor: to.executor,
      textSha: sha256(text), text: text.slice(0, 4000) };
    this.store.emit(record);
    return record;
  }

  // A Claude Code step. It works in its own copy of the project (the same files a Codex job gets: no .git, secrets or
  // agent config), under the Sentinel. Only a completed step is applied, with the same rules as a Codex return: files the
  // project changed meanwhile are conflicts and are not overwritten. A held or failed step leaves the project untouched.
  async claudeStep(goal, { team, kind, prompt, projectDir, key, access = 'write', retry = false, apply = true }) {
    const { route } = await this.route({ team, kind });
    this.journal.begin(key, { retry, info: { executor: 'claude-code' } });
    if (route.state !== 'ready' || route.executor !== 'claude-code') {
      this.journal.finish(key, route.state === 'hold' ? 'held' : 'blocked', { reasons: route.reasons });
      return { outcome: route.state === 'hold' ? 'held' : 'blocked', route };
    }
    const run = this.newRun(goal, { team, executor: 'claude-code', access, route, key });
    const sent = packFolder(projectDir);
    const sentDigest = digestOf(sent.hashes);
    const copy = `${projectDir}.claude-${randomBytes(3).toString('hex')}`;
    extractReturn(unpackReturn(sent.tar), copy);
    const sentinelStart = now();
    let stdout = '';
    try {
      const result = await this.claude.run('claude', prompt, (e) => {
        if (e.type === 'provider.output') stdout += e.chunk;
        if (e.type === 'step.activity') this.store.broadcast({ type: 'step.activity', goalId: goal.id, team, text: e.text });
      }, { cwd: copy, model: this.claudeModel, effort: this.claudeEffort, access, ...(this.sentinel ? { sentinel: { script: this.sentinel.script, log: this.sentinelLog, project: goal.projectId, team } } : {}) });
      const denied = this.sentinelDecisions(sentinelStart).filter(d => d.decision === 'deny');
      const status = result.outcome === 'completed' ? 'finished' : result.outcome === 'limited' ? 'held' : 'failed';
      let merged = null;
      if (status === 'finished' && apply) {
        try { merged = applyCopy({ sent, copyDir: copy, projectDir }); }
        catch (error) { merged = { plan: null, applied: { applied: [], failed: [{ path: '(반환)', why: error.message }], aborted: true } }; }
        if (merged.plan?.conflicts?.length) this.store.emit({ type: 'harness.conflicts', goalId: goal.id, team, executor: 'claude-code', conflicts: merged.plan.conflicts });
      }
      const changes = merged?.applied?.applied ?? [];
      const checkpoint = { added: changes.filter(c => c.action === 'add').map(c => c.path), modified: changes.filter(c => c.action === 'modify').map(c => c.path),
        removed: changes.filter(c => c.action === 'delete').map(c => c.path), state: result.outcome };
      this.journal.finish(key, status, { outcome: result.outcome });
      const excluded = this.holdExcluded(run, merged?.excluded);
      const done = this.finishRun(run, { outcome: result.outcome, errorKind: result.errorKind ?? null, actualModel: result.model ?? null, answer: (result.answer ?? '').slice(0, 4000),
        checkpoint, usage: claudeUsage(stdout), guard: { by: this.sentinel ? 'sentinel' : 'none', denied: denied.length },
        isolation: { backend: 'claude-copy', sentDigest, baseMoved: merged?.baseMoved ?? null, excluded, plan: merged?.plan ? { changes: merged.plan.changes.map(c => ({ path: c.path, action: c.action })), conflicts: merged.plan.conflicts, rejected: merged.plan.rejected, unchanged: merged.plan.unchanged } : null, applied: merged?.applied ?? null } });
      return { outcome: status === 'held' ? 'held' : result.outcome, run: done, answer: result.answer ?? '', checkpoint, denied, route, plan: merged?.plan ?? null, applied: merged?.applied ?? null };
    } finally { rmSync(copy, { recursive: true, force: true }); }
  }

  // A Codex step through the isolated runner (WSL job). access 'read' for reviews (nothing comes back to apply).
  // approvals: harness-only trial switches of the routing policy (e.g. complexDev for the Codex development trial).
  async codexStep(goal, { team, kind, prompt, projectDir, key, access = 'write', workerExecutor = null, retry = false, execute = 'codex', apply = true, approvals = {} }) {
    const { route } = await this.route({ team, kind, workerExecutor, approvals });
    this.journal.begin(key, { retry, info: { executor: 'codex' } });
    if (route.state !== 'ready' || route.executor !== 'codex') {
      this.journal.finish(key, route.state === 'hold' ? 'held' : 'blocked', { reasons: route.reasons });
      this.store.emit({ type: 'codex.blocked', goalId: goal.id, team, reasons: route.reasons });
      return { outcome: route.state === 'hold' ? 'held' : 'blocked', route };
    }
    const jobId = `j-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
    this.journal.update(key, { jobId });
    const run = this.newRun(goal, { team, executor: 'codex', access, route, key });
    const r = await this.codex.runJob({ projectDir, prompt, jobId, access, model: this.codexModel, effort: this.codexEffort, execute, apply, preflight: this.codexPre });
    const changes = r.applied?.applied ?? [];
    const checkpoint = { added: changes.filter(c => c.action === 'add').map(c => c.path), modified: changes.filter(c => c.action === 'modify').map(c => c.path),
      removed: changes.filter(c => c.action === 'delete').map(c => c.path), state: r.outcome };
    const status = r.outcome === 'completed' && (r.exec?.code ?? 0) === 0 ? 'finished' : r.outcome === 'blocked' ? 'blocked' : 'failed';
    this.journal.finish(key, status, { outcome: r.outcome, jobId });
    if (r.outcome === 'return_rejected') this.store.emit({ type: 'codex.return_rejected', goalId: goal.id, team, problems: r.problems, names: r.names });
    if (r.plan?.conflicts?.length) this.store.emit({ type: 'codex.conflicts', goalId: goal.id, team, conflicts: r.plan.conflicts });
    if (r.applied?.aborted) this.store.emit({ type: 'codex.apply_aborted', goalId: goal.id, team, failed: r.applied.failed, rolledBack: r.applied.rolledBack });
    const excluded = this.holdExcluded(run, r.excluded);
    const done = this.finishRun(run, { outcome: r.outcome, actualModel: r.exec?.model ?? (r.exec?.code === 0 && this.codexModel ? this.codexModel : null), modelSource: r.exec?.model ? 'reported' : this.codexModel ? 'pinned' : null, answer: (r.exec?.answer ?? '').slice(0, 4000), checkpoint,
      usage: r.exec?.usage?.[0] ?? null, isolation: { backend: 'codex-wsl-isolated', jobId, trust: r.trust, sentDigest: r.sentDigest, baseMoved: r.baseMoved ?? null, excluded, plan: r.plan, applied: r.applied, problems: r.problems ?? [], timings: r.timings } });
    return { outcome: r.outcome, run: done, answer: r.exec?.answer ?? '', checkpoint, result: r, route };
  }

  // The engine's own check, not a team's: the project plus the engine's acceptance test, run with node --test inside
  // the WSL job through Codex's sandbox alone (no model, no network). Nothing comes back to the project.
  async verify(goal, { projectDir, acceptance, key }) {
    this.journal.begin(key, { info: { executor: 'engine' } });
    const copy = `${projectDir}.verify-${randomBytes(3).toString('hex')}`;
    cpSync(projectDir, copy, { recursive: true });
    writeFileSync(path.join(copy, acceptance.name), acceptance.source);
    try {
      const r = await this.codex.runJob({ projectDir: copy, apply: false, execute: async ({ dir, run, distro, user }) =>
        run(wslCommand({ distro, user, cwd: dir, argv: ['codex', 'sandbox', ...linuxProfileArgs('read'), '-P', 'hq', '-C', dir, '--', 'node', '--test', '--test-reporter=tap'] }), { timeoutMs: 180_000 }) });
      return this.recordVerification(goal, key, r, projectDir);
    } finally { rmSync(copy, { recursive: true, force: true }); }
  }
  recordVerification(goal, key, r, projectDir) {
    const log = r.exec?.raw ?? '';
    // Node 20 (in the distro) runs each test file in its own process and reports per file: a file is "not ok" as soon as one
    // of its tests fails. So these are counts of test files.
    const pass = (log.match(/^\s*ok \d+/gm) ?? []).length, fail = (log.match(/^\s*not ok \d+/gm) ?? []).length;
    const ok = r.outcome === 'completed' && r.exec?.code === 0 && fail === 0 && pass > 0;
    const files = Object.fromEntries(Object.entries(hashFolder(projectDir)).filter(([p]) => /^(src|test)\//.test(p)));
    const evidence = ok ? { criterion: '엔진 인수 시험 통과', proof: `node --test (WSL 격리, 모델 없음): 시험 파일 ${pass}개 통과 · 실패 ${fail}개`, by: 'engine', at: now(),
      files, test: { label: 'engine acceptance', runner: 'node (hq-codex, codex sandbox read-only)', logSha: sha256(log) } } : null;
    this.journal.finish(key, ok ? 'finished' : 'failed', { pass, fail });
    this.store.emit({ type: ok ? 'harness.verified' : 'harness.verify_failed', goalId: goal.id, pass, fail });
    return { ok, pass, fail, evidence, log };
  }

  // Changes a step made that were not applied (conflicts) are kept under dataDir/held/<run>/ and listed on the run.
  holdExcluded(run, excluded = []) {
    if (!excluded.length) return [];
    const dir = path.join(this.dataDir, 'held', run.id);
    const list = excluded.map(e => {
      const target = path.join(dir, ...e.path.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, e.data);
      return { path: e.path, why: e.why, hash: e.hash, held: path.relative(this.dataDir, target) };
    });
    this.store.emit({ type: 'harness.excluded', goalId: run.goalId, round: run.round, team: run.team, executor: run.executor, files: list.map(({ path: p, why, hash }) => ({ path: p, why, hash })) });
    return list;
  }

  sentinelDecisions(since) {
    if (!existsSync(this.sentinelLog)) return [];
    return readFileSync(this.sentinelLog, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.at >= since);
  }

  // After a crash: interrupted keys are reported and their Codex job folders removed. Nothing is re-run on its own.
  async recover() {
    const found = this.journal.recover();
    for (const e of found) {
      if (!e.jobId) continue;
      // A killed engine can leave the job's processes running in the distro: stop them, then remove the job folder.
      await this.codex.run(wslCommand({ distro: this.codex.distro, user: 'root', argv: ['pkill', '-f', `/srv/hq/jobs/${e.jobId}`] }));
      await this.codex.run(jobCommands({ distro: this.codex.distro, user: this.codex.user, jobId: e.jobId }).remove);
    }
    if (found.length) this.store.emit({ type: 'goal.recovery_required', harness: true, keys: found.map(f => f.key) });
    return found;
  }
}

// What a Claude step did in its own copy, judged and applied like a Codex return (same rules, same conflict handling).
export function applyCopy({ sent, copyDir, projectDir, allow = null }) {
  const returned = unpackReturn(packFolder(copyDir).tar);
  const current = hashFolder(projectDir);
  const plan = planReturn({ sent, returned, current, allow });
  return { plan, applied: applyPlan(projectDir, plan), baseMoved: digestOf(current) !== digestOf(sent.hashes), excluded: excludedOf(plan) };
}

export function handoffText({ title, objective, criteria, from, done, changed, verification, next, to, reason }) {
  return buildHandoff({ title, completionCriteria: criteria, provider: from, checkpoint: { objective, completed: done, changedFiles: changed, verification, nextAction: next } }, reason, to);
}

// 인계 정확도와 재작업 비율 (대장 지시 2026-10-18), from the harness's own records:
//   hand-off accuracy — the files a hand-off says were changed vs what the step before it actually changed (both ways)
//   rework ratio — of the files steps produced, how many a later step of the same goal changed again
export function collaborationMetrics(store, goalId) {
  const runs = store.listRuns(goalId).sort((a, b) => a.round - b.round);
  const changed = r => new Set([...(r.checkpoint?.added ?? []), ...(r.checkpoint?.modified ?? []), ...(r.checkpoint?.removed ?? [])]);
  const handoffs = store.recentEvents(1000).filter(e => e.type === 'team.handoff' && e.goalId === goalId).reverse().map(e => {
    const listed = new Set((/^Changed files: (.*)$/m.exec(e.text ?? '')?.[1] ?? '').split(',').map(s => s.trim()).filter(f => f && f !== 'none'));
    const from = [...runs].reverse().find(r => r.executor === e.fromExecutor && r.team === e.from && Date.parse(r.finishedAt ?? 0) <= Date.parse(e.at));
    const actual = from ? changed(from) : new Set();
    const union = new Set([...listed, ...actual]), both = [...listed].filter(f => actual.has(f));
    return { from: `${e.from}/${e.fromExecutor}`, to: `${e.to}/${e.toExecutor}`, listed: [...listed], actual: [...actual],
      missing: [...actual].filter(f => !listed.has(f)), extra: [...listed].filter(f => !actual.has(f)), accuracy: union.size ? both.length / union.size : 1 };
  });
  const produced = new Map();
  let reworked = 0;
  for (const r of runs) for (const f of changed(r)) {
    if (produced.has(f) && produced.get(f) !== r.id) reworked++;
    if (!produced.has(f)) produced.set(f, r.id);
  }
  return { handoffs, rework: { produced: produced.size, reworked, ratio: produced.size ? reworked / produced.size : 0 } };
}
