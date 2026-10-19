import { useState, useRef, useEffect, useCallback, useMemo, type DragEvent, type ReactNode } from 'react';
import type { SessionState, SessionFolder } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';
import { usePopoverPlacement } from '../lib/popoverPosition';
import { formatTimeAgo } from '../lib/time';

// Dashboard folders: named groups of sessions that tidy the dashboard (server/src/folders.ts).
// A folder never touches a session's files or settings, and a session is in at most one.

/** dataTransfer type for a session card dragged onto a folder (desktop only). */
export const SESSION_DRAG_TYPE = 'application/x-clauder-session';

const OPEN_KEY = 'clauder.dashboard.openFolders';

/** Which folders are open on the dashboard. Kept per device, since a phone and a desktop want
 *  different things open. Folders start closed: tidying up is the point. */
export function useOpenFolders(): [Set<string>, (id: string) => void] {
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      const ids = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]');
      return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...open])); } catch { /* storage unavailable */ }
  }, [open]);
  const toggle = useCallback((id: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);
  return [open, toggle];
}

export const byFolderName = (a: SessionFolder, b: SessionFolder) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

const PencilIcon = () => (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
  </svg>
);

// ─── A folder on the dashboard ──────────────────────────────────────────────────

type Attention = 'needs' | 'working' | 'unread';
const ATTENTION: Record<Attention, { label: string; chip: string; dot: string }> = {
  needs: { label: 'Needs you', chip: 'border-amber-500/40 bg-amber-500/10 text-amber-300', dot: 'bg-amber-400 animate-pulse' },
  working: { label: 'Working', chip: 'border-amber-700/40 text-amber-200/90', dot: 'bg-amber-500 animate-pulse' },
  unread: { label: 'Unread', chip: 'border-blue-700/50 text-blue-200', dot: 'bg-red-500' },
};
const ATTENTION_ORDER: Attention[] = ['needs', 'working', 'unread'];
const MAX_CHIPS = 3;

/** One folder: a header that opens and closes it, and, open, its sessions drawn like the main list
 *  (`recent` as cards, `older` as rows, both via the dashboard's `renderCard`). Closed, the header
 *  still names any session that needs you, is working, or has unread messages, one click from
 *  opening it. A session card dragged onto the folder moves into it. */
