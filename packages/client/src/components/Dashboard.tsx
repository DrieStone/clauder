import { useState, useEffect } from 'react';
import { useSessions } from '../context/SessionContext';
import { SessionCard } from './SessionCard';
import { SessionConfigForm } from './SessionConfig';
import { SessionBrowser } from './SessionBrowser';
import { PauseControls } from './PauseBar';

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
  const { state, createSession, setActiveSession, setShowDiscovery } = useSessions();
  const [showNewSession, setShowNewSession] = useState(false);
  const [, setTick] = useState(0);

  // Re-render every 30s so tier classification and "X ago" labels stay fresh
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  const sessions = Array.from(state.sessions.values());
  const now = Date.now();

  const byRecent = (a: typeof sessions[0], b: typeof sessions[0]) =>
    new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime();

  const byName = (a: typeof sessions[0], b: typeof sessions[0]) =>
    a.config.name.localeCompare(b.config.name);

  // Active sessions sorted alphabetically so they don't jump around
  const hotSessions = sessions.filter(s => classifySession(s, now) === 'hot').sort(byName);
  const warmSessions = sessions.filter(s => classifySession(s, now) === 'warm').sort(byRecent);
  const historySessions = sessions.filter(s => classifySession(s, now) === 'history').sort(byRecent);

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-6 w-full">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-bold">Clauder</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {sessions.length} session{sessions.length !== 1 ? 's' : ''} active
            </p>
          </div>
          <div className="flex items-center gap-3">
            <PauseControls />
            <span className={`inline-flex items-center gap-1.5 text-xs ${state.wsConnected ? 'text-green-400' : 'text-red-400'}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${state.wsConnected ? 'bg-green-500' : 'bg-red-500'}`} />
              {state.wsConnected ? 'Connected' : 'Disconnected'}
            </span>
            <button
              onClick={() => setShowDiscovery(true)}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Pick Up Session
            </button>
            <button
              onClick={() => setShowNewSession(true)}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              + New Session
            </button>
          </div>
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
                      onClick={() => setActiveSession(session.id)}
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
                      onClick={() => setActiveSession(session.id)}
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
                      onClick={() => setActiveSession(session.id)}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {showNewSession && (
          <SessionConfigForm
            onSubmit={(config) => {
              createSession(config);
              setShowNewSession(false);
            }}
            onCancel={() => setShowNewSession(false)}
          />
        )}

        {state.showDiscovery && <SessionBrowser />}
      </div>
    </div>
  );
}
