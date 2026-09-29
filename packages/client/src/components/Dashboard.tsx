import { useState, useEffect, useRef } from 'react';
import { useSessions } from '../context/SessionContext';
import { SessionCard } from './SessionCard';
import { SessionConfigForm } from './SessionConfig';
import { SessionBrowser } from './SessionBrowser';
import { PauseControls } from './PauseBar';
import { SchedulerModal } from './SchedulerModal';
import { NotificationToggle } from './NotificationToggle';
import { TagFilter } from './Tags';

/** Admin actions menu — currently just "Restart Server". Tucked behind a gear icon (not a
 *  prominent button) since it interrupts every active session; confirms before firing. */
function DashboardSettingsMenu({ sessionCount }: { sessionCount: number }) {
  const { restartServer, logEvent } = useSessions();
  const [open, setOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const handleRestart = async () => {
    const plural = sessionCount !== 1 ? 's' : '';
    const ok = confirm(
      `Restart the Clauder server? This will interrupt ${sessionCount} active session${plural} ` +
      `(any in-flight Claude turn gets cut off) for about 10-20 seconds while it restarts. ` +
      `Current session state is saved first.`,
    );
    if (!ok) return;
    setRestarting(true);
    logEvent('server_restart');
    await restartServer();
    // Leave the "Restarting..." state up — the page will reconnect on its own once the
    // server is back (WsClient's reconnect/host-rollover logic handles that), and the
    // existing "Disconnected from server. Reconnecting..." banner covers the interim.
  };

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen(o => { if (!o) logEvent('dashboard_settings_open'); return !o; })}
        className="p-2 text-gray-400 hover:text-gray-200 transition-colors flex items-center"
        title="Server settings"
        aria-label="Server settings"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-56 bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-2">
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="w-full text-left px-2 py-2 rounded text-xs text-red-300 hover:bg-gray-700/60 disabled:opacity-50 disabled:cursor-wait transition-colors"
          >
            {restarting ? 'Restarting…' : 'Restart Server'}
          </button>
        </div>
      )}
    </div>
  );
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const THIRTY_SIX_HOURS_MS = 36 * 60 * 60 * 1000;

function classifySession(s: { lastActiveAt: string; status: string }, now: number) {
  // Working sessions are always "hot" regardless of time
  if (s.status === 'working') return 'hot' as const;
  const age = now - new Date(s.lastActiveAt).getTime();
  if (age < ONE_HOUR_MS) return 'hot' as const;
  if (age < THIRTY_SIX_HOURS_MS) return 'warm' as const;
  return 'history' as const;
}

