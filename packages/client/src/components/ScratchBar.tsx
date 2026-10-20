import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import type { SessionState } from '@clauder/shared';
import { SCRATCH_NEW_NAME, SCRATCH_EXPIRY_DAYS, projectFolderProblem, suggestProjectFolder } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';
import { StatusDot } from './ProjectTasks';
import { projectIdOf, tasksByMain, projectActivity } from '../lib/projects';
import { scratchConversations, hasConversation, daysLeft } from '../lib/scratch';
import { formatTimeAgo } from '../lib/time';

// The Scratch bar (server/src/scratch.ts): Scratch's conversations, each a quick session of its
// own, newest first. Sits above the message box like a project's task bar. The current one can be
// kept from expiring, or made a session: right here, or handed off to a new project or a task.

const SHOWN = 6;

/** Close a popover on an outside click or Escape. */
function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, ref, close]);
}

export function ScratchBar({ session, onSwitchSession }: { session: SessionState; onSwitchSession: (id: string) => void }) {
  const { state, renameSession, destroySession, isUnread, setKeep, newScratchConversation, logEvent } = useSessions();
  const mainId = projectIdOf(session);
  const main = state.sessions.get(mainId);
  const convs = scratchConversations(mainId, state.sessions.values());
  const current = session.config.scratchConversation ? session : null;
  const [renaming, setRenaming] = useState(false);
  const [value, setValue] = useState('');
  const [panel, setPanel] = useState<'all' | 'make' | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const closePanel = useCallback(() => setPanel(null), []);
  useDismiss(panel !== null, wrapRef, closePanel);
  useEffect(() => { setPanel(null); setRenaming(false); }, [session.id]);

  // A server from before Scratch held conversations has none to show.
  if (!main || !main.config.scratchSplitAt) return null;

  const shown = convs.slice(0, SHOWN);
  if (current && !shown.some(c => c.id === current.id)) shown.push(current);
  const more = convs.length - shown.length;
  // Scheduled jobs aimed at Scratch itself (the CLAUDE.md tidy-up) run in Scratch's own chat.
  const showJobs = hasConversation(main) || main.status === 'working' || session.id === main.id;
  const left = current ? daysLeft(current) : null;

  const select = (id: string) => {
    if (id === session.id) return;
    logEvent('scratch_switch');
    onSwitchSession(id);
    setPanel(null);
  };
  const submitRename = () => {
    const name = value.trim();
    if (current && name && name !== current.config.name) renameSession(current.id, name);
    setRenaming(false);
  };
  const remove = (c: SessionState) => {
    if (hasConversation(c) && !confirm(`Delete the Scratch conversation "${c.config.name}"? This can't be undone.`)) return;
    if (c.id === session.id) {
      const next = convs.find(o => o.id !== c.id);
      if (next) onSwitchSession(next.id);
    }
    destroySession(c.id);
  };

  const chip = (c: SessionState) => {
    const active = c.id === session.id;
    if (active && renaming) {
      return (
        <input
          key={c.id}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={submitRename}
          onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenaming(false); }}
          maxLength={80}
          className="shrink-0 w-44 text-xs bg-gray-800 border border-gray-600 rounded px-1.5 py-1 text-white outline-none focus:border-blue-500"
        />
      );
    }
    return (
      <span key={c.id} className={`shrink-0 inline-flex items-center rounded-md border ${active ? 'bg-gray-800 border-gray-600' : 'border-transparent hover:bg-gray-800/60'}`}>
        <button
          onClick={() => select(c.id)}
          className={`inline-flex items-center gap-1.5 max-w-[13rem] text-xs pl-2 ${active ? 'pr-1' : 'pr-2'} py-1 min-h-[30px] ${active ? 'text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}
          title={`${c.config.name}\nStarted ${formatTimeAgo(c.createdAt)}, last used ${formatTimeAgo(c.lastActiveAt)}${c.config.keep ? '\nKept' : ''}`}
        >
          <StatusDot s={c} unread={!active && isUnread(c)} />
          {c.config.keep && <span className="text-amber-300 text-[10px]" aria-label="Kept">★</span>}
          <span className={`truncate ${hasConversation(c) ? '' : 'italic'}`}>{c.config.name}</span>
          {state.keepWarm?.sessions.includes(c.id) && <span className="text-[10px] shrink-0" title="Kept warm">🔥</span>}
        </button>
        {active && (
          <>
            <button
              onClick={() => { setRenaming(true); setValue(c.config.name); }}
              className="px-1 py-1 text-[11px] text-gray-500 hover:text-gray-200"
              title="Rename this conversation"
              aria-label="Rename"
            >✎</button>
            <button
              onClick={() => remove(c)}
              className="pl-0.5 pr-1.5 py-1 text-[11px] text-gray-500 hover:text-red-400"
              title="Delete this conversation"
              aria-label={`Delete ${c.config.name}`}
            >✕</button>
          </>
        )}
      </span>
    );
  };

  return (
    <div className="relative shrink-0 border-t border-gray-800/60 bg-gray-900/30" ref={wrapRef}>
      <div className="flex items-center">
        <div className="flex-1 min-w-0 px-3 sm:px-4 py-1 flex items-center gap-1 overflow-x-auto">
          <span className="text-[10px] uppercase tracking-wider text-amber-500/80 shrink-0 mr-1">Scratch</span>
          <button
            onClick={() => { logEvent('scratch_new'); newScratchConversation(); }}
            className="shrink-0 text-xs px-2 py-1 min-h-[30px] rounded-md text-blue-300 hover:text-blue-200 hover:bg-gray-800/60"
            title="Start a new Scratch conversation"
          >
            + New
          </button>
          {shown.map(chip)}
          {more > 0 && (
            <button
              onClick={() => setPanel(panel === 'all' ? null : 'all')}
              className="shrink-0 text-xs px-2 py-1 min-h-[30px] rounded-md text-gray-400 hover:text-gray-200 hover:bg-gray-800/60"
              title="All Scratch conversations"
            >
              {more} more ▾
            </button>
          )}
          {showJobs && (
            <button
              onClick={() => select(main.id)}
              className={`shrink-0 inline-flex items-center gap-1.5 text-xs px-2 py-1 min-h-[30px] rounded-md border ${main.id === session.id ? 'bg-gray-800 border-gray-600 text-gray-100' : 'border-transparent text-gray-500 hover:text-gray-300 hover:bg-gray-800/60'}`}
              title="Scheduled jobs aimed at Scratch (like the weekly CLAUDE.md tidy-up) run here"
            >
              <StatusDot s={main} unread={main.id !== session.id && isUnread(main)} />
              ⏰ Jobs
            </button>
          )}
        </div>
        {current && hasConversation(current) && (
          <div className="shrink-0 flex items-center gap-1 pr-2 sm:pr-4 pl-1">
            {left !== null && left <= 7 && (
              <span className="hidden sm:inline text-[11px] text-amber-400/80 whitespace-nowrap" title={`Unkept conversations are deleted after ${SCRATCH_EXPIRY_DAYS} days untouched`}>
                {left === 0 ? 'Expires today' : `${left} day${left === 1 ? '' : 's'} left`}
              </span>
            )}
            <button
              onClick={() => setKeep(current.id, !current.config.keep)}
              className={`text-xs px-2 py-1 min-h-[30px] rounded-md hover:bg-gray-800/60 whitespace-nowrap ${current.config.keep ? 'text-amber-300' : 'text-gray-400 hover:text-gray-200'}`}
              title={current.config.keep
                ? `Kept: it won't expire. Click to let it go after ${SCRATCH_EXPIRY_DAYS} days untouched.`
                : `Deleted after ${SCRATCH_EXPIRY_DAYS} days untouched (${left} day${left === 1 ? '' : 's'} from now). Click to keep it.`}
            >
              {current.config.keep ? '★ Kept' : '☆ Keep'}
            </button>
            <button
              onClick={() => setPanel(panel === 'make' ? null : 'make')}
              className="text-xs px-2 py-1 min-h-[30px] rounded-md text-blue-300 hover:text-blue-200 hover:bg-gray-800/60 whitespace-nowrap"
              title="Make this conversation a session of its own: here, in a new project folder, or as a task of a project"
            >
              <span className="hidden sm:inline">Make it a session…</span>
              <span className="sm:hidden">Session…</span>
            </button>
          </div>
        )}
      </div>

      {panel === 'all' && (
        <div className="absolute bottom-full left-2 sm:left-4 mb-1 z-50 w-[min(360px,calc(100vw-1rem))] max-h-[50vh] overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1">
          {convs.map(c => {
            const d = daysLeft(c);
            return (
              <button
                key={c.id}
                onClick={() => select(c.id)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-gray-800 ${c.id === session.id ? 'text-gray-100' : 'text-gray-300'}`}
              >
                <StatusDot s={c} unread={c.id !== session.id && isUnread(c)} />
                <span className={`flex-1 truncate ${hasConversation(c) ? '' : 'italic text-gray-500'}`}>{c.config.name}</span>
                <span className="shrink-0 text-[10px] text-gray-500">
                  {c.config.keep ? <span className="text-amber-300">★ kept</span> : d !== null && d <= 7 ? <span className="text-amber-400/80">{d}d left</span> : formatTimeAgo(c.lastActiveAt)}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {panel === 'make' && current && (
        <MakeSessionPanel conversation={current} onDone={closePanel} />
      )}
    </div>
  );
}

/** GET /api/projects, as the new-session form uses it. */
interface DevRoot { root: string; display: string; folders: string[] }

type Mode = 'here' | 'project' | 'task';

/** "Make it a session…": keep it here as a session, or have Claude write a handoff that starts a
 *  session in a new project folder or a task in a project. */
function MakeSessionPanel({ conversation, onDone }: { conversation: SessionState; onDone: () => void }) {
  const { state, promoteScratch, scratchHandoff, logEvent } = useSessions();
  const [mode, setMode] = useState<Mode>('here');
  const [name, setName] = useState(conversation.config.name === SCRATCH_NEW_NAME ? '' : conversation.config.name);
  // null = follow the name; a string once the folder name is edited by hand.
  const [folder, setFolder] = useState<string | null>(null);
  const [projectId, setProjectId] = useState('');
  const [devRoot, setDevRoot] = useState<DevRoot | 'loading' | 'unavailable'>('loading');

  useEffect(() => {
    let live = true;
    fetch('/api/projects')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: DevRoot) => { if (live) setDevRoot(d); })
      .catch(() => { if (live) setDevRoot('unavailable'); });
    return () => { live = false; };
  }, []);

  // Projects to add a task to: main and standalone sessions, most recently active first.
  const projects = useMemo(() => {
    const all = [...state.sessions.values()];
    const tasks = tasksByMain(all);
    return all
      .filter(s => !s.config.mainSessionId && !s.config.isScratch)
      .map(s => ({ s, at: projectActivity(s, tasks.get(s.id) ?? []).lastActiveAt }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .map(x => x.s);
  }, [state.sessions]);

  const folderName = (folder ?? suggestProjectFolder(name)).trim();
  const folderProblem = projectFolderProblem(folderName);
  const root = typeof devRoot === 'object' ? devRoot : null;
  const existing = root?.folders.find(f => f.toLowerCase() === folderName.toLowerCase());
  const canSubmit = mode === 'here' ? true : mode === 'project' ? !!root && !folderProblem : !!projectId;

  const submit = () => {
    if (!canSubmit) return;
    logEvent('scratch_make_session', { mode });
    if (mode === 'here') promoteScratch(conversation.id, name.trim());
    else if (mode === 'project') scratchHandoff(conversation.id, name.trim(), { kind: 'new_project', folder: existing ?? folderName });
    else scratchHandoff(conversation.id, name.trim(), { kind: 'task', projectId });
    onDone();
  };

  const option = (m: Mode, title: string, detail: string) => (
    <label className={`flex gap-2 rounded-md px-2 py-1.5 cursor-pointer ${mode === m ? 'bg-gray-800' : 'hover:bg-gray-800/60'}`}>
      <input type="radio" name="make-session" checked={mode === m} onChange={() => setMode(m)} className="mt-0.5 accent-blue-500" />
      <span className="min-w-0">
        <span className="block text-xs text-gray-100">{title}</span>
        <span className="block text-[11px] text-gray-500 leading-snug">{detail}</span>
      </span>
    </label>
  );

  const inputClass = 'w-full text-sm text-gray-100 bg-gray-800 border border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:border-blue-500';
  const display = root?.display ?? '~/development';

  return (
    <div className="absolute bottom-full right-2 sm:right-4 mb-1 z-50 w-[min(400px,calc(100vw-1rem))] bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-3 space-y-2.5">
      <div className="space-y-1">
        {option('here', 'Keep it here as a session', 'Becomes a session of its own with this conversation and all its history, in the scratch folder. It never expires.')}
        {option('project', 'Start a new project folder', `Claude writes a handoff note, and a new session starts from it in a folder in ${display}. This conversation stays in Scratch.`)}
        {option('task', 'Add it as a task to a project', "Claude writes a handoff note, and a task starts from it in that project's folder. This conversation stays in Scratch.")}
      </div>

      {mode === 'task' && (
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className={inputClass}
        >
          <option value="">Choose a project…</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.config.name}</option>)}
        </select>
      )}

      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder={mode === 'here' ? 'Session name' : mode === 'task' ? 'Task name (optional: Claude names it)' : 'Session name (optional: Claude names it)'}
        maxLength={80}
        className={inputClass}
      />

      {mode === 'project' && (
        <div className="space-y-1">
          <div className="flex items-center gap-1 text-xs text-gray-500">
            <span className="shrink-0">{display}/</span>
            <input
              value={folder ?? suggestProjectFolder(name)}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="FolderName"
              className={inputClass}
            />
          </div>
          <div className={`text-[11px] ${devRoot === 'unavailable' || (folderName && folderProblem) ? 'text-amber-400' : 'text-gray-500'}`}>
            {devRoot === 'loading' ? 'Checking the dev folder…'
              : devRoot === 'unavailable' ? 'New-project folders turn on after Clauder restarts.'
              : !folderName ? `Creates a new folder in ${display}.`
              : folderProblem ? folderProblem
              : existing ? `${display}/${existing} already exists: the new session works in it.`
              : `Creates ${display}/${folderName}.`}
          </div>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={onDone} className="px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded"
        >
          {mode === 'here' ? 'Make it a session' : 'Write the handoff'}
        </button>
      </div>
    </div>
  );
}
