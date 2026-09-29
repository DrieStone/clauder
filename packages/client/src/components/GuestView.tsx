import { useEffect, useState } from 'react';
import { SessionProvider, useSessions } from '../context/SessionContext';
import { GuestModeContext } from '../lib/guestMode';
import { MessageList } from './MessageList';
import { StatusBadge } from './StatusBadge';

/** The page behind a share link (/s/<token>): one session, live, for one named guest. The server
 *  scopes the connection to that session, so there's no dashboard, no other sessions, no files and
 *  no settings to hide here. The guest can read everything in the session and send messages. */
export function GuestApp({ token }: { token: string }) {
  return (
    <SessionProvider shareToken={token}>
      <GuestView />
    </SessionProvider>
  );
}

function Notice({ title, body }: { title: string; body?: string }) {
  return (
    <div className="h-dvh w-screen flex items-center justify-center bg-gray-950 text-gray-100 p-6">
      <div className="max-w-sm text-center space-y-2">
        <h1 className="text-base font-semibold">{title}</h1>
        {body && <p className="text-sm text-gray-400">{body}</p>}
      </div>
    </div>
  );
}

function GuestView() {
  const { state, sendMessage, interruptSession, requestHistory } = useSessions();
  const guest = state.guest;
  const session = guest ? state.sessions.get(guest.sessionId) : undefined;
  const sessionId = session?.id;
  const name = session?.config.name;

  // The connect payload carries only recent messages; fetch the rest once.
  useEffect(() => { if (sessionId) requestHistory(sessionId); }, [sessionId, requestHistory]);
  useEffect(() => { if (name) document.title = `${name} · shared`; }, [name]);

  if (state.accessDenied) {
    return <Notice title="This link doesn't work anymore" body="It was revoked or isn't valid. Ask the person who shared it for a new one." />;
  }
  if (!guest || !session) {
    return state.wsConnected
      ? <Notice title="Loading…" />
      : <Notice title="Connecting…" body="Share links only work on the same network as the computer that shared them." />;
  }

  const working = session.status === 'working';
  return (
    <GuestModeContext.Provider value={{ guestName: guest.guestName }}>
      <div className="h-dvh w-screen flex flex-col bg-gray-950 text-gray-100">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-gray-800 bg-gray-900/50 shrink-0">
          <h1 className="text-sm font-semibold truncate min-w-0">{session.config.name}</h1>
          <StatusBadge status={session.status} waitingFor={session.waitingFor} compact />
          <span className="ml-auto text-[11px] text-gray-500 shrink-0">Shared session · you're {guest.guestName}</span>
        </header>
        {!state.wsConnected && (
          <div className="bg-red-900/50 border-b border-red-800 px-4 py-1.5 text-xs text-red-300 text-center">Disconnected. Reconnecting…</div>
        )}
        <MessageList key={session.activeThreadId} messages={session.messages} sessionId={session.id} />
        <GuestComposer
          disabled={!state.wsConnected}
          working={working}
          onSend={(text) => sendMessage(session.id, text)}
          onStop={() => interruptSession(session.id)}
        />
      </div>
    </GuestModeContext.Provider>
  );
}

function GuestComposer({ working, disabled, onSend, onStop }: { working: boolean; disabled: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const [text, setText] = useState('');
  const send = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
  };
  return (
    <div className="shrink-0 border-t border-gray-800 p-3 space-y-1.5">
      {working && <div className="text-[11px] text-gray-500">Claude is working. New messages wait until it finishes.</div>}
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          rows={2}
          placeholder="Message Claude…"
          className="flex-1 min-w-0 resize-none bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        {working && (
          <button onClick={onStop} className="px-3 py-2 text-xs rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200">Stop</button>
        )}
        <button
          onClick={send}
          disabled={!text.trim() || disabled}
          className="px-3 py-2 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-medium"
        >
          Send
        </button>
      </div>
    </div>
  );
}
