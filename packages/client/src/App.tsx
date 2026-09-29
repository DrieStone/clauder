import { SessionProvider, useSessions } from './context/SessionContext';
import { Dashboard } from './components/Dashboard';
import { SessionView } from './components/SessionView';
import { PauseBar } from './components/PauseBar';
import { SearchModal } from './components/SearchModal';
import { useEffect, useCallback, useRef, useState } from 'react';
import { onNotificationClick, markRead } from './lib/notifications';
import { getScratchSession, getNonScratchSessions } from './lib/sessions';
import { tailscaleOrigin } from './lib/hosts';

/** Track the visual viewport: its height AND its offsetTop. Height alone is not enough on
 *  iOS: when the on-screen keyboard opens, iOS both (a) shrinks the visual viewport and
 *  (b) SCROLLS it downward (offsetTop > 0) to chase the focused input — even with html/body
 *  locked at position:fixed, which pins the app to the LAYOUT viewport's top, not the visual
 *  one. Sizing to vv.height without also translating by vv.offsetTop produces exactly the
 *  "input bar at the top of the screen, dead black space below it" bug: the user is looking
 *  at the bottom slice of a correctly-shrunk app through a scrolled-down window. The fix is
 *  to make the app root hug the visual viewport on both axes: height = vv.height and
 *  translateY(vv.offsetTop). Listens to BOTH vv 'resize' and vv 'scroll' — offsetTop changes
 *  arrive on 'scroll', which a resize-only listener misses. */
function useVisualViewport(): { height: number; offsetTop: number } | null {
  const [vp, setVp] = useState<{ height: number; offsetTop: number } | null>(
    () => (typeof window !== 'undefined' && window.visualViewport)
      ? { height: window.visualViewport.height, offsetTop: window.visualViewport.offsetTop }
      : null,
  );

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return; // fall back to CSS h-dvh on browsers without the API
    const update = () => setVp({ height: vv.height, offsetTop: vv.offsetTop });
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return vp;
}

function AppContent() {
  const { state, setActiveSession, showSearch, openSearch, closeSearch, markSessionRead } = useSessions();
  const viewport = useVisualViewport();
  const activeSession = state.activeSessionId
    ? state.sessions.get(state.activeSessionId) ?? null
    : null;

  // Persist unsent drafts per session across navigation
  const draftsRef = useRef<Map<string, string>>(new Map());

  // Track whether we're in a session view without closing over stale state
  const isInSessionRef = useRef(!!state.activeSessionId);
  useEffect(() => { isInSessionRef.current = !!state.activeSessionId; }, [state.activeSessionId]);

  // Protect against accidental tab close and back-button navigation.
  // - beforeunload: shows the browser's "Leave site?" dialog on close/reload.
  // - popstate: back button goes to Dashboard first (if in a session); on Dashboard
  //   it re-pushes state so the back button stays trapped within Clauder.
  useEffect(() => {
    history.pushState({ clauder: true }, '');

    const handlePop = () => {
      history.pushState({ clauder: true }, ''); // re-trap immediately
      if (isInSessionRef.current) setActiveSession(null); // back → Dashboard
    };
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };

    window.addEventListener('popstate', handlePop);
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('popstate', handlePop);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [setActiveSession]);

  // Keyboard shortcut: Escape to go back to dashboard; Cmd/Ctrl+Shift+S jumps to scratch
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state.activeSessionId) {
        setActiveSession(null);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        const scratch = getScratchSession(state.sessions);
        if (scratch) setActiveSession(scratch.id);
      }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key === 'k') {
        e.preventDefault();
        openSearch();
      }
      // Ctrl+1-8 to switch to session by index (excluding scratch)
      if (e.ctrlKey && !e.shiftKey && e.key >= '1' && e.key <= '8') {
        const idx = parseInt(e.key) - 1;
        const sessions = getNonScratchSessions(state.sessions);
        if (idx < sessions.length) {
          setActiveSession(sessions[idx].id);
        }
      }
    },
    [state.activeSessionId, state.sessions, setActiveSession, openSearch],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Wire notification clicks to focus the session
  useEffect(() => {
    onNotificationClick((sessionId) => setActiveSession(sessionId));
  }, [setActiveSession]);

  // Mark notifications and unread state as read whenever a session is opened
  useEffect(() => {
    if (state.activeSessionId) {
      markRead(state.activeSessionId);
      markSessionRead(state.activeSessionId);
    }
  }, [state.activeSessionId]);

  // Keep marking as read whenever the active session gets new activity while you're viewing it,
  // so switching away never shows a false "unread" dot for responses you already saw.
  const activeLastActiveAt = activeSession?.lastActiveAt;
  useEffect(() => {
    if (state.activeSessionId && activeLastActiveAt) {
      markSessionRead(state.activeSessionId);
    }
  }, [state.activeSessionId, activeLastActiveAt]);

  // Read on another device → drop it from this tab's "(N) Clauder" title count too.
  useEffect(() => {
    for (const s of state.sessions.values()) {
      const lastRead = state.uiState.readAt[s.id];
      if (lastRead && Date.parse(lastRead) >= Date.parse(s.lastActiveAt)) markRead(s.id);
    }
  }, [state.uiState.readAt]);

  return (
    <div
      className="h-dvh w-screen overflow-x-hidden flex flex-col bg-gray-950 text-gray-100"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        // Hug the VISUAL viewport on both axes (see useVisualViewport): height matches the
        // keyboard-shrunk area, and translateY counters iOS scrolling the visual viewport
        // down to chase the focused input — without it, the header slides off the top and
        // dead space appears under the input bar.
        ...(viewport !== null ? {
          height: `${viewport.height}px`,
          transform: `translateY(${viewport.offsetTop}px)`,
        } : {}),
      }}
    >
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

      {showSearch && <SearchModal onClose={closeSearch} />}
    </div>
  );
}

