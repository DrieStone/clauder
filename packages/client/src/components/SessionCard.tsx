import { useState, useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { SessionState, ContextUsage } from '@clauder/shared';
import { StatusBadge } from './StatusBadge';
import { PermissionModeSelector } from './PermissionModeSelector';
import { useSessions } from '../context/SessionContext';
import { summarizeToolUse } from './MessageBubble';
import { PermissionPrompt } from './SessionView';
import Markdown from 'react-markdown';

export type CardTier = 'hot' | 'warm' | 'history';

function SummaryTooltip({ summary }: { summary: string }) {
  const iconRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; above: boolean }>({ top: 0, left: 0, above: true });

  const show = () => {
    if (!iconRef.current) return;
    const rect = iconRef.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    const above = spaceAbove > spaceBelow;
    setPos({
      top: above ? rect.top - 8 : rect.bottom + 8,
      left: Math.max(140, Math.min(centerX, window.innerWidth - 140)),
      above,
    });
    setVisible(true);
  };

  const hide = () => setVisible(false);

  return (
    <>
      <span
        ref={iconRef}
        className="shrink-0 cursor-help text-gray-500 hover:text-gray-300"
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </span>
      {visible && createPortal(
        <div
          ref={tooltipRef}
          className="fixed z-[9999] w-64 p-2.5 bg-gray-800 border border-gray-700 rounded-lg text-xs text-gray-300 shadow-xl whitespace-pre-line pointer-events-none"
          style={{
            top: pos.above ? undefined : pos.top,
            bottom: pos.above ? `${window.innerHeight - pos.top}px` : undefined,
            left: pos.left,
            transform: 'translateX(-50%)',
          }}
        >
          {summary}
          <div
            className={`absolute left-1/2 -translate-x-1/2 border-4 border-transparent ${
              pos.above ? 'top-full border-t-gray-800' : 'bottom-full border-b-gray-800'
            }`}
          />
        </div>,
        document.body,
      )}
    </>
  );
}

interface SessionCardProps {
  session: SessionState;
  tier: CardTier;
  onClick: () => void;
}

export function SessionCard({ session, tier, onClick }: SessionCardProps) {
  switch (tier) {
    case 'hot':
      return <HotSessionCard session={session} onClick={onClick} />;
    case 'warm':
      return <WarmSessionCard session={session} onClick={onClick} />;
    case 'history':
      return <HistorySessionCard session={session} onClick={onClick} />;
  }
}

function formatTimeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

