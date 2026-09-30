// Claude Code PreToolUse hook: AGENT HQ 감시 에이전트. Fails closed — any internal error blocks the call
// (a hook that crashes with another exit code would let the call through).
let input = '';
try {
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 5_000_000) throw new Error('input too large'); }
  const { decide, logDecision } = await import('../src/sentinel.js');
  const { readGrants } = await import('../src/approvals.js');
  const { readRules } = await import('../src/rules.js');
  const call = JSON.parse(input);
  const project = process.env.AGENT_HQ_PROJECT || null;
  const verdict = decide(call, { workspace: process.env.AGENT_HQ_WORKSPACE, project,
    grants: process.env.AGENT_HQ_SENTINEL_GRANTS ? readGrants(process.env.AGENT_HQ_SENTINEL_GRANTS) : [],
    rules: process.env.AGENT_HQ_SENTINEL_RULES ? readRules(process.env.AGENT_HQ_SENTINEL_RULES) : [],
    webMode: process.env.AGENT_HQ_SENTINEL_WEB === 'open' ? 'open' : 'ask' });
  if (verdict.decision !== 'ignore') {
    try {
      logDecision(process.env.AGENT_HQ_SENTINEL_LOG, { at: new Date().toISOString(), project, team: process.env.AGENT_HQ_TEAM ?? null,
        tool: call.tool_name, target: verdict.target, decision: verdict.decision, reason: verdict.reason, ...(verdict.ask ? { ask: verdict.ask } : {}) });
    } catch { if (verdict.decision !== 'deny') throw new Error('sentinel log unavailable'); }
  }
  if (verdict.decision === 'ask') {
    process.stderr.write(`AGENT HQ 감시 에이전트: ${verdict.reason} (${verdict.target}). 대장에게 승인 요청을 올렸습니다. `
      + '이번 단계에서는 이 동작 없이 진행하고, 무엇이 왜 필요한지 보고서에 적으세요.');
    process.exit(2);
  }
  if (verdict.decision === 'deny') {
    process.stderr.write(`AGENT HQ 감시 에이전트가 막았습니다: ${verdict.reason}. 다른 방법을 쓰거나 보고서에 필요한 것을 적으세요.`);
    process.exit(2);
  }
  process.exit(0);
} catch (error) {
  process.stderr.write(`AGENT HQ 감시 에이전트 오류로 이 동작을 막았습니다 (${error.message}).`);
  process.exit(2);
}
