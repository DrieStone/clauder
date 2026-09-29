import type { RateLimitInfo, RateLimitWindow, EffortLevel } from '@clauder/shared';
import { getCostSummary } from './cost-ledger.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

const BUDGET_LIMIT = 5.0; // $5 default — configurable later
const WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours

interface CostEvent {
  timestamp: number;
  delta: number;
}

const costLog: CostEvent[] = [];
let listener: ((info: RateLimitInfo) => void) | null = null;

// Real subscription usage parsed from the CLI's rate_limit_event. Null until the first
// event arrives (only present for subscribers, after the first API response). When set,
// the UI prefers these over the cost proxy so the bar matches the Claude app exactly.
let sessionWindow: RateLimitWindow | null = null;
let weeklyWindow: RateLimitWindow | null = null;
let weeklyOverageWindow: RateLimitWindow | null = null;

// ── Persistence ──────────────────────────────────────────────────────────────
// Windows are persisted so a server restart doesn't blank the quota display until the next
// API response arrives (that gap was one source of the "fuzzy" quota numbers). On load, a
// window whose resetsAt is already in the past is dropped rather than shown stale.
export const RATE_LIMITS_FILE = path.join(os.homedir(), '.clauder', 'rate-limits.json');

interface PersistedRateLimits {
  session: RateLimitWindow | null;
  weekly: RateLimitWindow | null;
  weeklyOverage: RateLimitWindow | null;
  savedAt: string;
}

export function saveRateLimits(file = RATE_LIMITS_FILE): void {
  try {
    const data: PersistedRateLimits = {
      session: sessionWindow, weekly: weeklyWindow, weeklyOverage: weeklyOverageWindow,
      savedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file); // atomic on the same filesystem
  } catch (err) {
    console.error('[RateLimit] Failed to persist rate limits:', err);
  }
}

/** Restore windows from disk. Only windows whose reset is still in the future are kept —
 *  a window that already rolled over would show a stale, misleading percentage. */
export function loadRateLimits(file = RATE_LIMITS_FILE): void {
  try {
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as PersistedRateLimits;
    const fresh = (w: RateLimitWindow | null | undefined): RateLimitWindow | null =>
      w && new Date(w.resetsAt).getTime() > Date.now() ? w : null;
    sessionWindow = fresh(data.session);
    weeklyWindow = fresh(data.weekly);
    weeklyOverageWindow = fresh(data.weeklyOverage);
    if (sessionWindow || weeklyWindow) {
      console.log(`[RateLimit] Restored from disk (saved ${data.savedAt}): five_hour=${sessionWindow?.usedPercent ?? '?'}% seven_day=${weeklyWindow?.usedPercent ?? '?'}%`);
    }
  } catch (err) {
    console.error('[RateLimit] Failed to load persisted rate limits:', err);
  }
}

loadRateLimits();

// ── Parsing ──────────────────────────────────────────────────────────────────
/** Pure parser for the CLI's rate_limit_event `rate_limit_info` payload. Exported so it can be
 *  unit-tested against captured real events.
 *
 *  CONFIRMED LIVE SHAPE (CLI 2.1.261, captured 2026-09-09):
 *    { status, resetsAt (epoch s), rateLimitType: "five_hour",
 *      overageStatus, overageDisabledReason, isUsingOverage,
 *      unifiedWindows: { five_hour: {utilization, resetsAt},
 *                        seven_day: {utilization, resetsAt},
 *                        seven_day_overage_included?: {utilization, resetsAt} } }
 *
 *  The real percentages live ONLY under `unifiedWindows` — there is no top-level
 *  `utilization`. The previous parser read a top-level field that doesn't exist, so
 *  usedPercent was always null and the seven_day window was dropped on every event.
 *  That was the root cause of the quota display never showing a percentage.
 *
 *  Status: the top-level `status` is authoritative for the window named by rateLimitType
 *  (that's what "rejected" gates key on). The other window's status is derived from its
 *  utilization. A legacy flat shape (top-level utilization, no unifiedWindows) is still
 *  handled for older CLIs. */
