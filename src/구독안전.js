// Missing, stale or paid/overage status never authorizes a new round — except the one gap Claude leaves:
// Claude only reports usage percentages to an interactive terminal's status line, so AGENT HQ cannot
// fetch them itself. Requiring a fresh reading would stop every Claude round until 대장 types in a
// terminal. For Claude, then:
//   - a fresh status-line reading is enforced exactly (5h ≤20% / weekly ≤10% left stops);
//   - an old reading can still stop (usage only grows inside a window, so an old "15% left" is ≤15% now);
//   - otherwise the limit state Claude Code reports on every team run decides: near limit, over limit
//     or paid overage stops new rounds.
// Codex percentages come from its official App Server on every check, so Codex always needs them fresh.
export function subscriptionCapacity(account, quota, checkedAt, now = Date.now()) {
  const age = now - Date.parse(account?.checkedAt);
  if (account?.subscription !== true || !Number.isFinite(age) || age < 0 || age >= 60000) return false;
  if (!quota || now - checkedAt < 0 || now - checkedAt >= 60000) return false;
  if ((quota.limitStatus ?? []).some(l => l.usingOverage === true || ['rejected', 'allowed_warning'].includes(l.status))) return false;
  const live = (quota.windows ?? []).filter(w => Date.parse(w.resetAt) > now);
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
