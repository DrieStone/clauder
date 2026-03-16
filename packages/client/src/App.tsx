import { SessionProvider, useSessions } from './context/SessionContext';
import { Dashboard } from './components/Dashboard';
import { SessionView } from './components/SessionView';
import { PauseBar } from './components/PauseBar';
import { LoginPage } from './components/LoginPage';
import { useEffect, useCallback, useState, useRef } from 'react';

function AppContent() {
  const { state, setActiveSession } = useSessions();
  const activeSession = state.activeSessionId
    ? state.sessions.get(state.activeSessionId) ?? null
    : null;

  // Persist unsent drafts per session across navigation
  const draftsRef = useRef<Map<string, string>>(new Map());

  // Keyboard shortcut: Escape to go back to dashboard
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state.activeSessionId) {
        setActiveSession(null);
      }
      // Ctrl+1-8 to switch to session by index
      if (e.ctrlKey && e.key >= '1' && e.key <= '8') {
        const idx = parseInt(e.key) - 1;
        const sessions = Array.from(state.sessions.values());
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
  const [authState, setAuthState] = useState<'checking' | 'authenticated' | 'unauthenticated'>('checking');

  useEffect(() => {
    fetch('/api/auth-check')
      .then(res => res.json())
      .then(data => setAuthState(data.authenticated ? 'authenticated' : 'unauthenticated'))
      .catch(() => setAuthState('unauthenticated'));
  }, []);

  if (authState === 'checking') {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950">
        <div className="text-sm text-gray-500">Loading...</div>
      </div>
    );
  }

  if (authState === 'unauthenticated') {
    return <LoginPage onSuccess={() => setAuthState('authenticated')} />;
  }

  return (
    <SessionProvider>
      <AppContent />
    </SessionProvider>
  );
}
