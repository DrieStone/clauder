import { useState, useRef, useEffect } from 'react';
import type { SessionState, Trigger } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';
import { MessageList } from './MessageList';
import { PromptInput } from './PromptInput';
import { StatusBadge } from './StatusBadge';
import { PermissionModeSelector } from './PermissionModeSelector';
import { FileBrowser } from './FileBrowser';
import { DebugLogView } from './DebugLogView';
import { GitIndicator } from './GitIndicator';
import { ShareModal } from './ShareModal';
import { ModelEffortSelector } from './ModelEffortSelector';
import { TagControl, SessionTagChips, primaryTagColor } from './Tags';
import { WakeupBanner } from './WakeupBanner';
import { WatchPanel } from './WatchPanel';
import { PlanBanner } from './PlanBanner';
import { MonitorBanner } from './MonitorBanner';
import { RateLimitBar } from './RateLimitBar';
import { TaskSelector } from './TaskSelector';
import { RichMarkdown } from './RichMarkdown';

/** Matches raw auth-failure text that reached session.error without being normalized to the
 *  'AUTH_EXPIRED' sentinel (the CLI has surfaced this through several paths — result errors,
 *  crashes, and assistant text). Any of these should show the re-authenticate banner, never
 *  the dead-end generic error banner. */
const AUTH_ERRORISH_RE = /Failed to authenticate|OAuth (?:token|session) (?:has )?expired|could not be refreshed|authentication_error/i;

interface SessionViewProps {
  session: SessionState;
  allSessions: SessionState[];
  onBack: () => void;
  onSwitchSession: (id: string) => void;
  draft: string;
  onDraftChange: (v: string) => void;
}

