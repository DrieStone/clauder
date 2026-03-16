import { useState, useEffect, useCallback } from 'react';
import { useSessions } from '../context/SessionContext';

function formatTime(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatCountdown(untilIso: string): string {
  const diff = new Date(untilIso).getTime() - Date.now();
  if (diff <= 0) return '0s';
  const totalSec = Math.ceil(diff / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Get HH:MM string for a Date in local time (for input[type=time] value) */
function toTimeInputValue(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function PauseBar() {
  const { state, pauseSessions, resumeSessions } = useSessions();
  const [, setTick] = useState(0);
  const [timeValue, setTimeValue] = useState('');

  const isPaused = state.pauseUntil && new Date(state.pauseUntil).getTime() > Date.now();

  // Tick every second while paused for countdown
  useEffect(() => {
    if (!isPaused) return;
    const interval = setInterval(() => setTick(t => t + 1), 1_000);
    return () => clearInterval(interval);
  }, [isPaused]);

  const handlePause = useCallback(() => {
    const value = timeValue || toTimeInputValue(new Date(Date.now() + 60 * 60_000));
    const [hours, minutes] = value.split(':').map(Number);
    const target = new Date();
    target.setHours(hours, minutes, 0, 0);
    // If the chosen time is in the past, assume tomorrow
    if (target.getTime() <= Date.now()) {
      target.setDate(target.getDate() + 1);
    }
    pauseSessions(target.toISOString());
    setTimeValue('');
  }, [timeValue, pauseSessions]);

  if (!isPaused) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-1.5 bg-amber-900/40 border-b border-amber-800/50 shrink-0">
      <span className="text-[10px] text-amber-400 uppercase tracking-wider font-medium">Paused</span>
      <span className="text-xs text-amber-300">
        until {formatTime(state.pauseUntil!)}
      </span>
      <span className="text-xs text-amber-300/70 font-mono">
        ({formatCountdown(state.pauseUntil!)})
      </span>
      <span className="text-[10px] text-amber-400/60">commands are queued</span>
      <button
        onClick={resumeSessions}
        className="ml-auto text-xs px-2.5 py-0.5 bg-amber-600 hover:bg-amber-500 text-white rounded transition-colors"
      >
        Resume Now
      </button>
    </div>
  );
}

/** Compact pause controls for embedding in other layouts (e.g. Dashboard header) */
export function PauseControls() {
  const { pauseSessions } = useSessions();
  const [timeValue, setTimeValue] = useState('');

  const defaultTime = toTimeInputValue(new Date(Date.now() + 60 * 60_000));

  const handlePause = useCallback(() => {
    const value = timeValue || defaultTime;
    const [hours, minutes] = value.split(':').map(Number);
    const target = new Date();
    target.setHours(hours, minutes, 0, 0);
    if (target.getTime() <= Date.now()) {
      target.setDate(target.getDate() + 1);
    }
    pauseSessions(target.toISOString());
    setTimeValue('');
  }, [timeValue, defaultTime, pauseSessions]);

  return (
    <div className="flex items-center gap-2">
      <input
        type="time"
        value={timeValue || defaultTime}
        onChange={(e) => setTimeValue(e.target.value)}
        className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500 [color-scheme:dark]"
      />
      <button
        onClick={handlePause}
        className="text-[10px] px-2.5 py-0.5 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors"
      >
        Pause
      </button>
    </div>
  );
}
