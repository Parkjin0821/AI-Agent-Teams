import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { childEnv, resolveBins } from './adapters.js';

// The models and reasoning levels 대장 can pick per team, named exactly, from each tool's official source:
// - Claude Code: full model IDs and effort levels from https://code.claude.com/docs/en/model-config
//   (checked 2026-09-29). Full IDs, not aliases: an alias follows whatever the installed CLI version maps
//   it to (Claude Code 2.1.265 still ran Opus 5 as its default).
// - Codex: the official app-server's model/list for this account (read-only, no model turn).
// A team with no pick runs the listed default model; nothing is left to an unnamed "app default".
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const CLAUDE_CHOICES = Object.freeze({
  models: [
    { id: 'claude-fable-5-1', label: 'Fable 5.1', efforts: CLAUDE_EFFORTS, defaultEffort: 'high', isDefault: false },
    { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: CLAUDE_EFFORTS, defaultEffort: 'medium', isDefault: true },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: CLAUDE_EFFORTS, defaultEffort: 'medium', isDefault: false },
  ],
  source: 'Claude Code 공식 문서 (model-config)',
});
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

// Codex models 대장 does not use are not offered, even if the account lists them.
export const HIDDEN_CODEX_MODELS = [/^gpt-5\.6(-|$)/];

export function readCodexModels({ bins = resolveBins(), timeoutMs = 15000, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(bins.codex.file, [...bins.codex.prefix, 'app-server', '--stdio'], { env: childEnv(), shell: false, windowsHide: true });
    let done = false;
    const lines = createInterface({ input: child.stdout });
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); lines.close(); child.kill(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(new Error('Codex model list timed out')), timeoutMs);
    const send = value => child.stdin.write(`${JSON.stringify(value)}\n`);
    child.stderr?.resume();
    child.stdin.on('error', () => finish(new Error('Codex model list connection closed')));
    child.on('error', () => finish(new Error('Codex CLI unavailable')));
    child.on('close', () => finish(new Error('Codex model list exited')));
    lines.on('line', (line) => {
      let msg; try { msg = JSON.parse(line); } catch { return; }
      if (msg.id === 0) { send({ method: 'initialized' }); send({ id: 1, method: 'model/list', params: {} }); }
      if (msg.id === 1) {
        if (msg.error) return finish(new Error('Codex official model list failed; check login'));
        const list = msg.result?.data ?? msg.result;
        finish(null, normalizeCodexModels(Array.isArray(list) ? list : []));
      }
    });
    send({ id: 0, method: 'initialize', params: { clientInfo: { name: 'agent_hq_models', version: '0.1.0' } } });
  });
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export function normalizeCodexModels(list) {
  return list.flatMap((m) => {
    const id = typeof m?.id === 'string' ? m.id : typeof m?.model === 'string' ? m.model : null;
    if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/.test(id)) return [];
    const efforts = (m.supportedReasoningEfforts ?? []).map(e => e?.reasoningEffort ?? e).filter(e => EFFORTS.includes(e));
    return [{ id, label: typeof m.displayName === 'string' ? m.displayName.slice(0, 60) : id, isDefault: m.isDefault === true,
      efforts, defaultEffort: EFFORTS.includes(m.defaultReasoningEffort) ? m.defaultReasoningEffort : null }];
  });
}

// Cached for ten minutes; a failed lookup is reported, never replaced with a guessed list.
export class ModelChoices {
  constructor({ readCodex = readCodexModels, clock = { now: () => Date.now() } } = {}) {
    Object.assign(this, { readCodex, clock, codex: null, checkedAt: 0, error: null, pending: null });
  }

  async get({ refresh = false } = {}) {
    if (refresh || !this.codex || this.clock.now() - this.checkedAt > 10 * 60_000) {
      this.pending ??= this.readCodex().then((list) => { this.codex = list; this.error = null; },
        (error) => { this.error = error.message; }).finally(() => { this.checkedAt = this.clock.now(); this.pending = null; });
      await this.pending;
    }
    const codex = (this.codex ?? []).filter(m => !HIDDEN_CODEX_MODELS.some(re => re.test(m.id)));
    return {
      'claude-code': { models: CLAUDE_CHOICES.models, defaultModel: DEFAULT_CLAUDE_MODEL, source: CLAUDE_CHOICES.source },
      codex: { models: codex, defaultModel: codex.find(m => m.isDefault)?.id ?? null, source: 'Codex app-server model/list (이 계정)', error: this.error },
      checkedAt: this.checkedAt ? new Date(this.checkedAt).toISOString() : null,
    };
  }

  // Throws unless model/effort is "" (the listed default) or one the official source lists for that tool/model.
  async validate(executor, model, effort) {
    const choices = (await this.get())[executor];
    if (!choices) throw new Error(`unknown executor: ${executor}`);
    if (model && !choices.models.some(m => m.id === model)) throw new Error(`model not offered by ${executor}: ${model}`);
    const target = choices.models.find(m => m.id === (model || choices.defaultModel));
    if (effort && !(target?.efforts ?? []).includes(effort)) throw new Error(`reasoning level not offered for this model: ${effort}`);
    return { executor, model: model || null, effort: effort || null };
  }
}
