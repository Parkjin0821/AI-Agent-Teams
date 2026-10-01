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
  const age = now - Date.parse(account?.checkedAt);
  if (account?.subscription !== true || !Number.isFinite(age) || age < 0 || age >= 60000) return false;
  if (!quota || now - checkedAt < 0 || now - checkedAt >= 60000) return false;
  if ((quota.limitStatus ?? []).some(l => l.usingOverage === true || l.status === 'rejected')) return false;
  const live = (quota.windows ?? []).filter(w => Date.parse(w.resetAt) > now);
  // Claude Code's "allowed_warning" comes well before 대장's stop line (seen 2026-10-01: a weekly warning at 25% left
  // while the line is 15%). It holds new rounds unless a percentage reading taken no earlier than the warning shows
  // that window still above the line; without such a reading it still stops.
  const heard = Date.parse(quota.observedAt);
  const warned = (quota.limitStatus ?? []).filter(l => l.status === 'allowed_warning');
  if (warned.some(l => {
    const w = live.find(x => x.period === (WINDOW_OF[l.window] ?? l.window));
    return !w || w.blocked !== false || !Number.isFinite(heard) || heard < Date.parse(l.observedAt) - 60_000;
  })) return false;
  if (live.some(w => w.blocked !== false)) return false;
  const exact = !quota.stale && ['five_hour', 'weekly'].every(period => live.some(w => w.period === period));
  if (exact) return true;
  return quota.provider === 'claude';
}

// How the last decision was made, for the usage page.
export function capacityBasis(quota, now = Date.now()) {
  const live = (quota?.windows ?? []).filter(w => Date.parse(w.resetAt) > now);
  if (!quota?.stale && ['five_hour', 'weekly'].every(period => live.some(w => w.period === period))) return 'percent';
  return quota?.provider === 'claude' ? 'limit_status' : 'unavailable';
}
