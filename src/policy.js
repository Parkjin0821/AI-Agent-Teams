export const DEFAULT_POLICY = Object.freeze({
  maxConcurrent: 2, providerConcurrent: { claude: 2, codex: 1 },
  researchIntervalMs: 6 * 60 * 60 * 1000,
  improvementIntervalMs: 24 * 60 * 60 * 1000,
  retryDelaysMs: [60_000, 300_000, 900_000],
  maxNoProgress: 3,
  maxTestFixAttempts: 2,
  maxRoundsPerDay: 10,
});

export function assessUsage(snapshot, now = Date.now()) {
  const windows = snapshot?.windows;
  if (!Array.isArray(windows) || !windows.length) return { state: 'unknown', reasons: ['usage_not_reported'] };
  const reasons = [];
  let unknown = false;
  for (const period of ['five_hour', 'weekly']) {
    const w = windows.find(w => w.period === period);
    if (!w || !['used', 'remaining'].includes(w.metric) || !Number.isFinite(w.percent)
      || w.percent < 0 || w.percent > 100 || !Number.isFinite(Date.parse(w.observedAt))
      || now - Date.parse(w.observedAt) > 5 * 60_000 || Date.parse(w.observedAt) > now
      || (w.resetAt && Date.parse(w.resetAt) <= now)) { unknown = true; continue; }
    const remaining = w.metric === 'used' ? 100 - w.percent : w.percent;
    if (period === 'five_hour' ? remaining < 3 : remaining <= 10) reasons.push(period);
  }
  return { state: reasons.length ? 'limited' : unknown ? 'unknown' : 'available', reasons };
}
