import { createHash } from 'node:crypto';

// Metadata-only external drafts exclude prompts, answers, paths and tool output.
export function projectRecord(store, projectId) {
  const goals = store.listGoals().filter(g => g.projectId === projectId);
  if (!goals.length) throw new Error('project not found');
  const checkpoints = goals.flatMap(g => store.listRuns(g.id).map(r => ({
    goalId: g.id, runId: r.id, team: r.team, executor: r.executor, status: r.status,
    simulated: r.simulated === true, outcome: r.outcome, startedAt: r.startedAt, finishedAt: r.finishedAt,
    verifiedCriteria: r.evidence?.length ?? 0,
  })));
  const snapshot = { projectId, goals: goals.map(g => ({ id: g.id, status: g.status,
    criteriaCount: g.completionCriteria.length, evidencedCount: g.evidence?.length ?? 0 })), checkpoints };
  const digest = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  const markdown = [`# AGENT HQ · ${projectId}`, '', `Record: ${digest}`, '',
    'Metadata-only draft. Review before external publication.', '',
    ...snapshot.goals.map(g => `- Goal ${g.id}: ${g.status}; evidence ${g.evidencedCount}/${g.criteriaCount}`), '',
    ...checkpoints.map(r => `- ${r.runId} · ${r.team ?? 'task'} · ${r.status} · ${r.simulated ? 'SIMULATED / not verified' : r.outcome ?? 'pending'}`)].join('\n');
  return { digest, snapshot, markdown, state: 'draft', externalSync: 'not_connected',
    github: { path: `agent-hq-records/${projectId}/${digest}.md`, content: Buffer.from(markdown).toString('base64') },
    notion: { blocks: markdown.split('\n').filter(Boolean).map(text => ({ object: 'block', type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: text.slice(0, 1900) } }] } })) },
    requires: ['destination_allowlist', 'credentials', 'security_policy_review', 'publication_approval'] };
}
