import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react';
import type { ImageAttachment, FileAttachment } from '@clauder/shared';
import { SessionProvider, useSessions } from '../context/SessionContext';
import { MAX_IMAGES, MAX_FILES, readImage, readFile } from '../lib/attachments';
import { GuestModeContext } from '../lib/guestMode';
import { MessageList } from './MessageList';
import { StatusBadge } from './StatusBadge';
import { TaskChips } from './ProjectTasks';
import { tasksOf } from '../lib/projects';

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
  // A link shares a whole project: its main session and its tasks, which the guest can switch between.
  const main = guest ? state.sessions.get(guest.sessionId) : undefined;
  const tasks = main ? tasksOf(main.id, state.sessions.values()) : [];
  const [viewId, setViewId] = useState<string | null>(null);
  const session = (viewId ? state.sessions.get(viewId) : undefined) ?? main;
  const sessionId = session?.id;
  const name = main?.config.name;

  // The connect payload carries only recent messages; fetch the rest once.
  useEffect(() => { if (sessionId) requestHistory(sessionId); }, [sessionId, requestHistory]);
  useEffect(() => { if (name) document.title = `${name} · shared`; }, [name]);

  if (state.accessDenied) {
    return <Notice title="This link doesn't work anymore" body="It was revoked or isn't valid. Ask the person who shared it for a new one." />;
  }
  if (!guest || !session || !main) {
    return state.wsConnected
      ? <Notice title="Loading…" />
      : <Notice title="Connecting…" body="Share links only work on the same network as the computer that shared them." />;
  }

  const working = session.status === 'working';
  return (
    <GuestModeContext.Provider value={{ guestName: guest.guestName }}>
      <div className="h-dvh w-screen flex flex-col bg-gray-950 text-gray-100">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-gray-800 bg-gray-900/50 shrink-0">
          <h1 className="text-sm font-semibold truncate min-w-0">
            {main.config.name}{session.id !== main.id && <span className="text-gray-400 font-normal"> › {session.config.name}</span>}
          </h1>
          <StatusBadge status={session.status} waitingFor={session.waitingFor} compact />
          <span className="ml-auto text-[11px] text-gray-500 shrink-0">Shared session · you're {guest.guestName}</span>
        </header>
        {!state.wsConnected && (
          <div className="bg-red-900/50 border-b border-red-800 px-4 py-1.5 text-xs text-red-300 text-center">Disconnected. Reconnecting…</div>
        )}
        <MessageList key={`${session.id}:${session.activeThreadId}`} messages={session.messages} sessionId={session.id} />
        {tasks.length > 0 && (
          <div className="shrink-0 border-t border-gray-800/60 px-3 py-1 flex items-center gap-1 overflow-x-auto">
            <span className="text-[10px] uppercase tracking-wider text-gray-500 shrink-0 mr-1">Tasks</span>
            <TaskChips main={main} tasks={tasks} activeId={session.id} onSelect={setViewId} isUnread={() => false} />
          </div>
        )}
        <GuestComposer
          disabled={!state.wsConnected}
          working={working}
          error={session.error === 'AUTH_EXPIRED' ? "The owner's Claude login needs renewing." : session.error}
          onSend={(text, images, files) => sendMessage(session.id, text, images.length ? images : undefined, false, files.length ? files : undefined)}
          onStop={() => interruptSession(session.id)}
        />
      </div>
    </GuestModeContext.Provider>
  );
}

/** Up to 50 MB of attachments per message; the server enforces the same (guest-view.ts). */
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

