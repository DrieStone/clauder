import { useState, useEffect, useRef } from 'react';
import { useSessions } from '../context/SessionContext';
import type { RateLimitWindow, CostSummaryWindow } from '@clauder/shared';
import { MODELS } from './ModelEffortSelector';
import { usePopoverPlacement } from '../lib/popoverPosition';

// Friendly labels for the cost tables, matching ModelEffortSelector's id-to-label mapping
// (plus a couple of ids that can show up in the ledger but aren't in the model picker).
const MODEL_LABELS: Record<string, string> = {
  ...Object.fromEntries(MODELS.map(m => [m.id, m.label])),
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5': 'Sonnet 5',
};
const modelLabel = (id: string) => MODEL_LABELS[id] ?? id.replace(/^claude-/, '');

const SOON_MS = 30 * 60 * 1000; // green countdown threshold

function formatCountdown(resetIso: string): { label: string; soonMs: number } {
  const diff = new Date(resetIso).getTime() - Date.now();
  if (diff <= 0) return { label: 'now', soonMs: 0 };
  const totalSec = Math.floor(diff / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const label = d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  return { label, soonMs: diff };
}

type Level = 'ok' | 'high' | 'warn' | 'limit';

/** How close a window is to its cap — the same thresholds the CLI uses for its own
 *  allowed / allowed_warning / rejected statuses. */
function level(w: RateLimitWindow): Level {
  const pct = w.usedPercent ?? 0;
  if (w.status === 'rejected' || pct >= 100) return 'limit';
  if (w.status === 'allowed_warning' || pct >= 90) return 'warn';
  if (pct >= 60) return 'high';
  return 'ok';
}

const LEVEL_TEXT: Record<Level, string> = { ok: 'text-gray-300', high: 'text-amber-300', warn: 'text-red-300', limit: 'text-red-400' };
const LEVEL_FILL: Record<Level, string> = { ok: 'bg-gray-400', high: 'bg-amber-400', warn: 'bg-red-400', limit: 'bg-red-500' };

/** One full-width usage bar in the collapsed header widget. */
function HeaderBar({ w }: { w: RateLimitWindow }) {
  const pct = Math.max(0, Math.min(100, w.usedPercent ?? 0));
  return (
    <span className="block h-[3px] rounded-full bg-gray-800 overflow-hidden">
      <span className={`block h-full rounded-full ${LEVEL_FILL[level(w)]}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

/** The countdown takes on the window's warning color as usage nears the cap, so when you're about
 *  to be cut off, "how long until it resets" is what stands out. Green when the reset is close. */
function countdownClass(w: RateLimitWindow, soonMs: number): string {
  const lv = level(w);
  if (lv === 'limit') return 'text-red-400 font-semibold';
  if (soonMs < SOON_MS) return 'text-green-400';
  if (lv === 'warn') return 'text-red-300';
  if (lv === 'high') return 'text-amber-300';
  return 'text-gray-400';
}

function UsageBar({ label, w }: { label: string; w: RateLimitWindow }) {
  const pct = Math.max(0, Math.min(100, w.usedPercent ?? 0));
  const { label: resetLabel } = formatCountdown(w.resetsAt);
  return (
    <div className="mb-2 last:mb-0">
      <div className="flex items-center justify-between text-gray-400">
        <span>{label}</span>
        <span className={`font-semibold ${LEVEL_TEXT[level(w)]}`}>{w.usedPercent != null ? `${w.usedPercent}%` : '?'}</span>
      </div>
      <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden mt-0.5">
        <div className={`h-full ${LEVEL_FILL[level(w)]}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="text-gray-500 mt-0.5">resets {resetLabel}</div>
    </div>
  );
}

function CostTable({ title, w }: { title: string; w: CostSummaryWindow | undefined }) {
  const entries = w ? Object.entries(w.byModel).sort((a, b) => b[1].cost - a[1].cost) : [];
  return (
    <div className="mb-2 last:mb-0">
      <div className="text-gray-400 font-semibold mb-1">{title}</div>
      {!w || entries.length === 0 ? (
        <div className="text-gray-500">no data yet</div>
      ) : (
        <table className="w-full">
          <tbody>
            {entries.map(([modelId, m]) => (
              <tr key={modelId}>
                <td className="text-gray-300 pr-2 truncate max-w-[140px]">{modelLabel(modelId)}</td>
                <td className="text-gray-500 pr-2 text-right whitespace-nowrap">{m.turns}×</td>
                <td className="text-gray-200 text-right whitespace-nowrap">${m.cost.toFixed(2)}</td>
              </tr>
            ))}
            <tr className="border-t border-gray-700">
              <td className="text-gray-400 pr-2 pt-0.5">Total</td>
              <td className="pt-0.5" />
              <td className="text-gray-100 font-semibold text-right pt-0.5 whitespace-nowrap">${w.total.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Real subscription quota (parsed from the CLI's rate_limit_event `unifiedWindows`, persisted
 *  server-side so it survives restarts), collapsed into a small stacked widget: the 5-hour
 *  window's bar on top, its reset countdown in the middle, the 7-day window's bar underneath.
 *  Exact percentages live in the tooltip and the click-open breakdown. Falls back to the
 *  cost-proxy countdown only when no real event has ever been seen. */
export function RateLimitBar() {
  const { state } = useSessions();
  const rateLimit = state.rateLimit;
  const [, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 15_000);
    return () => clearInterval(interval);
  }, []);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Must run before the early return below (rules of hooks).
  const placement = usePopoverPlacement(containerRef, open, 280);

  if (!rateLimit) return null;

  const now = Date.now();
  const live = (w: RateLimitWindow | null | undefined) => (w && new Date(w.resetsAt).getTime() > now ? w : null);
  const session = live(rateLimit.session);
  const weekly = live(rateLimit.weekly);
  const overage = live(rateLimit.weeklyOverage);

  if (session || weekly) {
    // The countdown belongs to the 5-hour window; the 7-day one stands in only when it's all we have.
    const primary = (session ?? weekly)!;
    const { label: resetLabel, soonMs } = formatCountdown(primary.resetsAt);
    const lines = [
      session && weekly ? 'Top bar: 5-hour window · middle: time until it resets · bottom bar: 7-day window' : null,
      session ? `5-hour window: ${session.usedPercent ?? '?'}% used, resets ${new Date(session.resetsAt).toLocaleTimeString()}` : null,
      weekly ? `7-day window: ${weekly.usedPercent ?? '?'}% used, resets ${new Date(weekly.resetsAt).toLocaleString()}` : null,
      overage && overage.usedPercent != null && overage.usedPercent !== weekly?.usedPercent
        ? `7-day incl. overage: ${overage.usedPercent}%` : null,
      'Fable, Opus and Sonnet all draw from these same windows — pricier models just consume them faster.',
      'Click for a full breakdown.',
    ].filter(Boolean).join('\n');
    return (
      <div ref={containerRef} className="relative shrink-0">
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          className="flex flex-col justify-center gap-[3px] w-14 sm:w-20 min-h-[40px] sm:min-h-0 px-1 sm:px-0 shrink-0 cursor-pointer"
          title={lines}
          aria-label={`Usage limits: ${[
            session ? `5-hour ${session.usedPercent ?? '?'}%` : null,
            weekly ? `7-day ${weekly.usedPercent ?? '?'}%` : null,
          ].filter(Boolean).join(', ')}, resets in ${resetLabel}`}
        >
          {session && <HeaderBar w={session} />}
          <span className={`text-[10px] leading-none font-mono tabular-nums text-center whitespace-nowrap ${countdownClass(primary, soonMs)}`}>
            {resetLabel}
          </span>
          {weekly && <HeaderBar w={weekly} />}
        </button>
        {open && (
          <div className="absolute right-0 top-full mt-1 z-50 bg-gray-900 border border-gray-700 rounded p-3 text-xs max-w-[280px] w-[280px] shadow-lg" style={placement ?? undefined}>
            {session && <UsageBar label="5-hour window" w={session} />}
            {weekly && <UsageBar label="7-day window" w={weekly} />}
            <div className="border-t border-gray-800 my-2" />
            <CostTable title="Last 24h" w={rateLimit.costSummary?.last24h} />
            <CostTable title="Last 7d" w={rateLimit.costSummary?.last7d} />
          </div>
        )}
      </div>
    );
  }

  // Fallback: cost proxy countdown only (no real event seen yet)
  const { windowResetAt } = rateLimit;
  if (!windowResetAt) return null;
  const { label, soonMs } = formatCountdown(windowResetAt);
  return (
    <span
      className={`text-[10px] font-mono transition-colors ${soonMs < SOON_MS ? 'text-green-400' : 'text-gray-500'}`}
      title="Estimated reset time (no subscription data yet)"
    >
      resets {label}
    </span>
  );
}
