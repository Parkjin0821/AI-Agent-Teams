import { reportInstructions } from './evidence.js';

// The AI team that works a project in rotation: plan → dev → qa → plan ...
// Each team is a role on top of an execution tool; teams never share a session, only what the engine
// passes on (the current task, QA feedback, the file list). Answers are asked for in Korean for 대장.
export const TEAMS = Object.freeze({
  plan: { id: 'plan', name: '기획팀', executor: 'claude-code', access: 'read' },
  dev: { id: 'dev', name: '개발팀', executor: 'claude-code', access: 'write' },
  // Codex's own sandbox lets the verification team run tests inside the project folder.
  qa: { id: 'qa', name: '검증팀', executor: 'codex', access: 'write' },
});
const ORDER = ['plan', 'dev', 'qa'];
export const PLAN_MARK = 'AGENT_HQ_PLAN';

export function nextTeam(step) {
  return step ? ORDER[(ORDER.indexOf(step) + 1) % ORDER.length] : 'plan';
}

const clip = (text, n) => (typeof text === 'string' ? text.slice(0, n) : '');

function context({ goal, team = {}, files = [] }) {
  return [
    `Project goal: ${goal.objective}`,
    '',
    'Completion criteria:',
    ...goal.completionCriteria.map((c, i) => `${i + 1}. ${c}`),
    '',
    `Files in the project folder (${files.length}): ${files.length ? files.slice(0, 50).join(', ') : '(empty)'}`,
    team.task ? `Current task: ${clip(team.task, 1000)}` : '',
    team.feedback ? `Latest feedback from the verification team: ${clip(team.feedback, 1500)}` : '',
  ].filter(line => line !== null).join('\n');
}

export function teamPrompt(step, input) {
  if (step === 'plan') {
    return [
      'You are 기획팀 (the planning team) of an AI team working on one project. You only read; you do not change files.',
      context(input),
      '',
      'Decide the single next task for 개발팀 (the development team): small, concrete, doable in one session inside this folder.',
      'If every criterion already looks satisfied, set all_done to true.',
      'If progress needs a human decision (credentials, payment, publishing outside, installing software, unclear requirement), ask one question in needs_decision instead of a task.',
      `End your reply with the line ${PLAN_MARK} followed by one JSON object:`,
      '{"next_task":"...","needs_decision":null,"all_done":false}',
      'Write your reply in Korean.',
    ].join('\n');
  }
  if (step === 'dev') {
    return [
      'You are 개발팀 (the development team) of an AI team. Do only the current task below, inside the current folder.',
      context(input),
      '',
      reportInstructions(input.goal.completionCriteria),
      'Write your reply in Korean.',
    ].join('\n');
  }
  if (step === 'qa') {
    return [
      'You are 검증팀 (the verification team) of an AI team. Check the work against the completion criteria.',
      'You may run tests or read files. Do not change the project files.',
      context(input),
      '',
      reportInstructions(input.goal.completionCriteria),
      'In the same JSON object also add "feedback": what is still missing or wrong (for the planning team),',
      'and "improvements": up to 5 short ideas to develop the project further once the criteria are met.',
      'Write your reply in Korean.',
    ].join('\n');
  }
  throw new Error(`unknown team step: ${step}`);
}

export function parsePlan(answer) {
  if (typeof answer !== 'string') return null;
  const at = answer.lastIndexOf(PLAN_MARK);
  if (at < 0) return null;
  const rest = answer.slice(at + PLAN_MARK.length);
  const start = rest.indexOf('{'), end = rest.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw;
  try { raw = JSON.parse(rest.slice(start, end + 1)); } catch { return null; }
  const plan = {
    nextTask: clip(raw?.next_task, 1000).trim(),
    needsDecision: typeof raw?.needs_decision === 'string' && raw.needs_decision.trim() ? clip(raw.needs_decision, 500).trim() : null,
    allDone: raw?.all_done === true,
  };
  return plan.nextTask || plan.needsDecision || plan.allDone ? plan : null;
}

export function qaFindings(report) {
  const improvements = Array.isArray(report?.improvements)
    ? report.improvements.filter(i => typeof i === 'string' && i.trim()).map(i => i.trim().slice(0, 200)).slice(0, 5) : [];
  return { feedback: clip(report?.feedback, 1500), improvements };
}
