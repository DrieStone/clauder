import { usePopoverPlacement } from '../lib/popoverPosition';
import { useState, useRef, useEffect } from 'react';
import type { SessionState } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';

// Keeping a project's prompt cache warm (server/src/keep-warm.ts): the 🔥 in a session's header.
// Off: one click warms the project for 3 hours. On: a click opens the choices.

/** The project a session's warming belongs to (a Scratch conversation is its own). */
export const warmProjectId = (s: SessionState) => s.config.scratchConversation ? s.id : (s.config.mainSessionId ?? s.id);

export function warmLabel(until: string, mode: 'manual' | 'auto'): string {
  if (mode === 'auto') return 'auto';
  const mins = Math.max(0, Math.round((Date.parse(until) - Date.now()) / 60_000));
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
}

/** Hours from now until 11 PM (or 1 if that's past). */
const hoursUntilTonight = () => { const t = new Date(); t.setHours(23, 0, 0, 0); return Math.max(1, (t.getTime() - Date.now()) / 3_600_000); };

const IS_TOUCH = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

export function KeepWarmButton({ session }: { session: SessionState }) {
  const { state, setKeepWarm, setKeepWarmAuto } = useSessions();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // Kept on screen on a phone, where the button sits at the left of the header's second row.
  const placement = usePopoverPlacement(ref, open, 256);
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick(n => n + 1), 30_000); return () => clearInterval(i); }, []);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open]);
  const kw = state.keepWarm;
  if (!kw || session.config.isScratch) return null;
  const projectId = warmProjectId(session);
  const w = kw.projects[projectId];
  const hours = kw.defaultHours || 3;

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        // A touch screen has no right-click, so a tap always opens the menu there.
        onClick={() => (w || IS_TOUCH ? setOpen(o => !o) : setKeepWarm(projectId, hours))}
        onContextMenu={(e) => { e.preventDefault(); setOpen(o => !o); }}
        className={`text-[11px] px-1.5 py-0.5 rounded border whitespace-nowrap ${w ? 'text-orange-300 border-orange-500/40 bg-orange-500/10' : 'text-gray-500 border-gray-700 hover:text-gray-300'}`}
        title={w
          ? `Kept warm ${w.mode === 'auto' ? 'automatically (3 hours after its last turn)' : `until ${new Date(w.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}: a tiny hidden turn just before the cache expires, so coming back costs a cache read, not a full re-send. Click for options.`
          : `Keep this project warm for ${hours} hours, so coming back to it doesn't re-send the whole conversation. Right-click for options.`}
      >
        🔥{w ? ` ${warmLabel(w.until, w.mode)}` : ''}
      </button>
      {open && (
        <div style={placement ?? undefined} className="absolute right-0 top-full mt-1 z-50 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-2 space-y-1 text-xs text-gray-300">
          <div className="px-1 pb-1 text-[11px] text-gray-400">
            {w ? (w.mode === 'auto' ? 'Warm automatically: each session stays warm for 3 hours after its last turn.' : `Warm until ${new Date(w.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`) : 'Not being kept warm.'}
          </div>
          {[1, 3].map(h => (
            <button key={h} onClick={() => { setKeepWarm(projectId, h); setOpen(false); }} className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-700/60">Keep warm for {h} hour{h === 1 ? '' : 's'}</button>
          ))}
          <button onClick={() => { setKeepWarm(projectId, hoursUntilTonight()); setOpen(false); }} className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-700/60">Keep warm until 11 PM</button>
          {w?.mode === 'manual' && (
            <button onClick={() => { setKeepWarm(projectId, null); setOpen(false); }} className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-700/60 text-red-300">Stop</button>
          )}
          <label className="flex items-start gap-2 px-1 pt-1 border-t border-gray-700 cursor-pointer">
            <input type="checkbox" checked={kw.auto} onChange={(e) => setKeepWarmAuto(e.target.checked)} className="mt-0.5 accent-orange-500" />
            <span>Keep every session warm for 3 hours after its last turn <span className="text-gray-500">(every project and task)</span></span>
          </label>
          <div className="px-1 text-[10px] text-gray-500">{kw.pings} ping{kw.pings === 1 ? '' : 's'} so far, about ${kw.costUsd.toFixed(2)} at API rates</div>
        </div>
      )}
    </div>
  );
}