export function parseRateLimitEvent(info: any): { session?: RateLimitWindow; weekly?: RateLimitWindow; weeklyOverage?: RateLimitWindow } {
  if (!info || typeof info !== 'object') return {};
  const toIso = (t: any): string | null => {
    if (typeof t !== 'number' || !isFinite(t)) return null;
    return new Date(t < 1e12 ? t * 1000 : t).toISOString();
  };
  const pct = (u: any): number | null => typeof u === 'number' ? Math.max(0, Math.min(100, Math.round(u * 100))) : null;
  const derivedStatus = (u: any): string => typeof u !== 'number' ? '' : u >= 1 ? 'rejected' : u >= 0.9 ? 'allowed_warning' : 'allowed';
  const typed: string = info.rateLimitType ?? info.rate_limit_type ?? '';
  const topStatus: string = info.status ?? '';
  const out: { session?: RateLimitWindow; weekly?: RateLimitWindow; weeklyOverage?: RateLimitWindow } = {};

  const uw = info.unifiedWindows;
  if (uw && typeof uw === 'object') {
    const mk = (key: string): RateLimitWindow | undefined => {
      const w = uw[key];
      const resetsAt = toIso(w?.resetsAt) ?? toIso(info.resetsAt);
      if (!w || !resetsAt) return undefined;
      const status = key === typed && topStatus ? topStatus : derivedStatus(w.utilization);
      return { usedPercent: pct(w.utilization), resetsAt, status };
    };
    const s = mk('five_hour'); if (s) out.session = s;
    const w = mk('seven_day'); if (w) out.weekly = w;
    const o = mk('seven_day_overage_included'); if (o) out.weeklyOverage = o;
    return out;
  }

  // Legacy flat shape
  const resetsAt = toIso(info.resetsAt);
  if (!resetsAt) return {};
  const win: RateLimitWindow = { usedPercent: pct(info.utilization), resetsAt, status: topStatus };
  if (typed === 'seven_day') out.weekly = win; else out.session = win;
  return out;
}

/** Record the real subscription windows from a rate_limit_event. Notifies the listener so
 *  the update broadcasts to all clients, persists to disk, and logs STATUS TRANSITIONS
 *  (allowed → allowed_warning → rejected, and back) to the main log — a healthy steady
 *  state logs nothing. */
export function recordSubscriptionLimits(windows: { session?: RateLimitWindow | null; weekly?: RateLimitWindow | null; weeklyOverage?: RateLimitWindow | null }): void {
  const logTransition = (label: string, prev: RateLimitWindow | null, next: RateLimitWindow | null | undefined) => {
    if (!next || next.status === prev?.status) return;
    const p = next.usedPercent != null ? ` ${next.usedPercent}% used,` : '';
    console.log(`[RateLimit] ${label}: ${prev?.status ?? '(none)'} → ${next.status} —${p} resets ${next.resetsAt}`);
  };
  if (windows.session !== undefined) { logTransition('five_hour', sessionWindow, windows.session); sessionWindow = windows.session; }
  if (windows.weekly !== undefined) { logTransition('seven_day', weeklyWindow, windows.weekly); weeklyWindow = windows.weekly; }
  if (windows.weeklyOverage !== undefined) weeklyOverageWindow = windows.weeklyOverage;
  saveRateLimits();
  listener?.(getRateLimitInfo());
}

// ── Credit guardrail: effort capping ─────────────────────────────────────────
// Effort is the cache-SAFE cost dial: lowering it on the same model cuts thinking/output
// tokens without cold-starting the prompt cache (a model switch re-caches the whole context
// at 2× input price). As the five_hour window fills, routine turns get their effort capped
// so the window isn't exhausted by thinking tokens on work that didn't need them.
export const EFFORT_ORDER: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const QUOTA_EFFORT_CAPS: { atPercent: number; cap: EffortLevel }[] = [
  { atPercent: 90, cap: 'low' },
  { atPercent: 75, cap: 'medium' },
];

/** The effort cap in force for a given five_hour utilization, or null when unconstrained. */
export function effortCapForQuota(usedPercent: number | null | undefined): EffortLevel | null {
  if (usedPercent == null) return null;
  for (const c of QUOTA_EFFORT_CAPS) if (usedPercent >= c.atPercent) return c.cap;
  return null;
}

/** Apply a cap to a configured effort. An unset effort is treated as capped too (the CLI's
 *  own default may be high). Returns the effort to send and whether the cap changed it. */
export function capEffort(effort: EffortLevel | undefined, cap: EffortLevel | null): { effort: EffortLevel | undefined; capped: boolean } {
  if (!cap) return { effort, capped: false };
  if (!effort || EFFORT_ORDER.indexOf(effort) > EFFORT_ORDER.indexOf(cap)) return { effort: cap, capped: true };
  return { effort, capped: false };
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
    weeklyOverage: weeklyOverageWindow,
    costSummary: getCostSummary(),
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
