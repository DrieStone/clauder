import type { MonitorInfo } from '@clauder/shared';

interface MonitorBannerProps {
  monitors: MonitorInfo[];
  onStop: (monitorId: string) => void;
}

/** Shows active event-monitors for a session (the Clauder-native replacement for the CLI's
 *  `Monitor` tool), each with a Stop button. Rides SessionState.monitors, so it survives
 *  reconnects like the wakeup banner. */
export function MonitorBanner({ monitors, onStop }: MonitorBannerProps) {
  const running = monitors.filter(m => m.status === 'running');
  if (running.length === 0) return null;

  return (
    <div className="mx-4 mt-2 rounded border border-teal-700 bg-teal-950/40 shrink-0 divide-y divide-teal-800/50">
      {running.map(m => (
        <div key={m.id} className="px-3 py-1.5 flex items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <span className="shrink-0">👁</span>
            <span className="text-teal-100 truncate" title={`${m.command}${m.pattern ? `  ·  /${m.pattern}/` : ''}`}>
              {m.description}
            </span>
            <span className="text-teal-400 shrink-0 tabular-nums">
              {m.matchCount} match{m.matchCount !== 1 ? 'es' : ''}
            </span>
            {m.stopOnMatch && <span className="text-teal-500 shrink-0">· one-shot</span>}
          </div>
          <button
            onClick={() => onStop(m.id)}
            className="px-2 py-0.5 bg-teal-800 hover:bg-teal-700 text-white rounded transition-colors whitespace-nowrap shrink-0"
          >
            Stop
          </button>
        </div>
      ))}
    </div>
  );
}
