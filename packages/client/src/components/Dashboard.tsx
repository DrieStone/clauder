import { useState, useEffect, useRef, useCallback, type DragEvent } from 'react';
import type { SessionState, SessionFolder } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';
import { warmLabel } from './KeepWarm';
import { SessionCard, type CardTier } from './SessionCard';
import { SessionConfigForm } from './SessionConfig';
import { SessionBrowser } from './SessionBrowser';
import { PauseControls } from './PauseBar';
import { SchedulerModal } from './SchedulerModal';
import { NotificationToggle } from './NotificationToggle';
import { TagFilter } from './Tags';
import { FolderBar, FolderEditor, useDashboardView, byFolderName, SESSION_DRAG_TYPE, type FolderBarItem } from './Folders';
import { whereItStands, isCurrent } from './StatusNote';
import { tasksByMain, projectActivity } from '../lib/projects';
import { formatTimeAgo } from '../lib/time';
import { sessionToOpen } from '../lib/lastOpen';

/** Card dragging (into and out of folders) needs a mouse; on a phone, folders are set from the
 *  session header or the folder dialog instead. */
const CAN_DRAG = typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

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

/** The hover list on a card's task count: most recently active first, one line each. */
function taskListText(tasks: SessionState[] | undefined): string | undefined {
  if (!tasks?.length) return undefined;
  return [...tasks]
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    .map(t => t.waitingFor ? `⚠️ ${t.config.name} · needs you`
      : t.status === 'working' ? `🟡 ${t.config.name} · working`
      : `○ ${t.config.name} · ${formatTimeAgo(t.lastActiveAt)}`)
    .join('\n');
}

