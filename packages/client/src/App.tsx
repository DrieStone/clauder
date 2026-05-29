import { SessionProvider, useSessions } from './context/SessionContext';
import { Dashboard } from './components/Dashboard';
import { SessionView } from './components/SessionView';
import { PauseBar } from './components/PauseBar';
import { useEffect, useCallback, useRef } from 'react';
import { onNotificationClick, markRead } from './lib/notifications';

function AppContent() {
  const { state, setActiveSession } = useSessions();
  const activeSession = state.activeSessionId
    ? state.sessions.get(state.activeSessionId) ?? null
    : null;

  // Persist unsent drafts per session across navigation
  const draftsRef = useRef<Map<string, string>>(new Map());

  // Keyboard shortcut: Escape to go back to dashboard; Cmd/Ctrl+Shift+S jumps to scratch
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state.activeSessionId) {
        setActiveSession(null);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        const scratch = Array.from(state.sessions.values()).find(s => s.config.isScratch);
        if (scratch) setActiveSession(scratch.id);
      }
      // Ctrl+1-8 to switch to session by index (excluding scratch)
      if (e.ctrlKey && !e.shiftKey && e.key >= '1' && e.key <= '8') {
        const idx = parseInt(e.key) - 1;
        const sessions = Array.from(state.sessions.values()).filter(s => !s.config.isScratch);
        if (idx < sessions.length) {
          setActiveSession(sessions[idx].id);
        }
      }
    },
    [state.activeSessionId, state.sessions, setActiveSession],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Wire notification clicks to focus the session
  useEffect(() => {
    onNotificationClick((sessionId) => setActiveSession(sessionId));
  }, [setActiveSession]);

  // Mark notifications as read whenever a session is opened
  useEffect(() => {
    if (state.activeSessionId) markRead(state.activeSessionId);
  }, [state.activeSessionId]);

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-100">
      {/* Pause bar */}
      <PauseBar />

      {/* Disconnected banner */}
      {!state.wsConnected && (
        <div className="bg-red-900/50 border-b border-red-800 px-4 py-1.5 text-xs text-red-300 text-center">
          Disconnected from server. Reconnecting...
        </div>
      )}

      {activeSession ? (
        <SessionView
          session={activeSession}
          allSessions={Array.from(state.sessions.values())}
          onBack={() => setActiveSession(null)}
          onSwitchSession={(id) => setActiveSession(id)}
          draft={draftsRef.current.get(activeSession.id) ?? ''}
          onDraftChange={(v) => { draftsRef.current.set(activeSession.id, v); }}
        />
      ) : (
        <Dashboard />
      )}
    </div>
  );
}

export function App() {
  return (
    <SessionProvider>
      <AppContent />
    </SessionProvider>
  );
}
