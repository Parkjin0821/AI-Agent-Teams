// 모델 라우팅 정책 (docs/codex-격리-복원.md 14절, 대장 지시 2026-10-18): 어떤 일을 어느 실행 도구가 맡을지 정한다.
// 팀(기획·조사·개발·디자인·보안·정책·검증)은 역할이고, Claude Code와 Codex는 그 역할을 수행하는 도구다(헌장 원칙 2).
// 판단 재료: 작업 종류, 격리 가능 여부, 필요한 권한(웹·커넥터·쓰기), 구독 사용량, 모델 적합성, 교차 검토(작업한 도구와 다른 도구).
// 이 모듈은 결정만 돌려준다. 작업 스케줄러·팀 배정에는 연결되어 있지 않다 — 실전 연결은 대장 승인 뒤(codexTeamExecution.state).

// 작업 종류별 선호 순서 (초기 정책). 고정이 아니라 정책 값이라 바꿀 수 있다.
export const ROUTING_POLICY = Object.freeze({
  version: 1,
  prefer: {
    plan: ['claude-code'],
    research: ['claude-code'],
    design: ['claude-code'],
    dev: ['claude-code'],
    'dev-complex': ['claude-code'],            // Codex는 후속 격리 시험 통과 뒤(approvals.complexDev)에만 앞에 선다
    'code-review': ['codex', 'claude-code'],    // 독립 코드 검토: 작업한 도구와 다른 도구
    verify: ['codex', 'claude-code'],           // 제한된 검증
    'security-review': ['claude-code', 'codex'],
    'policy-review': ['claude-code'],
  },
  // 팀의 기본 작업 종류 (팀 = 역할, 도구 아님)
  teamKind: { plan: 'plan', research: 'research', design: 'design', dev: 'dev', security: 'security-review', policy: 'policy-review', qa: 'verify' },
  // 각 도구가 할 수 있는 것 (실행어댑터·작업배정의 EXECUTOR_CAPABILITIES 와 같은 뜻)
  capabilities: { 'claude-code': ['text', 'code', 'web', 'connectors', 'write'], codex: ['text', 'code', 'write'] },
  // 독립성이 필요한 종류: 작업자와 다른 도구를 우선한다
  crossCheck: ['code-review', 'verify', 'security-review'],
});

// input:
//   team, kind?            — 팀과 작업 종류 (종류가 없으면 팀 기본값)
//   needs: ['web'|'connectors'|'write'|…]
//   workerExecutor         — 검토 대상 작업을 한 도구 (교차 검토)
//   usage: { 'claude-code': 'available'|'limited'|'unknown', codex: … }
//   codex: { state: 'suspended'|'active', isolation: 'ready'|'blocked'|'unknown', trust: 'signed'|'unsigned' }
//   mode: 'production' | 'harness'   — 격리 하네스에서만 suspended 상태의 Codex를 쓸 수 있다
//   approvals: { complexDev?: boolean }
// → { state: 'ready'|'hold'|'blocked', executor, backend, kind, reasons: [한 줄씩], considered: [{ executor, ok, why }] }
export function routeStep({ team, kind = null, needs = [], workerExecutor = null, usage = {}, codex = {}, mode = 'production', approvals = {}, policy = ROUTING_POLICY } = {}) {
  const k = kind ?? policy.teamKind[team];
  if (!k || !policy.prefer[k]) return { state: 'blocked', executor: null, backend: null, kind: k ?? null, reasons: [`알 수 없는 작업 종류: ${k ?? team}`], considered: [] };
  let order = [...policy.prefer[k]];
  if (k === 'dev-complex' && approvals.complexDev) order = ['codex', 'claude-code'];
  if (policy.crossCheck.includes(k) && workerExecutor) order.sort((a, b) => (a === workerExecutor) - (b === workerExecutor));
  const considered = [];
  let held = false;
  for (const executor of order) {
    const missing = needs.filter(n => !policy.capabilities[executor]?.includes(n));
    if (missing.length) { considered.push({ executor, ok: false, why: `필요한 권한·기능 없음: ${missing.join(', ')}` }); continue; }
    if (executor === 'codex') {
      if (codex.isolation !== 'ready') { considered.push({ executor, ok: false, why: `격리 실행 준비 안 됨 (${codex.isolation ?? 'unknown'}) — 실행 차단` }); continue; }
      if (mode !== 'harness' && codex.state !== 'active') { considered.push({ executor, ok: false, why: 'Codex 팀 실행 일시 중지 — 실전 배정 금지 (격리 하네스만)' }); continue; }
      if (mode !== 'harness' && codex.trust !== 'signed') { considered.push({ executor, ok: false, why: '대장 서명 승인이 확인되지 않음 — 실전 배정 금지' }); continue; }
    }
    const u = usage[executor] ?? 'unknown';
    if (u !== 'available') { held = true; considered.push({ executor, ok: false, why: `구독 사용량 ${u === 'limited' ? '부족' : '확인 안 됨'} — 보류` }); continue; }
    const reasons = [`${k} → ${executor}`];
    if (executor !== order[0]) reasons.push(`우선 도구(${order[0]}) 사용 불가로 다음 순위`);
    if (policy.crossCheck.includes(k) && workerExecutor && executor !== workerExecutor) reasons.push(`교차 검토: 작업한 도구(${workerExecutor})와 다른 도구`);
    if (policy.crossCheck.includes(k) && workerExecutor && executor === workerExecutor) reasons.push('교차 검토 불가 — 같은 도구가 검토 (기록)');
    considered.push({ executor, ok: true, why: '선택' });
    return { state: 'ready', executor, backend: executor === 'codex' ? 'codex-wsl-isolated' : 'claude-cli', kind: k, reasons, considered };
  }
  // Nothing usable: a usage limit holds the step safely; anything else blocks it.
  return { state: held ? 'hold' : 'blocked', executor: null, backend: null, kind: k, reasons: considered.map(c => `${c.executor}: ${c.why}`), considered };
}