export function FolderGroup({ folder, recent, older, open, onToggle, onEdit, onOpenSession, isUnread, renderCard, activityOf, draggingId, onDropSession }: {
  folder: SessionFolder;
  recent: SessionState[];
  older: SessionState[];
  open: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onOpenSession: (sessionId: string) => void;
  isUnread: (session: SessionState) => boolean;
  renderCard: (session: SessionState, tier: 'warm' | 'history') => ReactNode;
  /** A card's state as a whole, for a project with tasks: working or needing you if any of its
   *  sessions is, unread if any is. Defaults to the session's own. */
  activityOf?: (session: SessionState) => { status: string; waitingFor: string | null; lastActiveAt: string; unread: boolean };
  /** The session card being dragged, if any. */
  draggingId: string | null;
  onDropSession: (folderId: string) => void;
}) {
  const [dropHover, setDropHover] = useState(false);
  const canDrop = !!draggingId && !folder.sessionIds.includes(draggingId);
  useEffect(() => { if (!draggingId) setDropHover(false); }, [draggingId]);

  const sessions = [...recent, ...older];
  const stateOf = activityOf ?? ((s: SessionState) => ({ status: s.status, waitingFor: s.waitingFor, lastActiveAt: s.lastActiveAt, unread: isUnread(s) }));
  const attention = sessions
    .map(s => { const a = stateOf(s); return { s, kind: (a.waitingFor ? 'needs' : a.status === 'working' ? 'working' : a.unread ? 'unread' : null) as Attention | null }; })
    .filter((a): a is { s: SessionState; kind: Attention } => a.kind !== null)
    .sort((a, b) => ATTENTION_ORDER.indexOf(a.kind) - ATTENTION_ORDER.indexOf(b.kind));
  const lastActive = sessions.reduce<string | null>((latest, s) => {
    const at = stateOf(s).lastActiveAt;
    return !latest || Date.parse(at) > Date.parse(latest) ? at : latest;
  }, null);

  const onDragOver = (e: DragEvent) => {
    if (!canDrop) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropHover(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropHover(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!canDrop) return;
    e.preventDefault();
    setDropHover(false);
    onDropSession(folder.id);
  };

  const border = dropHover ? 'border-blue-500 bg-blue-950/20'
    : canDrop ? 'border-dashed border-gray-600 bg-gray-900/40'
    : attention.some(a => a.kind === 'needs') && !open ? 'border-amber-700/50 bg-gray-900/40'
    : 'border-gray-800 bg-gray-900/40';

  return (
    <div onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} className={`rounded-xl border transition-colors ${border}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onToggle(); } }}
        className="group flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5 cursor-pointer select-none"
      >
        <svg className={`w-3 h-3 shrink-0 text-gray-500 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-sm leading-none shrink-0" aria-hidden>📁</span>
        <h3 className="text-sm font-medium text-gray-200 group-hover:text-white truncate min-w-0 max-w-[60%]">{folder.name}</h3>
        <span className="text-xs text-gray-500 shrink-0" title={`${sessions.length} session${sessions.length !== 1 ? 's' : ''}`}>{sessions.length}</span>
        {!open && attention.slice(0, MAX_CHIPS).map(({ s, kind }) => (
          <button
            key={s.id}
            onClick={(e) => { e.stopPropagation(); onOpenSession(s.id); }}
            className={`inline-flex items-center gap-1 min-w-0 max-w-[12rem] text-[11px] leading-4 px-1.5 py-0.5 rounded border hover:brightness-125 ${ATTENTION[kind].chip}`}
            title={`${ATTENTION[kind].label}: ${s.config.name}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${ATTENTION[kind].dot}`} />
            <span className="truncate">{s.config.name}</span>
          </button>
        ))}
        {!open && attention.length > MAX_CHIPS && (
          <span className="text-[11px] text-gray-500 shrink-0">+{attention.length - MAX_CHIPS} more</span>
        )}
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {lastActive && <span className="text-xs text-gray-600">{formatTimeAgo(lastActive)}</span>}
          <button
            onClick={(e) => { e.stopPropagation(); onEdit(); }}
            className="p-1 -m-1 text-gray-600 hover:text-gray-300 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus:opacity-100 transition-opacity"
            title="Rename this folder or change its sessions"
            aria-label={`Edit folder ${folder.name}`}
          >
            <PencilIcon />
          </button>
        </span>
      </div>

      {open && (
        <div className="px-3 pb-3 space-y-3">
          {sessions.length === 0 ? (
            <div className="text-xs text-gray-600 px-1 pb-1">
              Nothing in here yet.{' '}
              <button onClick={onEdit} className="text-blue-400 hover:text-blue-300">Add sessions</button>
            </div>
          ) : (
            <>
              {recent.length > 0 && <div className="grid grid-cols-1 active-grid gap-3">{recent.map(s => renderCard(s, 'warm'))}</div>}
              {older.length > 0 && <div className="grid grid-cols-1 history-grid gap-2">{older.map(s => renderCard(s, 'history'))}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── New / edit folder dialog ───────────────────────────────────────────────────

/** Create a folder (`folder` null), or rename one and change which sessions it holds. Sessions are
 *  picked from the whole list; picking one that's in another folder moves it here. */
export function FolderEditor({ folder, onClose }: { folder: SessionFolder | null; onClose: () => void }) {
  const { state, createFolder, updateFolder, deleteFolder } = useSessions();
  const [name, setName] = useState(folder?.name ?? '');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(folder?.sessionIds ?? []));
  const [query, setQuery] = useState('');

  // The dashboard passes a fresh onClose on every render; listen once.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const folderOf = useMemo(() => {
    const m = new Map<string, SessionFolder>();
    for (const f of state.folders) for (const id of f.sessionIds) m.set(id, f);
    return m;
  }, [state.folders]);

  const q = query.trim().toLowerCase();
  // Folders hold projects: a task goes wherever its main session does.
  const sessions = [...state.sessions.values()]
    .filter(s => !s.config.isScratch && !s.config.mainSessionId)
    .filter(s => !q || s.config.name.toLowerCase().includes(q) || s.config.cwd.toLowerCase().includes(q))
    .sort((a, b) => a.config.name.localeCompare(b.config.name, undefined, { numeric: true, sensitivity: 'base' }));

  const toggle = (id: string) => setPicked(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const trimmed = name.trim();
  const save = () => {
    if (!trimmed) return;
    const ids = [...picked].filter(id => state.sessions.has(id));
    if (folder) updateFolder(folder.id, { name: trimmed, sessionIds: ids });
    else createFolder(trimmed, ids);
    onClose();
  };
  const remove = () => {
    if (!folder) return;
    if (!confirm(`Delete the folder "${folder.name}"? The sessions in it aren't touched. They go back to the main list.`)) return;
    deleteFolder(folder.id);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold">📁 {folder ? 'Edit folder' : 'New folder'}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200 text-xl leading-none w-7 h-7 flex items-center justify-center hover:bg-gray-800 rounded" aria-label="Close">×</button>
        </div>
        <div className="p-4 space-y-3 flex flex-col min-h-0">
          <input
            autoFocus={!folder}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
            placeholder="Folder name, e.g. Fusion & Circuit Boards"
            maxLength={60}
            className="w-full shrink-0 text-sm text-gray-100 bg-gray-800/60 border border-gray-700 rounded px-2 py-1.5 placeholder-gray-600 focus:outline-none focus:border-blue-500"
          />
          <div className="flex items-center justify-between gap-2 shrink-0">
            <div className="text-[10px] uppercase tracking-wider text-gray-500">
              Sessions{picked.size > 0 ? ` · ${picked.size} in this folder` : ''}
            </div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name or path…"
              className="w-44 min-w-0 text-xs text-gray-200 bg-gray-800/60 border border-gray-700 rounded px-2 py-1 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="max-h-96 min-h-0 overflow-y-auto border border-gray-800 rounded-lg divide-y divide-gray-800/60">
            {sessions.map(s => {
              const other = folderOf.get(s.id);
              const elsewhere = other && other.id !== folder?.id ? other : null;
              return (
                <label key={s.id} className="flex items-center gap-2 px-2.5 py-2 sm:py-1.5 hover:bg-gray-800/50 cursor-pointer">
                  <input type="checkbox" checked={picked.has(s.id)} onChange={() => toggle(s.id)} className="shrink-0 accent-blue-500" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-gray-200 truncate">{s.config.name}</span>
                    <span className="block text-[11px] text-gray-600 truncate">{shortPath(s.config.cwd)}</span>
                  </span>
                  {elsewhere && (
                    <span
                      className={`shrink-0 max-w-[9rem] truncate text-[10px] border rounded px-1 py-px ${picked.has(s.id) ? 'text-amber-300/90 border-amber-700/50' : 'text-gray-500 border-gray-700'}`}
                      title={picked.has(s.id) ? `Moves here from "${elsewhere.name}"` : `In "${elsewhere.name}"`}
                    >
                      {picked.has(s.id) ? 'from ' : ''}📁 {elsewhere.name}
                    </span>
                  )}
                </label>
              );
            })}
            {sessions.length === 0 && <div className="text-xs text-gray-600 px-2.5 py-3">No sessions match.</div>}
          </div>
        </div>
        <div className="px-4 py-3 border-t border-gray-800 flex items-center gap-2 shrink-0">
          {folder && <button onClick={remove} className="text-xs text-red-300 hover:text-red-200">Delete folder</button>}
          <span className="flex-1" />
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
          <button onClick={save} disabled={!trimmed} className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white">
            {folder ? 'Save' : 'Create folder'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Session header picker ──────────────────────────────────────────────────────

function FolderOption({ label, hint, checked, onPick }: { label: string; hint?: string; checked: boolean; onPick: () => void }) {
  return (
    <button
      onClick={onPick}
      className={`flex items-center gap-2 px-1.5 py-1.5 sm:py-1 rounded text-left hover:bg-gray-800/60 ${checked ? 'text-blue-300' : 'text-gray-300'}`}
    >
      <span className={`w-3 h-3 rounded-full border shrink-0 flex items-center justify-center ${checked ? 'border-blue-400' : 'border-gray-600'}`}>
        {checked && <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />}
      </span>
      <span className="truncate min-w-0">{label}</span>
      {hint && <span className="text-gray-600 shrink-0">{hint}</span>}
    </button>
  );
}

/** The session header's folder picker: shows which dashboard folder the session is in, and moves
 *  it to another, out of any, or into a new one. */
export function FolderControl({ session }: { session: SessionState }) {
  const { state, moveToFolder, createFolder } = useSessions();
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const placement = usePopoverPlacement(wrapRef, open, 240);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // Scratch always shows on its own.
  if (session.config.isScratch) return null;

  const current = state.folders.find(f => f.sessionIds.includes(session.id)) ?? null;
  const pick = (folderId: string | null) => {
    if (folderId !== (current?.id ?? null)) moveToFolder(session.id, folderId);
    setOpen(false);
  };
  const add = () => {
    const name = newName.trim();
    if (!name) return;
    createFolder(name, [session.id]);
    setNewName('');
    setOpen(false);
  };

  return (
    <div className="relative shrink-0" ref={wrapRef}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`max-w-[11rem] truncate text-[10px] border rounded px-1.5 py-1 sm:py-0.5 transition-colors ${current ? 'text-blue-300 border-blue-500/50' : 'text-gray-500 hover:text-blue-300 border-gray-700 hover:border-blue-500/50'}`}
        title={current ? `In the dashboard folder "${current.name}"` : 'Put this session in a dashboard folder'}
      >
        📁 {current ? current.name : 'Folder'}
      </button>

      {open && (
        <div className="absolute z-50 mt-1 right-0 w-60 bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-2 text-xs" style={placement ?? undefined}>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 px-1 pb-1.5">Dashboard folder</div>
          <div className="max-h-56 overflow-y-auto flex flex-col gap-0.5">
            <FolderOption label="None" hint="main list" checked={!current} onPick={() => pick(null)} />
            {[...state.folders].sort(byFolderName).map(f => (
              <FolderOption key={f.id} label={f.name} checked={current?.id === f.id} onPick={() => pick(f.id)} />
            ))}
          </div>
          <div className="border-t border-gray-800 mt-2 pt-2 flex items-center gap-1.5">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
              placeholder="New folder…"
              maxLength={60}
              className="flex-1 min-w-0 bg-gray-800 border border-gray-600 rounded px-1.5 py-1 text-white outline-none focus:border-blue-500"
            />
            <button
              onClick={add}
              disabled={!newName.trim()}
              className="px-2 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
