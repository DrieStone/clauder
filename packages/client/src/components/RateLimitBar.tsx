import { useState, useEffect } from 'react';
import type { RateLimitInfo } from '@clauder/shared';

function formatCountdown(resetIso: string): string {
  const resetMs = new Date(resetIso).getTime();
  const nowMs = Date.now();
  const diff = resetMs - nowMs;
  if (diff <= 0) return 'now';

  const totalSec = Math.floor(diff / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function RateLimitBar({ rateLimit }: { rateLimit: RateLimitInfo }) {
  const [, setTick] = useState(0);

  // Re-render every 30s to keep countdown fresh
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const { budgetLimit, budgetUsed, windowResetAt } = rateLimit;
  const usedPct = budgetLimit > 0 ? Math.min(100, Math.round((budgetUsed / budgetLimit) * 100)) : 0;

  const barColor =
    usedPct >= 90 ? 'bg-red-500' : usedPct >= 70 ? 'bg-amber-500' : 'bg-blue-500';
  const textColor =
    usedPct >= 90 ? 'text-red-400' : usedPct >= 70 ? 'text-amber-400' : 'text-gray-400';

  const countdown = windowResetAt ? formatCountdown(windowResetAt) : null;

  return (
    <div className="flex items-center gap-3 px-4 py-1 bg-gray-900/80 border-b border-gray-800/50 shrink-0">
      <span className="text-[10px] text-gray-500 uppercase tracking-wider">5hr Budget</span>
      <div className="flex-1 max-w-48 h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} rounded-full transition-all`}
          style={{ width: `${usedPct}%` }}
        />
      </div>
      <span className={`text-[11px] font-mono font-medium ${textColor}`}>
        ${budgetUsed.toFixed(2)} / ${budgetLimit.toFixed(2)}
      </span>
      {countdown && (
        <span className="text-[10px] text-gray-500">
          resets in <span className={textColor}>{countdown}</span>
        </span>
      )}
    </div>
  );
}
