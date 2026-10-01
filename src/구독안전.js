// Missing, stale or paid/overage status never authorizes a new round — except the one gap Claude leaves:
// Claude only reports usage percentages to an interactive terminal's status line, so AGENT HQ cannot
// fetch them itself. Requiring a fresh reading would stop every Claude round until 대장 types in a
// terminal. For Claude, then:
//   - a fresh status-line reading is enforced exactly (5h ≤20% / weekly ≤10% left stops);
//   - an old reading can still stop (usage only grows inside a window, so an old "15% left" is ≤15% now);
//   - otherwise the limit state Claude Code reports on every team run decides: near limit, over limit
//     or paid overage stops new rounds.
// Codex percentages come from its official App Server on every check, so Codex always needs them fresh.
// Claude Code names its windows five_hour / seven_day; the usage page calls the second one weekly.
const WINDOW_OF = { five_hour: 'five_hour', seven_day: 'weekly', weekly: 'weekly' };
export function subscriptionCapacity(account, quota, checkedAt, now = Date.now()) {
  return capacityWhy(account, quota, checkedAt, now) === null;
}
// Why a new round may not start now (null: it may). Shown with "모델 대기" (2026-10-02: projects waited all
// morning and nothing outside the server could tell which input said no).
export function capacityWhy(account, quota, checkedAt, now = Date.now()) {
  const age = now - Date.parse(account?.checkedAt);
  if (account?.subscription !== true) return account?.loggedIn ? '구독 로그인이 아님 (auth status)' : '로그인 확인 실패 (auth status)';
  if (!Number.isFinite(age) || age < 0 || age >= 60000) return '로그인 확인이 1분 넘게 지남';
  if (!quota || now - checkedAt < 0 || now - checkedAt >= 60000) return '사용량 확인이 1분 넘게 지남';
  if ((quota.limitStatus ?? []).some(l => l.usingOverage === true || l.status === 'rejected')) return '한도 초과 또는 추가 과금 상태';
  const live = (quota.windows ?? []).filter(w => Date.parse(w.resetAt) > now);
  // Claude Code's "allowed_warning" comes well before 대장's stop line (seen 2026-10-01: a weekly warning at 25% left
  // while the line is 15%). It holds new rounds unless a percentage reading taken no earlier than the warning shows
  // that window still above the line; without such a reading it still stops.
  const heard = Date.parse(quota.observedAt);
  const warned = (quota.limitStatus ?? []).filter(l => l.status === 'allowed_warning');
  if (warned.some(l => {
    const w = live.find(x => x.period === (WINDOW_OF[l.window] ?? l.window));
    return !w || w.blocked !== false || !Number.isFinite(heard) || heard < Date.parse(l.observedAt) - 60_000;
  })) return '한도 경고 뒤 새 사용량 값이 없음';
  const low = live.find(w => w.blocked !== false);
  if (low) return `${low.period === 'weekly' ? '주간' : '5시간'} 남은 양 ${low.remaining}% · 기준 ${low.stopAt}% 이하`;
  const exact = !quota.stale && ['five_hour', 'weekly'].every(period => live.some(w => w.period === period));
  if (exact || quota.provider === 'claude') return null;
  return '사용량 값 없음';
}

// How the last decision was made, for the usage page.
export function capacityBasis(quota, now = Date.now()) {
  const live = (quota?.windows ?? []).filter(w => Date.parse(w.resetAt) > now);
  if (!quota?.stale && ['five_hour', 'weekly'].every(period => live.some(w => w.period === period))) return 'percent';
  return quota?.provider === 'claude' ? 'limit_status' : 'unavailable';
}