/** Whether this device has owner access: the server decides (this Mac, Tailscale, or the owner
 *  link; see server auth.ts). A server from before that check answers with the app shell, which
 *  isn't JSON, and a network error changes nothing; both count as allowed. */
function useOwnerAccess(): 'checking' | 'owner' | 'denied' {
  const [access, setAccess] = useState<'checking' | 'owner' | 'denied'>('checking');
  useEffect(() => {
    fetch('/api/auth-check')
      .then(r => r.json())
      .then((j: { owner?: boolean }) => setAccess(j.owner === false ? 'denied' : 'owner'))
      .catch(() => setAccess('owner'));
  }, []);
  return access;
}

/** Shown instead of the app on a Wi-Fi device without owner access (a guest on the same network
 *  must not get the whole of Clauder). The owner's own devices get in via Tailscale, or by opening
 *  the owner link once. */
function NotSignedIn() {
  const tailscale = tailscaleOrigin();
  const [link, setLink] = useState('');
  const go = () => {
    const url = link.trim();
    if (/\/owner\/[0-9a-f]{32,}/i.test(url)) window.location.href = url;
  };
  return (
    <div className="h-dvh w-screen flex items-center justify-center bg-gray-950 text-gray-100 p-6">
      <div className="w-full max-w-sm space-y-4">
        <h1 className="text-lg font-semibold">This device isn't signed in to Clauder</h1>
        <p className="text-sm text-gray-400">
          Clauder opens on its own Mac and on your Tailscale devices automatically. Another device on
          Wi-Fi needs your owner link once.
        </p>
        {tailscale && window.location.origin !== tailscale && (
          <a href={tailscale} className="block text-center px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium">
            Open over Tailscale
          </a>
        )}
        <div>
          <label className="text-xs text-gray-500" htmlFor="owner-link">Or paste your owner link</label>
          <div className="flex gap-2 mt-1">
            <input
              id="owner-link"
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
              placeholder="http://JS.local:3001/owner/…"
              className="flex-1 min-w-0 text-sm bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <button onClick={go} className="px-3 py-2 text-sm rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-100">Go</button>
          </div>
        </div>
        <p className="text-xs text-gray-500">Were you sent a link to one shared session? Open that link instead.</p>
      </div>
    </div>
  );
}

export function App() {
  const access = useOwnerAccess();
  if (access === 'denied') return <NotSignedIn />;
  return (
    <SessionProvider>
      <AppContent />
    </SessionProvider>
  );
}
