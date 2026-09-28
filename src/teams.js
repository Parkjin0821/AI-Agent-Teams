import { reportInstructions } from './evidence.js';

// The AI team that works a project in rotation:
//   plan → worker (dev | design) → [security] → [policy] → qa → plan …
// The planning team picks the worker and which reviews a task needs, so specialist teams only spend
// tokens when the work calls for them. Teams never share a session; only what the engine passes on
// (task, feedback, file list) moves between them. Answers are asked for in Korean for 대장.
export const TEAMS = Object.freeze({
  plan: { id: 'plan', name: '기획팀', executor: 'claude-code', access: 'read' },
  dev: { id: 'dev', name: '개발팀', executor: 'claude-code', access: 'write' },
  design: { id: 'design', name: '디자인팀', executor: 'claude-code', access: 'write' },
  // Reviews never change files. Security runs in Codex's read-only sandbox for a second model's view.
  security: { id: 'security', name: '보안팀', executor: 'codex', access: 'read' },
  policy: { id: 'policy', name: '정책팀', executor: 'claude-code', access: 'read' },
  // Codex's own sandbox lets the verification team run tests inside the project folder.
  qa: { id: 'qa', name: '검증팀', executor: 'codex', access: 'write' },
});
export const WORKERS = ['dev', 'design'];
export const REVIEWS = ['security', 'policy'];
export const PLAN_MARK = 'AGENT_HQ_PLAN';
export const REVIEW_MARK = 'AGENT_HQ_REVIEW';

// team = { step, worker, reviews: [pending review teams, in order] }
export function nextStep(team) {
  const pending = (team.reviews ?? []).filter(r => r !== team.step);
  switch (team.step) {
    case undefined: case null: case 'qa': return 'plan';
    case 'plan': return WORKERS.includes(team.worker) ? team.worker : 'dev';
    default: return pending[0] ?? 'qa';
  }
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
    team.feedback ? `Latest feedback: ${clip(team.feedback, 1500)}` : '',
  ].join('\n');
}

const reviewBlock = [
  `End your reply with the line ${REVIEW_MARK} followed by one JSON object:`,
  '{"verdict":"pass"|"issues","issues":["..."],"blocking":false,"needs_decision":null}',
  'blocking: true only if the work must be fixed before it can be verified.',
  'needs_decision: a question for 대장 if a human must decide (payment, credentials, publishing outside,',
  'installing software, licence terms, personal data); otherwise null.',
  'Do not change any files. Write your reply in Korean.',
].join('\n');

export function teamPrompt(step, input) {
  switch (step) {
    case 'plan': return [
      'You are 기획팀 (the planning team) of an AI team working on one project. You only read; you do not change files.',
      context(input),
      '',
      'Decide the single next task: small, concrete, doable in one session inside this folder.',
      'Choose who does it: "dev" (개발팀: code, data, docs) or "design" (디자인팀: screens, UI, layout, visual style).',
      'Choose reviews the task needs, in "reviews":',
      '  "security" (보안팀) if it touches user input, login, secrets, network calls, files outside data, or dependencies;',
      '  "policy" (정책팀) if it uses external data or APIs, third-party code or assets, personal data, or anything published.',
      'Leave "reviews" empty when neither applies. If every criterion already looks satisfied, set all_done to true.',
      'If progress needs a human decision (credentials, payment, publishing outside, installing software, unclear requirement),',
      'ask one question in needs_decision instead of a task.',
      `End your reply with the line ${PLAN_MARK} followed by one JSON object:`,
      '{"next_task":"...","team":"dev","reviews":[],"needs_decision":null,"all_done":false}',
      'Write your reply in Korean.',
    ].join('\n');
    case 'dev': return [
      'You are 개발팀 (the development team) of an AI team. Do only the current task below, inside the current folder.',
      context(input), '', reportInstructions(input.goal.completionCriteria), 'Write your reply in Korean.',
    ].join('\n');
    case 'design': return [
      'You are 디자인팀 (the design team) of an AI team. Do only the current task below, inside the current folder.',
      'Deliver the design as files here (HTML/CSS, SVG, or a short design spec in Markdown). Keep it clean, readable and accessible.',
      context(input), '', reportInstructions(input.goal.completionCriteria), 'Write your reply in Korean.',
    ].join('\n');
    case 'security': return [
      'You are 보안팀 (the security team) of an AI team. Review the current task\'s work in this folder for security problems:',
      'secrets or keys in files, unsafe handling of input, injection, unsafe file or network access, risky dependencies.',
      context(input), '', reviewBlock,
    ].join('\n');
    case 'policy': return [
      'You are 정책팀 (the policy team) of an AI team. Review the current task\'s work in this folder for policy problems:',
      'licences of third-party code or assets, terms of external APIs or data, personal data, anything that would be published.',
      context(input), '', reviewBlock,
    ].join('\n');
    case 'qa': return [
      'You are 검증팀 (the verification team) of an AI team. Check the work against the completion criteria.',
      'You may run tests or read files. Do not change the project files.',
      context(input), '', reportInstructions(input.goal.completionCriteria),
      'In the same JSON object also add "feedback": what is still missing or wrong (for the planning team),',
      'and "improvements": up to 5 short ideas to develop the project further once the criteria are met.',
      'Write your reply in Korean.',
    ].join('\n');
    default: throw new Error(`unknown team step: ${step}`);
  }
}

function jsonAfter(answer, mark) {
  if (typeof answer !== 'string') return null;
  const at = answer.lastIndexOf(mark);
  if (at < 0) return null;
  const rest = answer.slice(at + mark.length);
  const start = rest.indexOf('{'), end = rest.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(rest.slice(start, end + 1)); } catch { return null; }
}
const question = (v) => (typeof v === 'string' && v.trim() ? clip(v, 500).trim() : null);

export function parsePlan(answer) {
  const raw = jsonAfter(answer, PLAN_MARK);
  if (!raw) return null;
  const plan = {
    nextTask: clip(raw.next_task, 1000).trim(),
    team: WORKERS.includes(raw.team) ? raw.team : 'dev',
    reviews: REVIEWS.filter(r => Array.isArray(raw.reviews) && raw.reviews.includes(r)),
    needsDecision: question(raw.needs_decision),
    allDone: raw.all_done === true,
  };
  return plan.nextTask || plan.needsDecision || plan.allDone ? plan : null;
}

export function parseReview(answer) {
  const raw = jsonAfter(answer, REVIEW_MARK);
  if (!raw || !['pass', 'issues'].includes(raw.verdict)) return null;
  const issues = Array.isArray(raw.issues) ? raw.issues.filter(i => typeof i === 'string' && i.trim()).map(i => i.trim().slice(0, 300)).slice(0, 10) : [];
  return { verdict: raw.verdict, issues, blocking: raw.blocking === true && issues.length > 0, needsDecision: question(raw.needs_decision) };
}

export function qaFindings(report) {
  const improvements = Array.isArray(report?.improvements)
    ? report.improvements.filter(i => typeof i === 'string' && i.trim()).map(i => i.trim().slice(0, 200)).slice(0, 5) : [];
  return { feedback: clip(report?.feedback, 1500), improvements };
}
