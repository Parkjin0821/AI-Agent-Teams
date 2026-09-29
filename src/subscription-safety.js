// Missing, stale or paid/overage status never authorizes a new round.
export function subscriptionCapacity(account, quota, checkedAt, now = Date.now()) {
  const age = now - Date.parse(account?.checkedAt);
  if (account?.subscription !== true || !Number.isFinite(age) || age < 0 || age >= 60000) return false;
  if (!quota || quota.stale || now - checkedAt < 0 || now - checkedAt >= 60000) return false;
  if ((quota.limitStatus ?? []).some(l => l.usingOverage === true || ['rejected', 'allowed_warning'].includes(l.status))) return false;
  return ['five_hour', 'weekly'].every(period => quota.windows?.some(w => w.period === period
    && w.blocked === false && Date.parse(w.resetAt) > now));
}
