import type { RateLimitInfo } from '@clauder/shared';

const BUDGET_LIMIT = 5.0; // $5 default — configurable later
const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours

interface CostEvent {
  timestamp: number;
  delta: number;
}

const costLog: CostEvent[] = [];
let listener: ((info: RateLimitInfo) => void) | null = null;

function prune(): void {
  const cutoff = Date.now() - WINDOW_MS;
  while (costLog.length > 0 && costLog[0].timestamp < cutoff) {
    costLog.shift();
  }
}

/** Record a cost increment and notify listener */
export function recordCostDelta(delta: number): void {
  if (delta <= 0) return;
  costLog.push({ timestamp: Date.now(), delta });
  prune();
  listener?.(getRateLimitInfo());
}

/** Compute current rate-limit info from the cost log */
export function getRateLimitInfo(): RateLimitInfo {
  prune();
  const budgetUsed = costLog.reduce((sum, e) => sum + e.delta, 0);
  const windowResetAt =
    costLog.length > 0
      ? new Date(costLog[0].timestamp + WINDOW_MS).toISOString()
      : null;
  return {
    budgetLimit: BUDGET_LIMIT,
    budgetUsed,
    windowResetAt,
    updatedAt: new Date().toISOString(),
  };
}

/** Register callback for when rate limit info changes */
export function onRateLimitUpdate(callback: (info: RateLimitInfo) => void): void {
  listener = callback;
}