function formatDate(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ─── Hot: active in the past hour. Chat area + input. ─────────────────────────

function HotSessionCard({ session, onClick }: { session: SessionState; onClick: () => void }) {
  const { sendMessage, interruptSession, updateLastActive, setPermissionMode, renameSession, respondToPermission } = useSessions();
  const [inputValue, setInputValue] = useState('');
  const [, setTick] = useState(0);
  const isWorking = session.status === 'working';
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inlineTextareaRef = useRef<HTMLTextAreaElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.config.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

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

  // Auto-resize inline textarea to fit content
  useEffect(() => {
    const el = inlineTextareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [inputValue]);

  // Tick every 30s so "X ago" stays fresh
  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  // Debounced: reset lastActiveAt when user types (keeps session "hot")
  const handleTyping = useCallback(() => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      updateLastActive(session.id);
    }, 2000);
  }, [updateLastActive, session.id]);

  // Scroll chat area to bottom when messages change or on mount
  useEffect(() => {
    const el = chatContainerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.messages]);

  // Gather recent messages for the chat area (last few)
  const recentMessages = session.messages
    .filter(m => m.role !== 'system')
    .slice(-4);

  const handleSend = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    sendMessage(session.id, trimmed);
    setInputValue('');
  }, [inputValue, sendMessage, session.id]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const isScratch = !!session.config.isScratch;
  return (
    <div
      className={`bg-gray-900 border rounded-xl overflow-hidden transition-colors flex flex-col ${
        isWorking ? 'border-amber-700/60' : isScratch ? 'border-amber-800/60' : 'border-gray-800'
      }`}
    >
      {/* Working progress bar */}
      {isWorking && (
        <div className="h-0.5 bg-gray-800 overflow-hidden">
          <div className="h-full bg-amber-500 animate-progress" />
        </div>
      )}

      {/* Header - clickable to expand */}
      <button
        onClick={() => { if (!isRenaming) onClick(); }}
        className="w-full text-left px-4 py-2 hover:bg-gray-800/50 transition-colors cursor-pointer group shrink-0"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
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
                onClick={(e) => e.stopPropagation()}
                className="text-sm font-semibold bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-white outline-none focus:border-blue-500 max-w-[180px]"
              />
            ) : (
              <>
                <h3 className="text-sm font-semibold text-gray-100 truncate group-hover:text-white">
                  {session.config.name}
                </h3>
                <button
                  onClick={(e) => { e.stopPropagation(); setRenameValue(session.config.name); setIsRenaming(true); }}
                  className="text-gray-600 hover:text-gray-300 transition-colors shrink-0"
                  title="Rename"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
                {session.summary && <SummaryTooltip summary={session.summary} />}
              </>
            )}
            <StatusBadge status={session.status} />
            {session.origin === 'vscode' && (
              <span className="text-[10px] text-purple-400 bg-purple-400/10 px-1.5 py-0.5 rounded">VS Code</span>
            )}
            {session.config.isScratch && (
              <span className="text-[10px] text-amber-300 bg-amber-400/10 px-1.5 py-0.5 rounded">📝 Scratch</span>
            )}
            <PermissionModeSelector
              mode={session.permissionMode}
              onChange={(mode) => setPermissionMode(session.id, mode)}
              compact
            />
          </div>
          <div className="flex items-center gap-3 text-xs text-gray-500 shrink-0">
            <span>{formatTimeAgo(session.lastActiveAt)}</span>
            <span className="text-gray-600">&rarr;</span>
          </div>
        </div>
        <div className="text-xs text-gray-500 truncate mt-0.5">{session.config.cwd}</div>
      </button>

      {/* Context usage */}
      <ContextBar usage={session.contextUsage} sessionId={session.id} />

      {/* Working indicator */}
      {isWorking && <WorkingIndicator activity={session.currentToolActivity} />}

      {/* Queued messages indicator */}
      {session.queuedMessages.length > 0 && (
        <div className="px-4 py-1 text-xs text-blue-400">
          {session.queuedMessages.length} queued message{session.queuedMessages.length > 1 ? 's' : ''}
          {session.queuedMessages.map((msg, i) => (
            <span key={i} className="ml-1 text-gray-500">&middot; {msg.text.length > 30 ? msg.text.slice(0, 30) + '...' : msg.text}{msg.images?.length ? ` [${msg.images.length} img]` : ''}</span>
          ))}
        </div>
      )}

      {/* Scrollable chat area */}
      <div ref={chatContainerRef} className="flex-1 overflow-y-auto px-4 pb-1 max-h-28 min-h-[48px] space-y-1.5">
        {recentMessages.map((msg) => (
          <div key={msg.id}>
            {msg.role === 'user' ? (
              <div className="flex justify-end">
                <div className="bg-blue-600 text-white rounded-lg px-3 py-1.5 text-sm max-w-[85%]">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div className="text-sm text-gray-300 prose prose-invert prose-sm max-w-none [&_pre]:bg-gray-800 [&_pre]:border [&_pre]:border-gray-700 [&_pre]:rounded [&_pre]:text-xs [&_code]:text-xs [&_p]:my-1">
                {msg.toolUses && msg.toolUses.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1 not-prose">
                    {msg.toolUses.map((tool) => {
                      const desc = summarizeToolUse(tool);
                      return (
                        <span key={tool.id} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-700/50 text-xs">
                          <span className="text-gray-300 font-medium">{tool.name}</span>
                          {desc && <span className="text-gray-500 truncate max-w-[120px]">{desc}</span>}
                        </span>
                      );
                    })}
                  </div>
                )}
                {msg.content ? (
                  <Markdown>{msg.content.length > 600
                    ? msg.content.slice(0, 600) + '...'
                    : msg.content}
                  </Markdown>
                ) : null}
                {msg.isStreaming && (
                  <span className="inline-block w-1.5 h-3.5 bg-gray-400 animate-pulse align-text-bottom" />
                )}
              </div>
            )}
          </div>
        ))}
        {recentMessages.length === 0 && (
          <div className="text-xs text-gray-600 py-4 text-center">Send a message to start</div>
        )}
      </div>

      {/* Permission prompt */}
      {session.pendingPermission && (
        <PermissionPrompt
          toolName={session.pendingPermission.toolName}
          input={session.pendingPermission.input}
          onAllow={() => respondToPermission(session.id, session.pendingPermission!.toolUseId, 'allow')}
          onDeny={() => respondToPermission(session.id, session.pendingPermission!.toolUseId, 'deny')}
          compact
        />
      )}

      {/* Inline input */}
      <div className="px-3 pb-2 pt-1 shrink-0 border-t border-gray-800/50">
        <div className="flex gap-2">
          <textarea
            ref={inlineTextareaRef}
            value={inputValue}
            onChange={(e) => { setInputValue(e.target.value); handleTyping(); }}
            onKeyDown={handleKeyDown}
            placeholder={isWorking ? 'Queue a message...' : 'Reply... (Enter to send)'}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500 min-h-[34px] max-h-[40vh] overflow-y-auto"
            rows={1}
          />
          {isWorking && (
            <button
              onClick={() => interruptSession(session.id)}
              className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition-colors"
            >
              Stop
            </button>
          )}
          <button
            onClick={handleSend}
            disabled={!inputValue.trim()}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs font-medium rounded-lg transition-colors"
          >
            {isWorking ? 'Queue' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Warm: 1-36 hours. Large card, no chat/input. Click to expand. ────────────

function WarmSessionCard({ session, onClick }: { session: SessionState; onClick: () => void }) {
  const { setPermissionMode, renameSession } = useSessions();
  const isWorking = session.status === 'working';
  const [, setTick] = useState(0);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.config.name);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const interval = setInterval(() => setTick(t => t + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

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

  return (
    <div
      className={`w-full text-left bg-gray-900 border rounded-xl hover:border-gray-600 transition-colors cursor-pointer group ${
        isWorking ? 'border-amber-700/60' : 'border-gray-800'
      }`}
    >
      <button onClick={() => { if (!isRenaming) onClick(); }} className="w-full text-left p-4">
        {isWorking && (
          <div className="h-0.5 bg-gray-800 overflow-hidden rounded-full mb-3 -mt-1">
            <div className="h-full bg-amber-500 animate-progress" />
          </div>
        )}

        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2 min-w-0">
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
                onClick={(e) => e.stopPropagation()}
                className="text-sm font-semibold bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-white outline-none focus:border-blue-500 max-w-[180px]"
              />
            ) : (
              <>
                <h3 className="text-sm font-semibold text-gray-100 truncate group-hover:text-white">
                  {session.config.name}
                </h3>
                <button
                  onClick={(e) => { e.stopPropagation(); setRenameValue(session.config.name); setIsRenaming(true); }}
                  className="text-gray-600 hover:text-gray-300 transition-colors shrink-0"
                  title="Rename"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
                {session.summary && <SummaryTooltip summary={session.summary} />}
              </>
            )}
            <StatusBadge status={session.status} />
            {session.origin === 'vscode' && (
              <span className="text-[10px] text-purple-400 bg-purple-400/10 px-1.5 py-0.5 rounded">VS Code</span>
            )}
            {session.config.isScratch && (
              <span className="text-[10px] text-amber-300 bg-amber-400/10 px-1.5 py-0.5 rounded">📝 Scratch</span>
            )}
            <PermissionModeSelector
              mode={session.permissionMode}
              onChange={(mode) => setPermissionMode(session.id, mode)}
              compact
            />
          </div>
          <span className="text-xs text-gray-500 shrink-0">{formatTimeAgo(session.lastActiveAt)}</span>
        </div>

        <div className="text-xs text-gray-500 truncate mb-2">{session.config.cwd}</div>

        {isWorking && <WorkingIndicator activity={session.currentToolActivity} />}

        <div className="flex items-center justify-between text-xs text-gray-600">
          <span>{session.messages.filter(m => m.role !== 'system').length} messages</span>
        </div>
      </button>
      <ContextBar usage={session.contextUsage} sessionId={session.id} />
    </div>
  );
}

