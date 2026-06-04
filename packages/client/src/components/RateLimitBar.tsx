import { useState, useEffect } from 'react';
import { useSessions } from '../context/SessionContext';

const STALE_MS = 5 * 60 * 1000;

function formatCountdown(resetIso: string): string {
  const diff = new Date(resetIso).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const totalSec = Math.floor(diff / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function barColorFor(pct: number): string {
  return pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-blue-500';
}
function textColorFor(pct: number): string {
  return pct >= 90 ? 'text-red-400' : pct >= 70 ? 'text-amber-400' : 'text-gray-400';
}

export function RateLimitBar() {
  const { state, resetRateLimit } = useSessions();
  const rateLimit = state.rateLimit;
  const [, setTick] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 15_000);
    return () => clearInterval(interval);
  }, []);

  if (!rateLimit) return null;

  const now = Date.now();
  const real = rateLimit.session;

  if (real) {
    const rolled = new Date(real.resetsAt).getTime() <= now;
    const countdown = rolled ? null : formatCountdown(real.resetsAt);
    // usedPercent is null when the CLI fired without utilization data (fresh window / rejected).
    // Show "–" rather than a misleading 0% — the bar only fills when we have a real number.
    const knownPct = rolled ? 0 : real.usedPercent;
    const barWidth = knownPct ?? 0;
    const pctLabel = knownPct !== null ? `${knownPct}%` : '–';
    const weekly = rateLimit.weekly;
    const weeklyPct = weekly?.usedPercent !== null ? `${weekly?.usedPercent}%` : '–';
    const title = `Session: ${pctLabel} · resets ${new Date(real.resetsAt).toLocaleTimeString()}`
      + (weekly ? `\nWeekly: ${weeklyPct} · resets ${new Date(weekly.resetsAt).toLocaleString()}` : '')
      + (knownPct === null ? '\n(% only available near the limit)' : '');

    return (
      <div className="flex items-center gap-1.5" title={title}>
        <span className="text-[10px] uppercase tracking-wider text-gray-500">Session</span>
        <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
          <div className={`h-full ${barColorFor(barWidth)} rounded-full transition-all`} style={{ width: `${barWidth}%` }} />
        </div>
        <span className={`text-[10px] font-mono ${knownPct !== null ? textColorFor(knownPct) : 'text-gray-600'}`}>
          {pctLabel}
        </span>
        {countdown && <span className="text-[10px] text-gray-500">· resets {countdown}</span>}
      </div>
    );
  }

  // Fallback: cost proxy while no real event has arrived yet.
  const { budgetLimit, budgetUsed, windowResetAt, updatedAt } = rateLimit;
  const usedPct = budgetLimit > 0 ? Math.min(100, Math.round((budgetUsed / budgetLimit) * 100)) : 0;
  const stale = now - new Date(updatedAt).getTime() > STALE_MS;
  const barColor = stale ? 'bg-gray-600' : barColorFor(usedPct);
  const textColor = stale ? 'text-gray-600' : textColorFor(usedPct);
  const countdown = windowResetAt ? formatCountdown(windowResetAt) : null;

  return (
    <div className="flex items-center gap-1.5" title={stale ? 'Usage figure is stale — no activity in the last 5 min' : 'Estimated from cost (real subscription data not received yet)'}>
      <span className={`text-[10px] uppercase tracking-wider ${stale ? 'text-gray-600' : 'text-gray-500'}`}>Usage</span>
      <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${usedPct}%` }} />
      </div>
      <span className={`text-[10px] font-mono ${textColor}`}>{usedPct}%</span>
      {countdown && <span className={`text-[10px] ${stale ? 'text-gray-600' : 'text-gray-500'}`}>· resets {countdown}</span>}
      <button
        onClick={resetRateLimit}
        className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors"
        title="Reset usage to 0% — use when the period rolls over"
      >
        ↺
      </button>
    </div>
  );
}
