import { useEffect, useState } from 'react';
import type { PendingWakeup } from '@clauder/shared';

interface WakeupBannerProps {
  wakeup: PendingWakeup;
  onCancel: () => void;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'firing now…';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function WakeupBanner({ wakeup, onCancel }: WakeupBannerProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const scheduledMs = new Date(wakeup.scheduledAt).getTime();
  const remainingMs = scheduledMs - now;
  const scheduledTime = new Date(wakeup.scheduledAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  return (
    <div className="mx-4 mt-2 px-3 py-2 bg-blue-900/30 border border-blue-700 rounded text-xs text-blue-200 shrink-0 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0">⏰</span>
        <span className="shrink-0 font-mono text-blue-100">{formatRemaining(remainingMs)}</span>
        <span className="text-blue-300 shrink-0">— auto-resuming at {scheduledTime}</span>
        {wakeup.reason && (
          <span className="text-blue-400 truncate" title={wakeup.reason}>· {wakeup.reason}</span>
        )}
      </div>
      <button
        onClick={onCancel}
        className="px-2.5 py-1 bg-blue-800 hover:bg-blue-700 text-white rounded transition-colors whitespace-nowrap"
      >
        Cancel
      </button>
    </div>
  );
}