export function Dashboard() {
  const { state, createSession, setActiveSession, setShowDiscovery, logEvent, openSearch, isUnread, moveToFolder, openScratch } = useSessions();
  const [showNewSession, setShowNewSession] = useState(false);
  const [showScheduler, setShowScheduler] = useState(false);
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [view, setView] = useDashboardView(state.folders);
  const [folderEditor, setFolderEditor] = useState<SessionFolder | 'new' | null>(null);
  /** The session card being dragged (onto a folder tile). */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragStartTimer = useRef<number | null>(null);
  const [, setTick] = useState(0);
  // Opening a project returns to the task last open in it (lib/lastOpen.ts). Stable, through a ref
  // to the sessions, so the cards' memo holds.
  const sessionsRef = useRef(state.sessions);
  sessionsRef.current = state.sessions;
  const openProject = useCallback((id: string) => setActiveSession(sessionToOpen(id, sessionsRef.current)), [setActiveSession]);

  // Re-render every 30s so tier classification and "X ago" labels stay fresh
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  // Scratch session is treated as a normal session card in the Active tier;
  // its visual distinction (amber border + badge) is handled in SessionCard.
  // One card per project (server/src/project.ts): a project's tasks show only on its main
  // session's card, which is placed by the project as a whole — working or needing you if any of
  // its sessions is, and as recent as the most recent.
  const all = Array.from(state.sessions.values());
  const taskMap = tasksByMain(all);
  const sessions = all.filter(s => !s.config.mainSessionId);
  const now = Date.now();
  const activity = new Map(sessions.map(s => [s.id, projectActivity(s, taskMap.get(s.id) ?? [])]));
  const act = (s: SessionState) => activity.get(s.id) ?? s;

  const byRecent = (a: typeof sessions[0], b: typeof sessions[0]) =>
    new Date(act(b).lastActiveAt).getTime() - new Date(act(a).lastActiveAt).getTime();

  const byName = (a: typeof sessions[0], b: typeof sessions[0]) =>
    a.config.name.localeCompare(b.config.name);

  // Active sessions: "needs you" sessions float to the top (waitingFor set), then alphabetical.
  // Scratch is always shown in Active regardless of its lastActiveAt age.
  const byNeedsYouThenName = (a: typeof sessions[0], b: typeof sessions[0]) => {
    const aNeeds = act(a).waitingFor ? 0 : 1;
    const bNeeds = act(b).waitingFor ? 0 : 1;
    if (aNeeds !== bNeeds) return aNeeds - bNeeds;
    return a.config.name.localeCompare(b.config.name);
  };
  // Tag filter (OR semantics): when any tag is selected, only sessions carrying at least one of
  // them are shown — applied uniformly, so even Scratch is hidden while a filter is active.
  const matchesTags = (s: typeof sessions[0]) =>
    tagFilter.size === 0 || (s.config.tags ?? []).some(t => tagFilter.has(t));
  const visible = sessions.filter(matchesTags);

  // The folder bar picks what's listed: sessions in no folder (the default), one folder's, or all.
  // A session is in at most one folder.
  const folderOf = new Map<string, string>();
  for (const f of state.folders) for (const id of f.sessionIds) if (!folderOf.has(id)) folderOf.set(id, f.id);
  const loose = visible.filter(s => !folderOf.has(s.id));
  const shown = view === 'all' ? visible : view === 'loose' ? loose : visible.filter(s => folderOf.get(s.id) === view);

  const hotSessions = shown.filter(s => s.config.isScratch || classifySession(act(s), now) === 'hot' || !!act(s).waitingFor).sort(byNeedsYouThenName);
  const warmSessions = shown.filter(s => !s.config.isScratch && !act(s).waitingFor && classifySession(act(s), now) === 'warm').sort(byRecent);
  const historySessions = shown.filter(s => !s.config.isScratch && !act(s).waitingFor && classifySession(act(s), now) === 'history').sort(byRecent);

  // Each tile counts what needs you, is working, or is unread, a project's tasks included.
  const tally = (list: SessionState[]) => {
    let needs = 0, working = 0, unread = 0;
    for (const s of list) {
      const a = act(s);
      if (a.waitingFor) needs++;
      else if (a.status === 'working') working++;
      else if ([s, ...(taskMap.get(s.id) ?? [])].some(isUnread)) unread++;
    }
    return { count: list.length, needs, working, unread };
  };
  const folderItems: FolderBarItem[] = state.folders.length === 0 ? [] : [
    { view: 'loose', label: 'No folder', icon: '🏠', dropTo: null, ...tally(loose) },
    ...[...state.folders].sort(byFolderName).map(folder => ({
      view: folder.id, label: folder.name, icon: '📁', dropTo: folder.id, folder,
      ...tally(visible.filter(s => folderOf.get(s.id) === folder.id)),
    })),
    { view: 'all', label: 'All', icon: '🗂', ...tally(visible) },
  ];
  const viewFolder = state.folders.find(f => f.id === view);

  // Drag a card onto a folder tile to move it in, or onto "No folder" to take it out.
  const endDrag = () => {
    if (dragStartTimer.current !== null) { clearTimeout(dragStartTimer.current); dragStartTimer.current = null; }
    setDraggingId(null);
  };
  // A dormant project's ⓘ previews where it stands, from its status note.
  const noteFor = (s: SessionState) => {
    const r = state.statusReports.get(s.id);
    return r && isCurrent(r, s.lastActiveAt) ? whereItStands(r.text) || undefined : undefined;
  };
  const renderCard = (session: SessionState, tier: CardTier) => (
    <div
      key={session.id}
      className="grid grid-cols-1 min-w-0"
      draggable={CAN_DRAG}
      onDragStart={CAN_DRAG ? (e) => {
        e.dataTransfer.setData(SESSION_DRAG_TYPE, session.id);
        e.dataTransfer.effectAllowed = 'move';
        // Re-render after the drag has begun: Chrome can drop a drag whose page changes during dragstart.
        dragStartTimer.current = window.setTimeout(() => { dragStartTimer.current = null; setDraggingId(session.id); }, 0);
      } : undefined}
      onDragEnd={CAN_DRAG ? endDrag : undefined}
    >
      <SessionCard
        session={session}
        tier={tier}
        unread={isUnread(session)}
        onOpen={session.config.isScratch ? openScratch : openProject}
        statusNote={noteFor(session)}
        warm={state.keepWarm?.projects[session.id] ? warmLabel(state.keepWarm.projects[session.id].until, state.keepWarm.projects[session.id].mode) : undefined}
        tasks={taskMap.get(session.id)?.length}
        tasksWorking={taskMap.get(session.id)?.filter(t => t.status === 'working').length}
        tasksNeedYou={taskMap.get(session.id)?.filter(t => !!t.waitingFor).length}
        taskList={taskListText(taskMap.get(session.id))}
      />
    </div>
  );
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

        {/* Tag filter bar (renders nothing when no tags exist), and New folder */}
        <div className="mb-4 -mt-2 flex items-start gap-2">
          <div className="flex-1 min-w-0">
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
          {sessions.length > 0 && (
            <button
              onClick={() => { logEvent('folder_editor_open', { isNew: true }); setFolderEditor('new'); }}
              className="shrink-0 text-[11px] text-gray-500 hover:text-gray-300 border border-gray-800 hover:border-gray-600 rounded px-2 py-1 sm:py-0.5 transition-colors"
              title="Group sessions into a folder on this page"
            >
              📁 New folder
            </button>
          )}
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
            {/* Folder bar: what's listed below */}
            {folderItems.length > 0 && (
              <section className="space-y-2">
                <FolderBar
                  items={folderItems}
                  view={view}
                  onSelect={setView}
                  onEdit={(f) => { logEvent('folder_editor_open', { isNew: false }); setFolderEditor(f); }}
                  draggingId={draggingId}
                  draggingFrom={draggingId ? folderOf.get(draggingId) ?? null : null}
                  onDropSession={(folderId) => { if (draggingId) moveToFolder(draggingId, folderId); endDrag(); }}
                />
                {draggingId && <p className="text-xs text-blue-400">Drop on a folder to move it there, or on “No folder” to take it out</p>}
              </section>
            )}

            <div className="space-y-8">
              {viewFolder && shown.length === 0 && (
                <div className="text-sm text-gray-500">
                  Nothing in {viewFolder.name} yet.{' '}
                  <button onClick={() => setFolderEditor(viewFolder)} className="text-blue-400 hover:text-blue-300">Add sessions</button>
                </div>
              )}
              {/* Active: compact cards sorted alphabetically */}
              {hotSessions.length > 0 && (
                <section>
                  <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                    Active
                  </h2>
                  <div className="grid grid-cols-1 active-grid gap-3">
                    {hotSessions.map((session) => renderCard(session, 'warm'))}
                  </div>
                </section>
              )}

              {/* Warm: 1-36 hours. Large card, no chat. Responsive 1/2 col at 1000px. */}
              {warmSessions.length > 0 && (
                <section>
                  <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
                    Recent
                  </h2>
                  <div className="grid grid-cols-1 active-grid gap-3">
                    {warmSessions.map((session) => renderCard(session, 'warm'))}
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
                    {historySessions.map((session) => renderCard(session, 'history'))}
                  </div>
                </section>
              )}
            </div>
          </div>
        )}

        {folderEditor && (
          <FolderEditor folder={folderEditor === 'new' ? null : folderEditor} onClose={() => setFolderEditor(null)} />
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