function GuestComposer({ working, disabled, error, onSend, onStop }: {
  working: boolean;
  disabled: boolean;
  /** The session's last error, including a refused upload's reason from the server. */
  error: string | null;
  onSend: (text: string, images: ImageAttachment[], files: FileAttachment[]) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const pickerRef = useRef<HTMLInputElement>(null);

  // Same reading and limits as the owner's composer (lib/attachments.ts).
  const add = useCallback((list: ArrayLike<File>) => {
    for (const file of Array.from(list)) {
      if (file.type.startsWith('image/')) {
        readImage(file).then(image => setImages(prev => {
          if (prev.length >= MAX_IMAGES) { setAttachError(`Up to ${MAX_IMAGES} images per message.`); return prev; }
          setAttachError(null);
          return [...prev, image];
        }), (err: Error) => setAttachError(err.message));
      } else {
        readFile(file).then(attachment => setFiles(prev => {
          if (prev.length >= MAX_FILES) { setAttachError(`Up to ${MAX_FILES} files per message.`); return prev; }
          setAttachError(null);
          return [...prev, attachment];
        }), (err: Error) => setAttachError(err.message));
      }
    }
  }, []);

  // Files dropped anywhere on the page attach, as in the owner's view.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); setDragOver(true); };
    const onDrop = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); setDragOver(false); add(e.dataTransfer?.files ?? []); };
    const onDragLeave = (e: DragEvent) => { if (e.relatedTarget === null) setDragOver(false); };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragleave', onDragLeave);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragleave', onDragLeave);
    };
  }, [add]);

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(e.clipboardData.items).filter(i => i.kind === 'file').map(i => i.getAsFile()).filter((f): f is File => !!f);
    if (pasted.length) { e.preventDefault(); add(pasted); }
  };

  const hasContent = !!text.trim() || images.length > 0 || files.length > 0;
  const send = () => {
    if (!hasContent || disabled) return;
    const bytes = (images.reduce((n, i) => n + i.data.length, 0) + files.reduce((n, f) => n + f.content.length, 0)) * 0.75;
    if (bytes > MAX_TOTAL_BYTES) { setAttachError('The attachments are over 50 MB together.'); return; }
    onSend(text.trim(), images, files);
    setText('');
    setImages([]);
    setFiles([]);
    setAttachError(null);
  };

  const shownError = attachError ?? error;
  return (
    <div className={`shrink-0 border-t p-3 space-y-1.5 ${dragOver ? 'border-blue-500 bg-blue-950/20' : 'border-gray-800'}`}>
      {dragOver && <div className="text-[11px] text-blue-300">Drop to attach</div>}
      {working && <div className="text-[11px] text-gray-500">Claude is working. New messages wait until it finishes.</div>}
      {shownError && <div className="text-[11px] text-red-300">{shownError}</div>}
      {(images.length > 0 || files.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((img, i) => (
            <div key={`img-${i}`} className="relative">
              <img src={`data:${img.mimeType};base64,${img.data}`} alt="" className="w-12 h-12 object-cover rounded border border-gray-700" />
              <button
                onClick={() => setImages(prev => prev.filter((_, j) => j !== i))}
                className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-gray-600 hover:bg-gray-500 text-[10px] leading-none text-white"
                aria-label="Remove image"
              >×</button>
            </div>
          ))}
          {files.map((f, i) => (
            <span key={`file-${i}`} className="flex items-center gap-1 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-300">
              <span>{f.kind === 'document' ? '📄' : f.kind === 'text' ? '📝' : '📎'}</span>
              <span className="max-w-[160px] truncate">{f.name}</span>
              <button onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} className="text-gray-500 hover:text-gray-200" aria-label={`Remove ${f.name}`}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2">
        <button
          onClick={() => pickerRef.current?.click()}
          disabled={disabled}
          className="px-2.5 py-2 text-sm rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-40 text-gray-300"
          title="Attach files or images"
          aria-label="Attach files"
        >📎</button>
        <input
          ref={pickerRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ''; }}
        />
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          onPaste={onPaste}
          rows={2}
          placeholder="Message Claude…"
          className="flex-1 min-w-0 resize-none bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        {working && (
          <button onClick={onStop} className="px-3 py-2 text-xs rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-200">Stop</button>
        )}
        <button
          onClick={send}
          disabled={!hasContent || disabled}
          className="px-3 py-2 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-medium"
        >
          Send
        </button>
      </div>
    </div>
  );
}
