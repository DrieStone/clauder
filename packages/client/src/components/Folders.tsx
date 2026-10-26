import { useState, useRef, useEffect, useCallback, useMemo, type DragEvent, type ReactNode } from 'react';
import type { SessionState, SessionFolder } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';
import { usePopoverPlacement } from '../lib/popoverPosition';
import { formatTimeAgo } from '../lib/time';

// Dashboard folders: named groups of sessions that tidy the dashboard (server/src/folders.ts).
// A folder never touches a session's files or settings, and a session is in at most one.

/** dataTransfer type for a session card dragged onto a folder (desktop only). */
export const SESSION_DRAG_TYPE = 'application/x-clauder-session';

const VIEW_KEY = 'clauder.dashboard.view';

/** What the dashboard lists: sessions in no folder ('loose', the default), every session ('all'),
 *  or one folder's (its id). Kept per device; a folder that's gone falls back to 'loose'. */
export function useDashboardView(folders: SessionFolder[]): [string, (view: string) => void] {
  const [view, setView] = useState<string>(() => {
    try { return localStorage.getItem(VIEW_KEY) || 'loose'; } catch { return 'loose'; }
  });
  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* storage unavailable */ }
  }, [view]);
  const known = view === 'loose' || view === 'all' || folders.some(f => f.id === view);
  return [known ? view : 'loose', setView];
}

export const byFolderName = (a: SessionFolder, b: SessionFolder) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

const shortPath = (p: string) => p.replace(/^\/Users\/[^/]+/, '~');

const PencilIcon = () => (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
  </svg>
);

// ─── The folder bar on the dashboard ────────────────────────────────────────────

export interface FolderBarItem {
  /** 'loose', 'all', or a folder id. */
  view: string;
  label: string;
  icon: string;
  count: number;
  needs: number;
  working: number;
  unread: number;
  /** Where a card dropped here goes: a folder id, null (out of its folder), or undefined (no drop). */
  dropTo?: string | null;
  folder?: SessionFolder;
}

/** One row of tiles that picks what the dashboard lists: "No folder", each folder, and "All". Each
 *  tile counts its sessions and shows how many need you, are working, or are unread, so a folder
 *  never has to be opened to see that. A card dragged onto a tile moves into that folder ("No
 *  folder" takes it out). The open folder's tile has a pencil to rename it or change its sessions. */
export function FolderBar({ items, view, onSelect, onEdit, draggingId, draggingFrom, onDropSession }: {
  items: FolderBarItem[];
  view: string;
  onSelect: (view: string) => void;
  onEdit: (folder: SessionFolder) => void;
  draggingId: string | null;
  /** The folder the dragged card is in (null: none). */
  draggingFrom: string | null;
  onDropSession: (folderId: string | null) => void;
}) {
  const [dropHover, setDropHover] = useState<string | null>(null);
  useEffect(() => { if (!draggingId) setDropHover(null); }, [draggingId]);
  return (
    <div className="flex gap-2 overflow-x-auto -mx-3 px-3 pb-1 sm:mx-0 sm:px-0 sm:pb-0 sm:flex-wrap sm:overflow-visible" role="tablist" aria-label="Show sessions">
      {items.map(item => {
        const selected = item.view === view;
        const canDrop = !!draggingId && item.dropTo !== undefined && item.dropTo !== draggingFrom;
        return (
          <div
            key={item.view}
            role="tab"
            aria-selected={selected}
            tabIndex={0}
            onClick={() => onSelect(item.view)}
            onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onSelect(item.view); } }}
            onDragOver={(e: DragEvent) => { if (!canDrop) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropHover(item.view); }}
            onDragLeave={(e: DragEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropHover(null); }}
            onDrop={(e: DragEvent) => { if (!canDrop) return; e.preventDefault(); setDropHover(null); onDropSession(item.dropTo ?? null); }}
            className={`group inline-flex items-center gap-1.5 shrink-0 sm:shrink sm:min-w-0 max-w-full px-3 py-1.5 rounded-lg border text-sm cursor-pointer select-none transition-colors ${
              dropHover === item.view ? 'border-blue-500 bg-blue-950/30'
              : canDrop ? 'border-dashed border-gray-500'
              : selected ? 'border-gray-500 bg-gray-800 text-white'
              : item.needs ? 'border-amber-700/50 bg-gray-900/40 text-gray-300 hover:border-gray-600'
              : 'border-gray-800 bg-gray-900/40 text-gray-400 hover:border-gray-600 hover:text-gray-200'}`}
            title={[`${item.count} session${item.count !== 1 ? 's' : ''}`,
              item.needs ? `${item.needs} need${item.needs === 1 ? 's' : ''} you` : '',
              item.working ? `${item.working} working` : '',
              item.unread ? `${item.unread} unread` : ''].filter(Boolean).join(' · ')}
          >
            <span aria-hidden className="shrink-0">{item.icon}</span>
            <span className="truncate">{item.label}</span>
            <span className="text-xs text-gray-500 shrink-0">{item.count}</span>
            {item.needs > 0 && <span className="shrink-0 text-[10px] leading-3 px-1 py-0.5 rounded bg-amber-500/20 text-amber-300">{item.needs}</span>}
            {item.working > 0 && <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />}
            {item.unread > 0 && <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-red-500" />}
            {selected && item.folder && (
              <button
                onClick={(e) => { e.stopPropagation(); onEdit(item.folder!); }}
                className="ml-0.5 p-1 -m-1 text-gray-500 hover:text-gray-200"
                title="Rename this folder or change its sessions"
                aria-label={`Edit folder ${item.label}`}
              >
                <PencilIcon />
              </button>
            )}
          </div>
        );
      })}
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
