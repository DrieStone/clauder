import { useEffect, useState } from 'react';
import type { Trigger } from '@clauder/shared';

interface WatchPanelProps {
  sessionId: string;
  triggers: Trigger[];
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'firing…';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function nextFireMs(t: Trigger): number {
  if (t.schedule.type === 'once') return new Date(t.schedule.at).getTime();
  return new Date(t.schedule.nextAt).getTime();
}

export function WatchPanel({ sessionId, triggers }: WatchPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Filter to watches owned by this session and sort by next fire
  const myWatches = triggers
    .filter(t => t.sessionId === sessionId && t.source === 'watch')
    .sort((a, b) => nextFireMs(a) - nextFireMs(b));

  if (myWatches.length === 0) return null;

  const next = myWatches[0];
  const nextRemaining = nextFireMs(next) - now;

  const handleRemove = async (id: string) => {
    try {
      await fetch(`/api/triggers/${id}`, { method: 'DELETE' });
    } catch {}
  };

  return (
    <div className="mx-4 mt-2 shrink-0">
      <div className="px-3 py-2 bg-purple-900/20 border border-purple-700/50 rounded text-xs text-purple-200 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="shrink-0">👁️</span>
          <span className="shrink-0">Watching {myWatches.length}</span>
          <span className="text-purple-400 shrink-0">·</span>
          <span className="shrink-0 font-mono text-purple-100">{formatRemaining(nextRemaining)}</span>
          <span className="text-purple-300 truncate" title={next.description}>
            — {next.description || '(no description)'}
          </span>
        </div>
        <button
          onClick={() => setExpanded(v => !v)}
          className="px-2.5 py-1 bg-purple-800/60 hover:bg-purple-700 text-white rounded transition-colors whitespace-nowrap"
        >
          {expanded ? 'Hide' : 'Manage'}
        </button>
      </div>

      {expanded && (
        <div className="mt-1 bg-gray-900/80 border border-purple-700/30 rounded p-2 space-y-1.5">
          {myWatches.map(w => {
            const remaining = nextFireMs(w) - now;
            const interval = w.schedule.type === 'recurring' ? `every ${Math.round(w.schedule.intervalSeconds / 60)}m` : 'once';
            return (
              <div key={w.id} className="flex items-start gap-2 text-xs px-2 py-1.5 bg-gray-800/60 rounded">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-purple-200 truncate">{w.description || '(no description)'}</div>
                  <div className="text-gray-400 mt-0.5">
                    <span className="font-mono">{formatRemaining(remaining)}</span>
                    <span className="mx-1.5">·</span>
                    <span>{interval}</span>
                    {w.lastFiredAt && (
                      <>
                        <span className="mx-1.5">·</span>
                        <span>last: {new Date(w.lastFiredAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                      </>
                    )}
                  </div>
                  <div className="text-gray-500 mt-0.5 italic truncate" title={w.message}>
                    "{w.message}"
                  </div>
                </div>
                <button
                  onClick={() => handleRemove(w.id)}
                  className="text-red-400 hover:text-red-300 text-[10px] px-2 py-1 hover:bg-red-900/30 rounded transition-colors shrink-0"
                  title="Remove watch"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