// ─── History: 36+ hours. Minimal row. ─────────────────────────────────────────

function HistorySessionCard({ session, onClick }: { session: SessionState; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-gray-900/60 border border-gray-800/60 rounded-lg px-4 py-2.5 hover:border-gray-600 transition-colors cursor-pointer group flex items-center gap-3"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm text-gray-300 truncate group-hover:text-white">
            {session.config.name}
          </h3>
          {session.summary && <SummaryTooltip summary={session.summary} />}
        </div>
        <div className="text-xs text-gray-600 truncate">{session.config.cwd}</div>
      </div>
      <div className="text-xs text-gray-600 shrink-0">
        {formatDate(session.lastActiveAt)}
      </div>
    </button>
  );
}

// ─── Shared context usage bar ────────────────────────────────────────────────

function ContextBar({ usage, sessionId }: { usage: ContextUsage | null; sessionId: string }) {
  const { compactSession } = useSessions();
  if (!usage || !usage.contextWindow) return null;

  const totalUsed = usage.inputTokens + usage.outputTokens;
  const pct = Math.min(100, Math.round((totalUsed / usage.contextWindow) * 100));
  const barColor = pct >= 80 ? 'bg-red-500' : pct >= 50 ? 'bg-amber-500' : 'bg-blue-500';
  const textColor = pct >= 80 ? 'text-red-400' : pct >= 50 ? 'text-amber-400' : 'text-gray-500';

  return (
    <div className="flex items-center gap-2 px-4 py-1 shrink-0">
      <div className="flex-1 h-1 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full ${barColor} rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-[10px] ${textColor} shrink-0`}>{pct}%</span>
      <button
        onClick={(e) => { e.stopPropagation(); compactSession(sessionId); }}
        className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors shrink-0"
      >
        Compact
      </button>
    </div>
  );
}

// ─── Shared working indicator ─────────────────────────────────────────────────

function WorkingIndicator({ activity }: { activity: SessionState['currentToolActivity'] }) {
  return (
    <div className="py-1.5">
      <div className="flex items-center gap-2 text-xs text-amber-400">
        <span className="flex gap-0.5">
          <span className="w-1 h-1 rounded-full bg-amber-400 animate-bounce [animation-delay:0ms]" />
          <span className="w-1 h-1 rounded-full bg-amber-400 animate-bounce [animation-delay:150ms]" />
          <span className="w-1 h-1 rounded-full bg-amber-400 animate-bounce [animation-delay:300ms]" />
        </span>
        {activity ? (
          <span className="truncate">
            <span className="font-medium">{activity.toolName}</span>
            {activity.description && (
              <span className="text-amber-400/70 ml-1">{activity.description}</span>
            )}
          </span>
        ) : (
          <span>Thinking...</span>
        )}
      </div>
    </div>
  );
}