export function Dashboard() {
  const { state, createSession, setActiveSession, setShowDiscovery, logEvent, openSearch, isUnread } = useSessions();
  const [showNewSession, setShowNewSession] = useState(false);
  const [showScheduler, setShowScheduler] = useState(false);
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [, setTick] = useState(0);

  // Re-render every 30s so tier classification and "X ago" labels stay fresh
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  // Scratch session is treated as a normal session card in the Active tier;
  // its visual distinction (amber border + badge) is handled in SessionCard.
  const sessions = Array.from(state.sessions.values());
  const now = Date.now();

  const byRecent = (a: typeof sessions[0], b: typeof sessions[0]) =>
    new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();

  const byName = (a: typeof sessions[0], b: typeof sessions[0]) =>
    a.config.name.localeCompare(b.config.name);

  // Active sessions: "needs you" sessions float to the top (waitingFor set), then alphabetical.
  // Scratch is always shown in Active regardless of its lastActiveAt age.
  const byNeedsYouThenName = (a: typeof sessions[0], b: typeof sessions[0]) => {
    const aNeeds = a.waitingFor ? 0 : 1;
    const bNeeds = b.waitingFor ? 0 : 1;
    if (aNeeds !== bNeeds) return aNeeds - bNeeds;
    return a.config.name.localeCompare(b.config.name);
  };
  // Tag filter (OR semantics): when any tag is selected, only sessions carrying at least one of
  // them are shown — applied uniformly, so even Scratch is hidden while a filter is active.
  const matchesTags = (s: typeof sessions[0]) =>
    tagFilter.size === 0 || (s.config.tags ?? []).some(t => tagFilter.has(t));
  const visible = sessions.filter(matchesTags);
  const hotSessions = visible.filter(s => s.config.isScratch || classifySession(s, now) === 'hot' || !!s.waitingFor).sort(byNeedsYouThenName);
  const warmSessions = visible.filter(s => !s.config.isScratch && !s.waitingFor && classifySession(s, now) === 'warm').sort(byRecent);
  const historySessions = visible.filter(s => !s.config.isScratch && !s.waitingFor && classifySession(s, now) === 'history').sort(byRecent);

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="p-3 sm:p-6 w-full min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 gap-2">
          <div className="min-w-0">
            <h1 className="text-xl font-bold">Clauder</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {sessions.length} session{sessions.length !== 1 ? 's' : ''} active
            </p>
          </div>
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap justify-end">
            <PauseControls />
            <span className={`inline-flex items-center gap-1.5 text-xs ${state.wsConnected ? 'text-green-400' : 'text-red-400'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${state.wsConnected ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="hidden sm:inline">{state.wsConnected ? 'Connected' : 'Disconnected'}</span>
            </span>
            <NotificationToggle />
            <button
              onClick={() => { logEvent('search_modal_open'); openSearch(); }}
              className="p-2 min-h-[44px] sm:min-h-0 text-gray-400 hover:text-gray-200 transition-colors flex items-center"
              title="Search sessions and files (Cmd/Ctrl+K)"
              aria-label="Search"
            >
              🔍
            </button>
            <button
              onClick={() => { logEvent('scheduler_modal_open'); setShowScheduler(true); }}
              className="hidden sm:flex px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
              title="Schedule tasks and manage overnight runs"
            >
              Automation
            </button>
            <button
              onClick={() => { logEvent('discovery_modal_open'); setShowDiscovery(true); }}
              className="hidden sm:flex px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Pick Up Session
            </button>
            <button
              onClick={() => setShowNewSession(true)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              + New
            </button>
            <DashboardSettingsMenu sessionCount={sessions.length} />
          </div>
        </div>

        {/* Tag filter bar — renders nothing when no tags exist */}
        <div className="mb-4 -mt-2">
          <TagFilter
            selected={tagFilter}
            onToggle={(id) => setTagFilter(prev => {
              const next = new Set(prev);
              next.has(id) ? next.delete(id) : next.add(id);
              return next;
            })}
            onClear={() => setTagFilter(new Set())}
          />
        </div>

        {sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-500">
            <div className="text-4xl mb-3">&#x1f4ac;</div>
            <p className="text-sm mb-4">No sessions yet. Create one to get started.</p>
            <button
              onClick={() => setShowDiscovery(true)}
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              Or pick up an existing session from VS Code
            </button>
          </div>
        ) : (
          <div className="space-y-8">
            {/* Active: compact cards sorted alphabetically */}
            {hotSessions.length > 0 && (
              <section>
                <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                  Active
                </h2>
                <div className="grid grid-cols-1 active-grid gap-3">
                  {hotSessions.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      tier="warm"
                      unread={isUnread(session)}
                      onOpen={setActiveSession}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Warm: 1-36 hours. Large card, no chat. Responsive 1/2 col at 1000px. */}
            {warmSessions.length > 0 && (
              <section>
                <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                  Recent
                </h2>
                <div className="grid grid-cols-1 active-grid gap-4">
                  {warmSessions.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      tier="warm"
                      unread={isUnread(session)}
                      onOpen={setActiveSession}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* History: 36+ hours. Minimal rows. 1/2 col at 1000px. */}
            {historySessions.length > 0 && (
              <section>
                <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                  History
                </h2>
                <div className="grid grid-cols-1 history-grid gap-2">
                  {historySessions.map((session) => (
                    <SessionCard
                      key={session.id}
                      session={session}
                      tier="history"
                      unread={isUnread(session)}
                      onOpen={setActiveSession}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {showNewSession && (
          <SessionConfigForm
            onSubmit={(config, opts) => {
              createSession(config, opts);
              setShowNewSession(false);
            }}
            onCancel={() => setShowNewSession(false)}
          />
        )}

        {state.showDiscovery && <SessionBrowser />}

        {showScheduler && <SchedulerModal onClose={() => setShowScheduler(false)} />}
      </div>
    </div>
  );
}
