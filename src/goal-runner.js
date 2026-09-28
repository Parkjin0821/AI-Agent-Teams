import { listWorkspaceFiles, parseReport, reportInstructions, verifyReport, workspaceFingerprint } from './evidence.js';
import { parsePlan, qaFindings, teamPrompt } from './teams.js';

// Bridges the goal scheduler to the CLI adapter. After a real run the engine reads the tool's final
// answer, runs the checks it proposed inside the workspace, and only passing checks become evidence.
// Team goals get the prompt and access of the team whose turn it is.
// In simulation mode nothing is executed, so a round reports no evidence and no model.
const PROVIDER = { 'claude-code': 'claude', codex: 'codex' };

export function createGoalRunner({ adapter, workspaces, store }) {
  return {
    async run(goal, run) {
      const cwd = workspaces.resolve(goal.projectId);
      const team = goal.kind === 'team' ? run.team : null;
      const prompt = team
        ? teamPrompt(team, { goal, team: goal.team, files: listWorkspaceFiles(cwd) })
        : [`Goal: ${goal.objective}`, '', reportInstructions(goal.completionCriteria)].join('\n');
      // Raw provider output is not forwarded: it may contain secrets and is not evidence.
      const onEvent = event => { if (event.type === 'provider.notice') void store.emit({ ...event, goalId: goal.id }); };
      const result = await adapter.run(PROVIDER[run.executor], prompt, onEvent, { cwd, model: run.model, access: run.access ?? 'write' });
      if (result.outcome === 'simulated') {
        // Simulation shows the rotation moving but never proves anything, so it stops on "no progress".
        return { outcome: 'completed', simulated: true, evidence: [], claims: [], diffHash: null,
          plan: team === 'plan' ? { nextTask: '모의 실행 · 실제 작업 없음', needsDecision: null, allDone: false } : undefined,
          findings: team === 'qa' ? { feedback: '모의 실행이라 확인한 것이 없습니다', improvements: [] } : undefined };
      }
      const base = { model: result.model ?? null, answer: result.answer ?? null };
      if (result.outcome === 'limited') return { ...base, outcome: 'error', errorKind: 'limit' };
      if (result.outcome !== 'completed') return { ...base, outcome: 'error', errorKind: result.errorKind ?? 'unclassified' };
      if (team === 'plan') return { ...base, outcome: 'completed', evidence: [], claims: [], diffHash: null, plan: parsePlan(result.answer) };
      const report = parseReport(result.answer);
      const { evidence, claims } = verifyReport(report, goal.completionCriteria, cwd);
      return { ...base, outcome: 'completed', evidence, claims, diffHash: workspaceFingerprint(cwd),
        ...(team === 'qa' ? { findings: qaFindings(report) } : {}) };
    },
  };
}