export function SessionView({ session, allSessions, onBack, onSwitchSession, draft, onDraftChange }: SessionViewProps) {
  const { sendMessage, interruptSession, resetSession, setModel, setEffort, renameSession, generateSummary, respondToPermission, dequeueMessage, cancelWakeup, respondToPlan, setPinned, setTabClosed, setPinOrder, isUnread, logEvent, stopMonitor, state, openSearch, scrollToMessageId, setScrollToMessageId, requestHistory, refreshSkills } = useSessions();
  const isWorking = session.status === 'working';
  // SessionView is a single long-lived component instance reused across every session
  // (App.tsx renders it with the active session as a prop, not a `key`, so switching
  // sessions re-renders rather than remounts) — so a plain useState for the sub-tab bled
  // across sessions: leaving session A on "Files" made session B open on "Files" too.
  // Remember each session's own last-viewed sub-tab in a ref map, and restore it whenever
  // the active session changes.
  const tabBySessionRef = useRef<Map<string, 'chat' | 'files' | 'notes' | 'summary' | 'debug'>>(new Map());
  // Remembers the last effort used with each model, per session (key: `${sessionId}:${model}`),
  // so switching models restores the effort you last paired with it instead of carrying over
  // whatever effort the previous model was on.
  const effortByModelRef = useRef<Map<string, string>>(new Map());
  const [activeTab, setActiveTabState] = useState<'chat' | 'files' | 'notes' | 'summary' | 'debug'>('chat');
  useEffect(() => {
    setActiveTabState(tabBySessionRef.current.get(session.id) ?? 'chat');
  }, [session.id]);

  // The session list only carries each session's recent messages, and skills are no longer
  // scanned for every session on connect — both are fetched for the session you actually open.
  useEffect(() => {
    if ((session.messageCount ?? 0) > session.messages.length) requestHistory(session.id);
    refreshSkills(session.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);
  const setActiveTab = (tab: typeof activeTab) => {
    logEvent('tab_switch', { tab });
    tabBySessionRef.current.set(session.id, tab);
    setActiveTabState(tab);
  };
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.config.name);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [authState, setAuthState] = useState<'idle' | 'waiting'>('idle');
  const [showQuickSchedule, setShowQuickSchedule] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const shareCount = state.shares.filter(s => s.sessionId === session.id).length;
  // Tab right-click menu, closed tabs, pinned-tab order, and the pinned tab being dragged.
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const closedTabs = state.uiState.closedTabs;
  const pinOrder = state.uiState.pinOrder;
  const [dragId, setDragId] = useState<string | null>(null);
  useEffect(() => {
    if (!tabMenu) return;
    const close = () => setTabMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [tabMenu]);

  // Scroll to and briefly highlight a specific message — set by search's session hits via
  // requestScrollTo (which switches the active session, then arms this). Runs on the Chat
  // tab only; if a different sub-tab was showing, switch to Chat first so MessageList mounts
  // and the target DOM node exists before scrollIntoView runs.
  useEffect(() => {
    if (!scrollToMessageId) return;
    if (activeTab !== 'chat') { setActiveTab('chat'); return; }
    const raf = requestAnimationFrame(() => {
      const el = document.getElementById(`msg-${scrollToMessageId}`);
      // Not there yet? This session's older history may still be loading — retry when it lands
      // (this effect re-runs as messages arrive), and give up after a few seconds.
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('ring-2', 'ring-blue-500/60');
      setTimeout(() => el.classList.remove('ring-2', 'ring-blue-500/60'), 2000);
      setScrollToMessageId(null);
    });
    const giveUp = setTimeout(() => setScrollToMessageId(null), 6000);
    return () => { cancelAnimationFrame(raf); clearTimeout(giveUp); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollToMessageId, activeTab, session.messages.length]);

  // Clear loading state when summary arrives
  const summaryRef = useRef(session.summary);
  useEffect(() => {
    if (session.summary !== summaryRef.current) {
      summaryRef.current = session.summary;
      setGeneratingSummary(false);
    }
  }, [session.summary]);

  // Treat both the normalized sentinel and raw OAuth-ish error text as "auth expired" —
  // any path that slips an unnormalized auth failure into session.error still gets the
  // re-auth banner instead of a dead-end generic error.
  const authExpired = !!session.error && (session.error === 'AUTH_EXPIRED' || AUTH_ERRORISH_RE.test(session.error));

  // Reset auth waiting state when auth is restored (error clears)
  useEffect(() => {
    if (!authExpired) setAuthState('idle');
  }, [authExpired]);

  const handleGenerateSummary = () => {
    setGeneratingSummary(true);
    generateSummary(session.id);
  };

  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const handleRenameSubmit = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== session.config.name) {
      renameSession(session.id, trimmed);
    }
    setIsRenaming(false);
  };

  const contextPct = session.contextUsage && session.contextUsage.contextWindow
    ? Math.min(100, Math.round((session.contextUsage.inputTokens / session.contextUsage.contextWindow) * 100))
    : null;

  const scheduledCount = Array.from(state.triggers.values())
    .filter(t => t.sessionId === session.id && t.source === 'scheduled' && t.enabled).length;

  // Enabled ONE-SHOT scheduled tasks per session — drives the clock indicator on switcher
  // tabs so "which sessions have something scheduled" is visible without opening each one.
  // Recurring tasks are deliberately excluded: they'd light the clock permanently (e.g. the
  // standing CLAUDE.md cleanup), turning it into always-on noise instead of a signal.
  const scheduledFor = (sessionId: string) =>
    Array.from(state.triggers.values())
      .filter(t => t.sessionId === sessionId && t.source === 'scheduled' && t.enabled && t.schedule.type === 'once').length;

  // Show active sessions (working or active in last hour), any session with unread
  // messages — so a trigger response on a quiet session still surfaces in the tab bar —
  // and anything the user has explicitly pinned, regardless of activity. Scratch is pulled
  // out so it always appears first. Pinned sessions sort ahead of the rest, alphabetically
  // within each group.
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const now = Date.now();
  const scratchSession = allSessions.find(s => s.config.isScratch);
  const sortedSessions = allSessions
    .filter(s => {
      if (s.config.isScratch) return false;
      if (s.id === session.id) return true;
      // Closed from the right-click menu: hidden until the session has activity after the close.
      const closedAt = closedTabs[s.id];
      if (closedAt && new Date(s.lastActiveAt).getTime() <= closedAt && s.status !== 'working') return false;
      return s.config.pinned || s.status === 'working' || (now - new Date(s.lastActiveAt).getTime()) < ONE_HOUR_MS || isUnread(s);
    })
    .sort((a, b) => {
      const pinDiff = (b.config.pinned ? 1 : 0) - (a.config.pinned ? 1 : 0);
      if (pinDiff !== 0) return pinDiff;
      // Pinned tabs keep the order they were dragged into; new pins go last, by name.
      if (a.config.pinned) {
        const ia = pinOrder.indexOf(a.id), ib = pinOrder.indexOf(b.id);
        if (ia !== ib) return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
      }
      return a.config.name.localeCompare(b.config.name);
    });
  const pinnedIds = sortedSessions.filter(s => s.config.pinned).map(s => s.id);
  const movePinned = (from: string, to: string) => {
    if (from === to) return;
    const ids = pinnedIds.filter(id => id !== from);
    ids.splice(ids.indexOf(to) + (pinnedIds.indexOf(from) < pinnedIds.indexOf(to) ? 1 : 0), 0, from);
    setPinOrder(ids);
  };
  const closeTab = (id: string) => {
    setTabClosed(id, true);
    if (id === session.id) {
      const next = sortedSessions.find(s => s.id !== id);
      if (next) onSwitchSession(next.id); else onBack();
    }
  };
  const togglePin = (id: string, pin: boolean) => {
    setPinned(id, pin);
    if (pin && closedTabs[id]) setTabClosed(id, false);
  };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Session switcher tabs */}
      <div className="flex items-center bg-gray-900 border-b border-gray-800 shrink-0 overflow-x-auto">
        <button
          onClick={onBack}
          className="min-h-[44px] px-4 text-gray-500 hover:text-gray-200 text-sm transition-colors shrink-0 border-r border-gray-800 flex items-center"
        >
          &larr;
        </button>
        {/* Scratch tab — always present, regardless of activity */}
        {scratchSession && (
          <button
            key={scratchSession.id}
            onClick={() => onSwitchSession(scratchSession.id)}
            title="Scratch (Cmd/Ctrl+Shift+S)"
            className={`px-3 min-h-[44px] text-xs font-medium transition-colors shrink-0 flex items-center gap-1.5 border-b-2 border-r border-r-gray-800 ${
              scratchSession.id === session.id
                ? 'text-amber-300 border-b-amber-400'
                : 'text-amber-500 hover:text-amber-300 border-b-transparent'
            }`}
          >
            <span>📝</span>
            {scratchSession.status === 'working' && (
              <span className="flex gap-0.5 shrink-0">
                <span className="w-1 h-1 rounded-full bg-amber-400 animate-bounce [animation-delay:0ms]" />
                <span className="w-1 h-1 rounded-full bg-amber-400 animate-bounce [animation-delay:150ms]" />
                <span className="w-1 h-1 rounded-full bg-amber-400 animate-bounce [animation-delay:300ms]" />
              </span>
            )}
            <span>Scratch</span>
          </button>
        )}
        {sortedSessions.map((s) => {
          const tabUnread = s.id !== session.id && isUnread(s);
          const pinned = !!s.config.pinned;
          const tabSched = scheduledFor(s.id);
          const tabWakeup = !!s.pendingWakeup;
          const tabColor = primaryTagColor(s, state.tags);
          const isActiveTab = s.id === session.id;
          const schedTitle = [
            tabSched > 0 ? `${tabSched} scheduled task${tabSched !== 1 ? 's' : ''}` : '',
            tabWakeup ? 'auto-wakeup pending' : '',
          ].filter(Boolean).join(' · ');
          return (
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              onClick={() => onSwitchSession(s.id)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSwitchSession(s.id); }}
              onContextMenu={(e) => { e.preventDefault(); setTabMenu({ id: s.id, x: e.clientX, y: e.clientY }); }}
              draggable={pinned}
              onDragStart={(e) => { setDragId(s.id); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => { if (pinned && dragId && dragId !== s.id) e.preventDefault(); }}
              onDrop={(e) => { e.preventDefault(); if (dragId) movePinned(dragId, s.id); setDragId(null); }}
              onDragEnd={() => setDragId(null)}
              className={`${dragId === s.id ? 'opacity-40 ' : ''}group relative px-3 min-h-[44px] text-xs font-medium transition-colors shrink-0 flex items-center gap-1.5 border-b-2 cursor-pointer ${
                s.id === session.id
                  ? 'text-blue-400 border-blue-400'
                  : 'text-gray-500 hover:text-gray-300 border-transparent'
              }`}
            >
              {/* Primary-tag color bar — full-strength on the active tab, dimmed otherwise */}
              {tabColor && (
                <span
                  className="absolute top-0 inset-x-0 h-0.5"
                  style={{ backgroundColor: tabColor, opacity: isActiveTab ? 1 : 0.55 }}
                />
              )}
              {s.status === 'working' && (
                <span className="flex gap-0.5 shrink-0">
                  <span className="w-1 h-1 rounded-full bg-amber-400 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1 h-1 rounded-full bg-amber-400 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1 h-1 rounded-full bg-amber-400 animate-bounce [animation-delay:300ms]" />
                </span>
              )}
              {s.status === 'error' && (
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" />
              )}
              {tabUnread && (
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" title="Unread messages" />
              )}
              {(tabSched > 0 || tabWakeup) && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    logEvent('schedule_review_open', { from: 'tab' });
                    onSwitchSession(s.id);
                    setShowQuickSchedule(true);
                  }}
                  className="shrink-0 text-sky-400 hover:text-sky-200 transition-colors"
                  title={`${schedTitle} — click to review`}
                >
                  <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="12" cy="12" r="9" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 7v5l3 2" />
                  </svg>
                </button>
              )}
              <span className="truncate max-w-[120px]">{s.config.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); togglePin(s.id, !pinned); }}
                className={`shrink-0 transition-opacity ${pinned ? 'opacity-100 text-amber-400' : 'opacity-40 group-hover:opacity-70 hover:!opacity-100 text-gray-400'}`}
                title={pinned ? 'Unpin tab' : 'Pin tab (always show, regardless of activity)'}
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5h14l-4.091-4.091a2.25 2.25 0 01-.659-1.591V3.104M12 14.5v6" />
                </svg>
              </button>
            </div>
          );
        })}
      </div>

      {tabMenu && (() => {
        const t = allSessions.find(x => x.id === tabMenu.id);
        if (!t) return null;
        const item = 'w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700';
        return (
          <div
            className="fixed z-50 min-w-[140px] py-1 bg-gray-800 border border-gray-700 rounded-md shadow-xl"
            style={{ left: Math.min(tabMenu.x, window.innerWidth - 160), top: tabMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button className={item} onClick={() => { togglePin(t.id, !t.config.pinned); setTabMenu(null); }}>
              {t.config.pinned ? 'Unpin tab' : 'Pin tab'}
            </button>
            <button className={item} onClick={() => { if (t.config.pinned) setPinned(t.id, false); closeTab(t.id); setTabMenu(null); }}>
              Close tab
            </button>
          </div>
        );
      })()}

      {/* Working progress bar */}
      {isWorking && (
        <div className="h-0.5 bg-gray-800 overflow-hidden shrink-0">
          <div className="h-full bg-amber-500 animate-progress" />
        </div>
      )}

      {/* Header. Phone: row 1 = name + status + actions, row 2 = model/goal/tags — the same three
          groups, reflowed with order-*. sm+: a single row, as before. */}
      <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1.5 sm:gap-3 px-3 sm:px-4 py-2 sm:py-3 border-b border-gray-800 bg-gray-900/50 shrink-0">
        <div className="order-1 flex-1 sm:flex-initial sm:max-w-[40%] min-w-0 flex items-center gap-2">
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameSubmit();
                if (e.key === 'Escape') { setIsRenaming(false); setRenameValue(session.config.name); }
              }}
              onBlur={handleRenameSubmit}
              className="text-sm font-semibold bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-white outline-none focus:border-blue-500 min-w-0 max-w-[200px]"
            />
          ) : (
            <h2
              className="text-sm font-semibold truncate min-w-0 cursor-pointer hover:text-blue-400 transition-colors"
              onClick={() => { setRenameValue(session.config.name); setIsRenaming(true); }}
              title="Click to rename"
            >
              {session.config.name}
            </h2>
          )}
          <StatusBadge status={session.status} waitingFor={session.waitingFor} compact />
          {session.origin === 'vscode' && (
            <span className="text-[10px] text-purple-400 bg-purple-400/10 px-1.5 py-0.5 rounded shrink-0">VS Code</span>
          )}
          {session.config.controllerMode && (
            <span
              className="text-[10px] text-purple-300 bg-purple-500/20 border border-purple-500/40 px-1.5 py-0.5 rounded shrink-0"
              title="This session can orchestrate other sessions via MCP tools"
            >
              Controller
            </span>
          )}
          {shareCount > 0 && (
            <button
              onClick={() => setShowShare(true)}
              className="text-[10px] text-teal-300 bg-teal-500/15 border border-teal-500/30 px-1.5 py-0.5 rounded shrink-0"
              title="Shared with guests on your local network. Click to manage the links."
            >
              🔗 Shared{shareCount > 1 ? ` · ${shareCount}` : ''}
            </button>
          )}
        </div>
        <div className="order-3 sm:order-2 basis-full sm:basis-0 sm:flex-1 min-w-0 flex items-center gap-1.5 sm:gap-2 flex-wrap">
          <ModelEffortSelector
            model={session.config.model}
            effort={session.config.effort}
            onModelChange={(model) => {
              setModel(session.id, model);
              const remembered = effortByModelRef.current.get(`${session.id}:${model}`);
              if (remembered) setEffort(session.id, remembered);
            }}
            onEffortChange={(effort) => {
              if (session.config.model && effort) {
                effortByModelRef.current.set(`${session.id}:${session.config.model}`, effort);
              }
              setEffort(session.id, effort || '');
            }}
          />
          <GoalControl session={session} />
          <TagControl session={session} />
          <SessionTagChips session={session} />
          <GitIndicator sessionId={session.id} working={session.status === 'working'} />
        </div>
        <div className="order-2 sm:order-3 flex items-center gap-0.5 sm:gap-3 shrink-0">
          <RateLimitBar />
          <button
            onClick={() => { logEvent('search_modal_open'); openSearch(); }}
            className="p-2 min-h-[40px] sm:min-h-0 text-gray-400 hover:text-gray-200 transition-colors shrink-0"
            title="Search sessions and files (Cmd/Ctrl+K)"
            aria-label="Search"
          >
            🔍
          </button>
          <button
            onClick={() => { logEvent('schedule_review_open'); setShowQuickSchedule(true); }}
            className="relative p-2 sm:p-0 text-xs text-gray-400 hover:text-gray-200 transition-colors shrink-0 flex items-center"
            title={scheduledCount > 0 ? `${scheduledCount} scheduled item${scheduledCount !== 1 ? 's' : ''} — click to review` : 'Schedule a message to this session'}
          >
            &#x1f551;<span className="hidden sm:inline"> Schedule</span>
            {scheduledCount > 0 && (
              <span className="ml-1 min-w-[16px] h-4 px-1 rounded-full bg-blue-500 text-white text-[10px] font-medium flex items-center justify-center leading-none">
                {scheduledCount}
              </span>
            )}
          </button>
          <SessionSettingsMenu session={session} contextPct={contextPct} onBack={onBack} onShare={() => setShowShare(true)} />
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-800 shrink-0 overflow-x-auto">
        <button
          onClick={() => setActiveTab('chat')}
          className={`shrink-0 px-3 sm:px-4 py-3 min-h-[44px] text-xs font-medium whitespace-nowrap transition-colors ${
            activeTab === 'chat'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Chat
        </button>
        <button
          onClick={() => setActiveTab('files')}
          className={`shrink-0 px-3 sm:px-4 py-3 min-h-[44px] text-xs font-medium whitespace-nowrap transition-colors ${
            activeTab === 'files'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Files
        </button>
        <button
          onClick={() => setActiveTab('notes')}
          className={`shrink-0 px-3 sm:px-4 py-3 min-h-[44px] text-xs font-medium whitespace-nowrap transition-colors ${
            activeTab === 'notes'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Notes{session.notes && (
            <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-blue-400 align-middle" title="Has notes" />
          )}
        </button>
        <button
          onClick={() => setActiveTab('summary')}
          className={`shrink-0 px-3 sm:px-4 py-3 min-h-[44px] text-xs font-medium whitespace-nowrap transition-colors ${
            activeTab === 'summary'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Summary
        </button>
        <button
          onClick={() => setActiveTab('debug')}
          className={`shrink-0 px-3 sm:px-4 py-3 min-h-[44px] text-xs font-medium whitespace-nowrap transition-colors ${
            activeTab === 'debug'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Debug{session.debugLog.length > 0 && (
            <span className="ml-1 text-[10px] text-gray-600">{session.debugLog.length}</span>
          )}
        </button>
      </div>

      {activeTab === 'chat' ? (
        <>
          {/* Tool activity bar */}
          {isWorking && (
            <div className="px-3 sm:px-4 py-1.5 sm:py-2 border-b border-gray-800/50 bg-gray-900/30 shrink-0">
              <div className="flex items-center gap-2 text-xs text-amber-400">
                <span className="flex gap-0.5">
                  <span className="w-1 h-1 rounded-full bg-amber-400 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1 h-1 rounded-full bg-amber-400 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1 h-1 rounded-full bg-amber-400 animate-bounce [animation-delay:300ms]" />
                </span>
                {session.currentToolActivity ? (
                  <span className="truncate">
                    <span className="font-medium">{session.currentToolActivity.toolName}</span>
                    <span className="text-amber-400/70 ml-1">{session.currentToolActivity.description}</span>
                  </span>
                ) : (
                  <span>Thinking...</span>
                )}
              </div>
            </div>
          )}

          {/* Permission prompt */}
          {session.pendingPermission && (
            <PermissionPrompt
              toolName={session.pendingPermission.toolName}
              input={session.pendingPermission.input}
              onAllow={() => respondToPermission(session.id, session.pendingPermission!.toolUseId, 'allow')}
              onDeny={() => respondToPermission(session.id, session.pendingPermission!.toolUseId, 'deny')}
            />
          )}

          {/* Controller watch panel */}
          {session.config.controllerMode && (
            <WatchPanel
              sessionId={session.id}
              triggers={Array.from(state.triggers.values())}
            />
          )}

          {/* Scheduled wakeup banner */}
          {session.pendingWakeup && (
            <WakeupBanner
              wakeup={session.pendingWakeup}
              onCancel={() => cancelWakeup(session.id)}
            />
          )}

          {/* Model plan progress banner */}
          {session.config.modelPlan?.status === 'running' && (
            <ModelPlanBanner session={session} />
          )}

          {/* Active event-monitors */}
          {session.monitors?.length > 0 && (
            <MonitorBanner monitors={session.monitors} onStop={(id) => stopMonitor(session.id, id)} />
          )}

          {/* Plan awaiting accept/reject */}
          {state.pendingPlans.has(session.id) && (
            <PlanBanner
              plan={state.pendingPlans.get(session.id)!}
              onAccept={(feedback) => respondToPlan(session.id, state.pendingPlans.get(session.id)!.toolUseId, 'accept', feedback)}
              onReject={(feedback) => respondToPlan(session.id, state.pendingPlans.get(session.id)!.toolUseId, 'reject', feedback)}
            />
          )}

          {/* Auth expired banner */}
          {authExpired && (
            <div className="mx-4 mt-2 px-3 py-2 bg-amber-900/30 border border-amber-700 rounded text-xs text-amber-200 shrink-0 flex flex-wrap items-center justify-between gap-2">
              <span>
                {authState === 'waiting'
                  ? 'Complete authentication in the new tab, then return here.'
                  : 'Claude authentication expired. Re-login required.'}
              </span>
              <button
                onClick={async () => {
                  if (authState === 'waiting') return;
                  setAuthState('waiting');
                  try {
                    const res = await fetch('/api/claude-auth/login', { method: 'POST' });
                    const data = await res.json();
                    if (data.url) {
                      window.open(data.url, '_blank', 'noopener');
                    }
                  } catch {
                    setAuthState('idle');
                  }
                }}
                disabled={authState === 'waiting'}
                className="px-2.5 py-1 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 disabled:cursor-wait text-white rounded transition-colors whitespace-nowrap"
              >
                {authState === 'waiting' ? 'Waiting…' : 'Re-authenticate'}
              </button>
            </div>
          )}

          {/* Error banner */}
          {session.error && !authExpired && (
            <div className="mx-4 mt-2 px-3 py-2 bg-red-900/30 border border-red-800 rounded text-xs text-red-300 shrink-0 flex flex-wrap items-center justify-between gap-2">
              <span>{session.error}</span>
              <div className="flex gap-1.5">
                {/too large|start fresh|request_too_large|413|auto-reset|abandoned/i.test(session.error) && (
                  <button
                    onClick={() => resetSession(session.id)}
                    className="px-2.5 py-1 bg-amber-800 hover:bg-amber-700 text-white rounded transition-colors whitespace-nowrap"
                  >
                    Start Fresh
                  </button>
                )}
                <button
                  onClick={() => sendMessage(session.id, 'Continue where you left off.')}
                  className="px-2.5 py-1 bg-red-800 hover:bg-red-700 text-white rounded transition-colors whitespace-nowrap"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          <TaskSelector session={session} isWorking={isWorking} />

          {/* Messages */}
          <MessageList key={session.activeThreadId} messages={session.messages} sessionId={session.id} />

          {/* Queued messages */}
          {session.queuedMessages.length > 0 && (
            <div className="border-t border-gray-800/50 shrink-0">
              <div className="px-4 py-1 text-[10px] text-gray-500 uppercase tracking-wider">
                {session.queuedMessages.length} queued
              </div>
              {session.queuedMessages.map((msg, i) => (
                <div key={i} className="flex items-center gap-2 px-4 py-1.5 hover:bg-gray-800/30 group">
                  <span className="text-xs text-blue-400 truncate flex-1">
                    {msg.text.length > 80 ? msg.text.slice(0, 80) + '…' : msg.text || ''}
                    {msg.images?.length ? <span className="text-gray-500 ml-1">[{msg.images.length} img]</span> : null}
                  </span>
                  <button
                    onClick={() => dequeueMessage(session.id, i)}
                    className="text-gray-600 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100 text-xs shrink-0"
                    title="Remove from queue"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Input */}
          <PromptInput
            sessionId={session.id}
            onSend={(msg, images, planMode, files, model, effort) => sendMessage(session.id, msg, images, planMode, files, model, effort)}
            onInterrupt={() => interruptSession(session.id)}
            isWorking={isWorking}
            draft={draft}
            onDraftChange={onDraftChange}
          />
        </>
      ) : activeTab === 'files' ? (
        <FileBrowser cwd={session.config.cwd} />
      ) : activeTab === 'notes' ? (
        <NotesTab session={session} />
      ) : activeTab === 'debug' ? (
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Session metadata bar */}
          <div className="flex items-center gap-4 px-4 py-2 border-b border-gray-800 text-[11px] text-gray-500 shrink-0">
            {session.config.model && <span>Model: <span className="text-gray-400">{session.config.model}</span></span>}
            {session.sdkSessionId && <span>SDK: <span className="text-gray-400 font-mono">{session.sdkSessionId.slice(0, 12)}...</span></span>}
            {session.config.maxTurns && <span>Max turns: <span className="text-gray-400">{session.config.maxTurns}</span></span>}
            <span>Cost: <span className="text-gray-400">${session.totalCostUsd.toFixed(4)}</span></span>
          </div>
          <DebugLogView entries={session.debugLog} sessionId={session.id} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-6">
          {generatingSummary ? (
            <div className="max-w-xl">
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <span className="flex gap-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-bounce [animation-delay:300ms]" />
                </span>
                Generating summary...
              </div>
            </div>
          ) : session.summary ? (
            <div className="max-w-xl">
              <p className="text-sm text-gray-200 leading-relaxed">{session.summary}</p>
              {session.summaryGeneratedAt && (
                <p className="text-xs text-gray-500 mt-3">
                  Generated {new Date(session.summaryGeneratedAt).toLocaleString()}
                </p>
              )}
              <button
                onClick={handleGenerateSummary}
                className="mt-4 text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                Regenerate
              </button>
            </div>
          ) : (
            <div className="max-w-xl">
              <p className="text-sm text-gray-500">No summary yet. Summaries are auto-generated 4 hours after the last interaction.</p>
              <button
                onClick={handleGenerateSummary}
                className="mt-3 text-xs text-blue-400 hover:text-blue-300 transition-colors"
              >
                Generate now
              </button>
            </div>
          )}
        </div>
      )}

      {showShare && <ShareModal session={session} onClose={() => setShowShare(false)} />}
      {showQuickSchedule && (
        <QuickScheduleModal
          sessionId={session.id}
          sessionName={session.config.name}
          onClose={() => setShowQuickSchedule(false)}
        />
      )}
    </div>
  );
}

// ─── Notes Tab ──────────────────────────────────────────────────────────────

/** User-facing reference notes maintained by Claude via the `<<notes>>` sentinel — practical
 *  things like how to start a dev server or the URL to view something, not project docs
 *  (CLAUDE.md) or a progress recap (Summary). The user can also edit or clear it by hand. */
function NotesTab({ session }: { session: SessionState }) {
  const { setNotes } = useSessions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.notes ?? '');

  const startEditing = () => { setDraft(session.notes ?? ''); setEditing(true); };
  const save = () => { setNotes(session.id, draft); setEditing(false); };
  const clear = () => {
    if (confirm('Clear notes for this session?')) setNotes(session.id, null);
  };

  if (editing) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-xl">
          <textarea
            autoFocus
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="e.g. Run `npm run dev` to start the server. View it at http://localhost:5173."
            rows={12}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 font-mono focus:outline-none focus:border-blue-500 resize-y"
          />
          <div className="flex justify-end gap-2 mt-3">
            <button onClick={() => setEditing(false)} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
            <button onClick={save} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded">Save</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-xl">
        {session.notes ? (
          <>
            <div className="prose prose-invert prose-sm max-w-none [&_pre]:bg-gray-900 [&_pre]:border [&_pre]:border-gray-700 [&_pre]:rounded [&_code]:text-xs">
              <RichMarkdown>{session.notes}</RichMarkdown>
            </div>
            {session.notesUpdatedAt && (
              <p className="text-xs text-gray-500 mt-3">Updated {new Date(session.notesUpdatedAt).toLocaleString()}</p>
            )}
            <div className="flex gap-3 mt-4">
              <button onClick={startEditing} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">Edit</button>
              <button onClick={clear} className="text-xs text-red-400 hover:text-red-300 transition-colors">Clear</button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-gray-500">
              No notes yet. Claude maintains this tab with practical reference info — how to start a
              dev server, a URL to view something in a browser, test credentials, and so on.
            </p>
            <button onClick={startEditing} className="mt-3 text-xs text-blue-400 hover:text-blue-300 transition-colors">
              Add notes manually
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Quick Schedule Modal ───────────────────────────────────────────────────

function defaultDT(): string {
  const d = new Date(Date.now() + 3600_000);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function formatLocal(iso: string): string {
  try { return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return iso; }
}

function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Session-scoped schedule review: lists this session's scheduled triggers (edit time/message
 *  inline, or delete) and a form to add a new one. Reachable from the header's Schedule badge. */
function QuickScheduleModal({ sessionId, sessionName, onClose }: { sessionId: string; sessionName: string; onClose: () => void }) {
  const { state } = useSessions();
  const triggers = Array.from(state.triggers.values())
    .filter(t => t.sessionId === sessionId && t.source === 'scheduled')
    .sort((a, b) => {
      const ms = (t: typeof a) => t.schedule.type === 'once' ? new Date(t.schedule.at).getTime() : new Date(t.schedule.nextAt).getTime();
      return ms(a) - ms(b);
    });

  const [creating, setCreating] = useState(triggers.length === 0);
  const [editingId, setEditingId] = useState<string | null>(null);

  const inputCls = 'w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500';

  const handleRemove = async (id: string) => {
    try { await fetch(`/api/triggers/${id}`, { method: 'DELETE' }); } catch { /* best-effort */ }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md shadow-2xl max-h-[85vh] flex flex-col">
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold">Schedule → {sessionName}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200 text-xl leading-none w-7 h-7 flex items-center justify-center hover:bg-gray-800 rounded">×</button>
        </div>
        <div className="p-4 space-y-2 overflow-y-auto">
          {triggers.length === 0 && !creating && (
            <div className="text-sm text-gray-500 text-center py-6">No scheduled items for this session.</div>
          )}
          {triggers.map(t => (
            editingId === t.id ? (
              <EditTriggerForm key={t.id} trigger={t} inputCls={inputCls} onDone={() => setEditingId(null)} />
            ) : (
              <div key={t.id} className="bg-gray-800/60 border border-gray-700 rounded-lg p-3">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium text-gray-100 truncate">{t.description}</span>
                  {t.schedule.type === 'recurring' && (
                    <span className="text-[10px] text-purple-300 bg-purple-500/20 px-1.5 py-0.5 rounded shrink-0">↻ recurring</span>
                  )}
                </div>
                <div className="text-xs text-gray-400 mt-1">
                  {t.schedule.type === 'once' ? `Fires at ${formatLocal(t.schedule.at)}` : `Next: ${formatLocal(t.schedule.nextAt)}`}
                </div>
                <div className="text-xs text-gray-500 italic mt-1 truncate" title={t.message}>"{t.message}"</div>
                <div className="flex justify-end gap-3 mt-2">
                  <button onClick={() => setEditingId(t.id)} className="text-blue-400 hover:text-blue-300 text-xs">Edit</button>
                  <button onClick={() => handleRemove(t.id)} className="text-red-400 hover:text-red-300 text-xs">Delete</button>
                </div>
              </div>
            )
          ))}
          {creating ? (
            <CreateTriggerForm sessionId={sessionId} inputCls={inputCls} onDone={() => setCreating(false)} />
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="w-full text-center text-xs text-blue-400 hover:text-blue-300 border border-dashed border-gray-700 hover:border-blue-700/50 rounded-lg py-2 transition-colors"
            >
              + Schedule a new message
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CreateTriggerForm({ sessionId, inputCls, onDone }: { sessionId: string; inputCls: string; onDone: () => void }) {
  const [message, setMessage] = useState('');
  const [when, setWhen] = useState(defaultDT());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!message.trim() || !when) { setError('Message and time are required'); return; }
    const at = new Date(when).toISOString();
    if (new Date(at).getTime() < Date.now()) { setError('Scheduled time must be in the future'); return; }
    setSubmitting(true);
    try {
      const res = await fetch('/api/triggers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId, message: message.trim(),
          description: message.trim().slice(0, 60),
          schedule: { type: 'once', at },
          source: 'scheduled',
        }),
      });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      onDone();
    } catch (err: any) { setError(err.message); }
    finally { setSubmitting(false); }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-gray-800/40 border border-blue-700/50 rounded-lg p-3 space-y-2">
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">When</label>
        <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} className={inputCls} />
      </div>
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Message to send</label>
        <textarea
          autoFocus
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder="The message that will be sent to this session at the scheduled time"
          rows={3}
          className={`${inputCls} resize-none`}
        />
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onDone} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
        <button type="submit" disabled={submitting} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded disabled:opacity-50">
          {submitting ? 'Scheduling…' : 'Schedule'}
        </button>
      </div>
    </form>
  );
}

function EditTriggerForm({ trigger, inputCls, onDone }: { trigger: Trigger; inputCls: string; onDone: () => void }) {
  const [message, setMessage] = useState(trigger.message);
  const [description, setDescription] = useState(trigger.description);
  const [when, setWhen] = useState(trigger.schedule.type === 'once' ? isoToLocalInput(trigger.schedule.at) : isoToLocalInput(trigger.schedule.nextAt));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!message.trim() || !when) { setError('Message and time are required'); return; }
    const at = new Date(when).toISOString();
    if (new Date(at).getTime() < Date.now()) { setError('Scheduled time must be in the future'); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/triggers/${trigger.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: message.trim(),
          description: description.trim() || message.trim().slice(0, 60),
          scheduleAt: at,
        }),
      });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      onDone();
    } catch (err: any) { setError(err.message); }
    finally { setSubmitting(false); }
  };

  return (
    <form onSubmit={handleSubmit} className="bg-gray-800/40 border border-blue-700/50 rounded-lg p-3 space-y-2">
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Description</label>
        <input value={description} onChange={e => setDescription(e.target.value)} className={inputCls} />
      </div>
      {trigger.schedule.type === 'once' ? (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">When</label>
          <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} className={inputCls} />
        </div>
      ) : (
        <div className="text-[10px] text-gray-500">Recurring schedule timing can't be edited here — delete and recreate to change the interval.</div>
      )}
      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Message to send</label>
        <textarea
          autoFocus
          value={message}
          onChange={e => setMessage(e.target.value)}
          rows={3}
          className={`${inputCls} resize-none`}
        />
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onDone} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
        <button type="submit" disabled={submitting} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded disabled:opacity-50">
          {submitting ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}

// ─── Permission Prompt ──────────────────────────────────────────────────────

function formatToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return String(input.command || '').slice(0, 200);
    case 'Read':
    case 'Write':
    case 'Edit':
      return String(input.file_path || '');
    case 'Glob':
      return String(input.pattern || '');
    case 'Grep':
      return `${input.pattern || ''} in ${input.path || '.'}`;
    default:
      return '';
  }
}

/** Overflow "settings" menu in the session header — holds the less-frequently-used controls
 *  (permission mode, compact, destroy/clear) so the header can stay focused on model, goal,
 *  schedule, and the reset countdown. A gear button toggles a click-outside-dismissable popover. */
function SessionSettingsMenu({ session, contextPct, onBack, onShare }: { session: SessionState; contextPct: number | null; onBack: () => void; onShare: () => void }) {
  const { compactSession, destroySession, clearSession, setPermissionMode, updateCwd, logEvent } = useSessions();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [isEditingCwd, setIsEditingCwd] = useState(false);
  const [cwdValue, setCwdValue] = useState(session.config.cwd);
  const cwdInputRef = useRef<HTMLInputElement>(null);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (isEditingCwd && cwdInputRef.current) {
      cwdInputRef.current.focus();
      cwdInputRef.current.select();
    }
  }, [isEditingCwd]);

  const handleCwdSubmit = () => {
    const trimmed = cwdValue.trim();
    if (trimmed && trimmed !== session.config.cwd) updateCwd(session.id, trimmed);
    setIsEditingCwd(false);
  };

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        onClick={() => setOpen(o => { if (!o) logEvent('settings_menu_open'); return !o; })}
        className="p-2 text-gray-400 hover:text-gray-200 transition-colors flex items-center"
        title="Session settings"
        aria-label="Session settings"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-2 space-y-1">
          <div className="px-1 pb-1">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Working directory</div>
            {isEditingCwd ? (
              <input
                ref={cwdInputRef}
                value={cwdValue}
                onChange={(e) => setCwdValue(e.target.value)}
                onBlur={handleCwdSubmit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCwdSubmit();
                  if (e.key === 'Escape') { setCwdValue(session.config.cwd); setIsEditingCwd(false); }
                }}
                className="text-xs text-gray-300 bg-gray-900 border border-gray-600 rounded px-1.5 py-1 w-full focus:outline-none focus:border-blue-500"
              />
            ) : (
              <div
                className="text-xs text-gray-400 break-all cursor-pointer hover:text-gray-200 transition-colors"
                onClick={() => { setCwdValue(session.config.cwd); setIsEditingCwd(true); }}
                title="Click to edit working directory"
              >
                {session.config.cwd}
              </div>
            )}
          </div>
          <div className="px-1 pb-1">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Permission mode</div>
            <PermissionModeSelector
              mode={session.permissionMode}
              onChange={(mode) => setPermissionMode(session.id, mode)}
            />
          </div>
          {contextPct !== null && (
            <button
              onClick={() => { compactSession(session.id); setOpen(false); }}
              className="w-full text-left px-2 py-2 rounded text-xs text-blue-300 hover:bg-gray-700/60 transition-colors"
              title={session.contextUsage ? `In: ${session.contextUsage.inputTokens.toLocaleString()} / Out: ${session.contextUsage.outputTokens.toLocaleString()} / Window: ${session.contextUsage.contextWindow.toLocaleString()} tokens` : 'Compact conversation'}
            >
              Compact context ({contextPct}%)
            </button>
          )}
          {session.config.isScratch ? (
            <button
              onClick={() => {
                if (confirm('Clear scratch conversation? This cannot be undone.')) {
                  clearSession(session.id);
                  setOpen(false);
                }
              }}
              className="w-full text-left px-2 py-2 rounded text-xs text-amber-300 hover:bg-gray-700/60 transition-colors"
            >
              Clear conversation
            </button>
          ) : (
            <>
              <button
                onClick={() => { onShare(); setOpen(false); }}
                className="w-full text-left px-2 py-2 rounded text-xs text-teal-300 hover:bg-gray-700/60 transition-colors"
              >
                🔗 Share with someone…
              </button>
              <button
                onClick={() => { setShowArchiveConfirm(true); setOpen(false); }}
                className="w-full text-left px-2 py-2 rounded text-xs text-amber-300 hover:bg-gray-700/60 transition-colors"
              >
                📦 Archive project…
              </button>
              <button
                onClick={() => {
                  if (confirm('Destroy this session?')) {
                    destroySession(session.id);
                    onBack();
                  }
                }}
                className="w-full text-left px-2 py-2 rounded text-xs text-red-300 hover:bg-gray-700/60 transition-colors"
              >
                Destroy session
              </button>
            </>
          )}
        </div>
      )}
      {showArchiveConfirm && (
        <ArchiveConfirmModal session={session} onClose={() => setShowArchiveConfirm(false)} />
      )}
    </div>
  );
}

/** Confirm + live-progress modal for the "Archive Project" feature. Shows exactly what will
 *  happen (dir → Trash, zip → destination) before confirming. Once started, progress streams
 *  in via state.archiveStatus (archive_status broadcasts). On success the server destroys the
 *  session BEFORE broadcasting the final 'done' status, so App.tsx already navigates back to
 *  the Dashboard on its own — no explicit "on success" handling needed here. On error, the
 *  session stays intact and this modal shows the error with a Close button. */
function ArchiveConfirmModal({ session, onClose }: { session: SessionState; onClose: () => void }) {
  const { archiveSession, state } = useSessions();
  const [started, setStarted] = useState(false);
  const status = state.archiveStatus.get(session.id);
  const isError = status?.stage === 'error';

  const handleConfirm = () => {
    setStarted(true);
    archiveSession(session.id);
  };

  const stageLabel = (stage: string | undefined): string => {
    switch (stage) {
      case 'summarizing': return 'Writing wrap-up…';
      case 'zipping': return 'Zipping project…';
      case 'verifying': return 'Verifying archive…';
      case 'trashing': return 'Moving to Trash…';
      case 'done': return 'Done!';
      default: return 'Starting…';
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md shadow-2xl">
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold">📦 Archive project</h2>
          {!started && (
            <button onClick={onClose} className="text-gray-400 hover:text-gray-200 text-xl leading-none w-7 h-7 flex items-center justify-center hover:bg-gray-800 rounded">×</button>
          )}
        </div>
        <div className="p-4 space-y-3">
          {!started ? (
            <>
              <p className="text-sm text-gray-300">
                This moves the project folder to the Trash (recoverable) and archives a zip.
                The session will be removed from Clauder.
              </p>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Moves to Trash</div>
                <div className="text-xs text-gray-300 font-mono break-all bg-gray-800/60 rounded px-2 py-1.5">{session.config.cwd}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Zip destination</div>
                <div className="text-xs text-gray-300 font-mono break-all bg-gray-800/60 rounded px-2 py-1.5">~/Documents/Clauder Archive/</div>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
                <button onClick={handleConfirm} className="px-3 py-1.5 bg-amber-700 hover:bg-amber-600 text-white text-xs font-medium rounded">Archive project</button>
              </div>
            </>
          ) : (
            <>
              <div className={`text-sm ${isError ? 'text-red-300' : 'text-gray-200'}`}>
                {isError ? '⚠️ ' : ''}{status?.message || 'Starting…'}
              </div>
              {!isError && status?.stage !== 'done' && (
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <span className="flex gap-0.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce [animation-delay:0ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce [animation-delay:300ms]" />
                  </span>
                  {stageLabel(status?.stage)}
                </div>
              )}
              {isError && (
                <div className="flex justify-end gap-2 pt-1">
                  <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200">Close</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const MODEL_LABELS: Record<string, string> = {
  'claude-fable-5-1': 'Fable 5.1',
  'claude-fable-5': 'Fable 5', // legacy — kept so a session/plan still pinned to it renders cleanly
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-5-5': 'Opus 5.5',
  'claude-opus-5': 'Opus 5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-sonnet-5': 'Sonnet 5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};
const modelLabel = (id: string) => MODEL_LABELS[id] ?? id.replace(/^claude-/, '');

/** Progress banner for a running multi-step model plan. Shows which step is running, on which
 *  model, the step's task, and what's coming next — with a Stop button. The session's model
 *  dropdown also reflects the live switch since each step calls setModel server-side. */
function ModelPlanBanner({ session }: { session: SessionState }) {
  const { stopModelPlan } = useSessions();
  const plan = session.config.modelPlan;
  if (!plan) return null;
  const runningIdx = plan.cursor - 1; // cursor points at the NEXT step; current is the one just dispatched
  const current = plan.steps[runningIdx];
  const next = plan.steps[plan.cursor];

  return (
    <div className="mx-4 mt-2 rounded border border-indigo-700/60 bg-indigo-950/30 shrink-0">
      <div className="px-3 py-2 flex items-center justify-between gap-2 border-b border-indigo-800/50">
        <div className="flex items-center gap-2 text-xs text-indigo-200 font-medium min-w-0">
          <span>🔀</span>
          <span className="truncate">
            Model plan · step {Math.min(plan.cursor, plan.steps.length)}/{plan.steps.length}
            {current && <span className="text-indigo-300/80"> · running on {modelLabel(current.model)} ({current.effort})</span>}
          </span>
        </div>
        <button
          onClick={() => stopModelPlan(session.id)}
          className="shrink-0 text-[11px] px-2 py-0.5 rounded bg-indigo-800/60 hover:bg-indigo-700 text-indigo-100 transition-colors"
        >
          Stop
        </button>
      </div>
      {current && (
        <div className="px-3 py-1.5 text-xs text-indigo-100/90">
          <span className="text-indigo-400/80">now:</span> {current.task.slice(0, 160)}
        </div>
      )}
      {next && (
        <div className="px-3 pb-2 text-[11px] text-indigo-300/60 truncate">
          next: {modelLabel(next.model)} — {next.task.slice(0, 100)}
        </div>
      )}
    </div>
  );
}

/** Goal Mode control in the session header. Shows a "🎯 Goal" button when off, or a status
 *  badge when on (amber = active, blue 💤 = sleeping through a rate limit, red ⚠️ = stuck and
 *  awaiting you). Click to set / edit / clear. A server-side supervisor (goal-supervisor.ts)
 *  keeps the session working toward the goal until it's met, the deadline passes, or it stalls. */
function GoalControl({ session }: { session: SessionState }) {
  const { setGoal } = useSessions();
  const goal = session.config.goal;

  const edit = () => {
    const next = window.prompt(
      goal
        ? 'Edit the goal (leave blank to turn Goal Mode off):'
        : "Set a goal — Clauder keeps this session working until it's met (checks in on idle, schedules its own follow-ups, sleeps through rate limits):",
      goal?.text ?? '',
    );
    if (next === null) return; // cancelled
    const text = next.trim();
    setGoal(session.id, text ? { text } : null);
  };

  if (!goal) {
    return (
      <button
        onClick={edit}
        className="text-[10px] text-gray-500 hover:text-amber-300 border border-gray-700 hover:border-amber-500/50 rounded px-1.5 py-1 sm:py-0.5 transition-colors shrink-0"
        title="Goal Mode: keep this session working toward a goal until it's met"
      >
        🎯<span className="hidden sm:inline"> Goal</span>
      </button>
    );
  }

  const tone = goal.status === 'stuck' ? 'text-red-300 border-red-500/50'
    : goal.status === 'sleeping' ? 'text-blue-300 border-blue-500/50'
    : 'text-amber-300 border-amber-500/50';
  const suffix = goal.status === 'sleeping' ? ' 💤' : goal.status === 'stuck' ? ' ⚠️' : '';
  const deadline = new Date(goal.deadlineAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return (
    <button
      onClick={edit}
      className={`text-[10px] ${tone} bg-amber-400/10 border rounded px-1.5 py-1 sm:py-0.5 max-w-[160px] truncate transition-colors shrink-0`}
      title={`Goal Mode (${goal.status}) — "${goal.text}"\nEvery ${goal.checkEveryMin}m · max ${goal.maxNudges} check-ins · deadline ${deadline}\nCheck-ins used: ${goal.nudgeCount}/${goal.maxNudges}\nClick to edit or clear.`}
    >
      🎯 {goal.text}{suffix}
    </button>
  );
}

function PermissionPrompt({
  toolName,
  input,
  onAllow,
  onDeny,
  compact = false,
}: {
  toolName: string;
  input: Record<string, unknown>;
  onAllow: () => void;
  onDeny: () => void;
  compact?: boolean;
}) {
  const desc = formatToolInput(toolName, input);

  return (
    <div className={`border-b border-amber-700/40 bg-amber-950/20 shrink-0 ${compact ? 'px-3 py-1.5' : 'px-4 py-3'}`}>
      <div className="flex items-center gap-2 mb-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
        <span className={`font-medium text-amber-300 ${compact ? 'text-xs' : 'text-sm'}`}>
          Permission needed
        </span>
      </div>
      <div className={`${compact ? 'text-xs' : 'text-sm'} text-gray-300 mb-2`}>
        <span className="font-semibold text-white">{toolName}</span>
        {desc && (
          <span className="text-gray-400 ml-1.5 font-mono text-xs break-all">
            {desc}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onAllow}
          className={`${compact ? 'px-2.5 py-1 text-[11px]' : 'px-4 py-2.5 min-h-[44px] text-xs'} bg-green-700 hover:bg-green-600 text-white font-medium rounded transition-colors`}
        >
          Allow
        </button>
        <button
          onClick={onDeny}
          className={`${compact ? 'px-2.5 py-1 text-[11px]' : 'px-4 py-2.5 min-h-[44px] text-xs'} bg-red-800 hover:bg-red-700 text-white font-medium rounded transition-colors`}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

export { PermissionPrompt, formatToolInput };
