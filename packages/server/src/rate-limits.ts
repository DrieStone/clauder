import type { RateLimitInfo, RateLimitWindow } from '@clauder/shared';

const BUDGET_LIMIT = 5.0; // $5 default — configurable later
const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours

interface CostEvent {
  timestamp: number;
  delta: number;
}

const costLog: CostEvent[] = [];
let listener: ((info: RateLimitInfo) => void) | null = null;

// Real subscription usage parsed from the CLI's rate_limit_event. Null until the first
// event arrives. When set, the UI prefers these over the cost proxy so the bar matches
// the Claude app exactly.
let sessionWindow: RateLimitWindow | null = null;
let weeklyWindow: RateLimitWindow | null = null;

/** Record the real subscription windows from a rate_limit_event. Notifies the listener so
 *  the update broadcasts to all clients. */
export function recordSubscriptionLimits(windows: { session?: RateLimitWindow | null; weekly?: RateLimitWindow | null }): void {
  if (windows.session !== undefined) sessionWindow = windows.session;
  if (windows.weekly !== undefined) weeklyWindow = windows.weekly;
  listener?.(getRateLimitInfo());
}

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
    session: sessionWindow,
    weekly: weeklyWindow,
  };
}

/** Manually clear the cost log — used to zero the usage bar when the real
 *  subscription period rolls over (the cost proxy can't see the true reset boundary). */
export function resetRateLimit(): void {
  costLog.length = 0;
  listener?.(getRateLimitInfo());
}

/** Register callback for when rate limit info changes */
export function onRateLimitUpdate(callback: (info: RateLimitInfo) => void): void {
  listener = callback;
}
