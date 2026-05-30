import { useState, useRef, useEffect } from 'react';
import type { SessionState } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';
import { MessageList } from './MessageList';
import { PromptInput } from './PromptInput';
import { StatusBadge } from './StatusBadge';
import { PermissionModeSelector } from './PermissionModeSelector';
import { FileBrowser } from './FileBrowser';
import { DebugLogView } from './DebugLogView';
import { ModelSelector } from './ModelSelector';
import { EffortSelector } from './EffortSelector';
import { WakeupBanner } from './WakeupBanner';
import { WatchPanel } from './WatchPanel';
import { PlanBanner } from './PlanBanner';

interface SessionViewProps {
  session: SessionState;
  allSessions: SessionState[];
  onBack: () => void;
  onSwitchSession: (id: string) => void;
  draft: string;
  onDraftChange: (v: string) => void;
}

export function SessionView({ session, allSessions, onBack, onSwitchSession, draft, onDraftChange }: SessionViewProps) {
  const { sendMessage, interruptSession, destroySession, compactSession, resetSession, setPermissionMode, setModel, setEffort, renameSession, updateCwd, generateSummary, respondToPermission, dequeueMessage, cancelWakeup, respondToPlan, clearSession, state } = useSessions();
  const isWorking = session.status === 'working';
  const [activeTab, setActiveTab] = useState<'chat' | 'files' | 'summary' | 'debug'>('chat');
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.config.name);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [isEditingCwd, setIsEditingCwd] = useState(false);
  const [cwdValue, setCwdValue] = useState(session.config.cwd);
  const cwdInputRef = useRef<HTMLInputElement>(null);
  const [generatingSummary, setGeneratingSummary] = useState(false);

  // Clear loading state when summary arrives
  const summaryRef = useRef(session.summary);
  useEffect(() => {
    if (session.summary !== summaryRef.current) {
      summaryRef.current = session.summary;
      setGeneratingSummary(false);
    }
  }, [session.summary]);

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

  useEffect(() => {
    if (isEditingCwd && cwdInputRef.current) {
      cwdInputRef.current.focus();
      cwdInputRef.current.select();
    }
  }, [isEditingCwd]);

  const handleCwdSubmit = () => {
    const trimmed = cwdValue.trim();
    if (trimmed && trimmed !== session.config.cwd) {
      updateCwd(session.id, trimmed);
    }
    setIsEditingCwd(false);
  };

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

  // Only show active sessions (working or active in last hour) in tabs, sorted alphabetically.
  // Scratch is pulled out so it always appears first regardless of activity.
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const now = Date.now();
  const scratchSession = allSessions.find(s => s.config.isScratch);
  const sortedSessions = allSessions
    .filter(s => !s.config.isScratch && (s.id === session.id || s.status === 'working' || (now - new Date(s.lastActiveAt).getTime()) < ONE_HOUR_MS))
    .sort((a, b) => a.config.name.localeCompare(b.config.name));

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Session switcher tabs */}
      <div className="flex items-center bg-gray-900 border-b border-gray-800 shrink-0 overflow-x-auto">
        <button
          onClick={onBack}
          className="px-3 py-2 text-gray-500 hover:text-gray-200 text-xs transition-colors shrink-0 border-r border-gray-800"
        >
          &larr;
        </button>
        {/* Scratch tab — always present, regardless of activity */}
        {scratchSession && (
          <button
            key={scratchSession.id}
            onClick={() => onSwitchSession(scratchSession.id)}
            title="Scratch (Cmd/Ctrl+Shift+S)"
            className={`px-3 py-2 text-xs font-medium transition-colors shrink-0 flex items-center gap-1.5 border-b-2 border-r border-r-gray-800 ${
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
        {sortedSessions.map((s) => (
          <button
            key={s.id}
            onClick={() => onSwitchSession(s.id)}
            className={`px-3 py-2 text-xs font-medium transition-colors shrink-0 flex items-center gap-1.5 border-b-2 ${
              s.id === session.id
                ? 'text-blue-400 border-blue-400'
                : 'text-gray-500 hover:text-gray-300 border-transparent'
            }`}
          >
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
            <span className="truncate max-w-[120px]">{s.config.name}</span>
          </button>
        ))}
      </div>

      {/* Working progress bar */}
      {isWorking && (
        <div className="h-0.5 bg-gray-800 overflow-hidden shrink-0">
          <div className="h-full bg-amber-500 animate-progress" />
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-800 bg-gray-900/50 shrink-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
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
                className="text-sm font-semibold bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 text-white outline-none focus:border-blue-500 max-w-[200px]"
              />
            ) : (
              <h2
                className="text-sm font-semibold truncate cursor-pointer hover:text-blue-400 transition-colors"
                onClick={() => { setRenameValue(session.config.name); setIsRenaming(true); }}
                title="Click to rename"
              >
                {session.config.name}
              </h2>
            )}
            <StatusBadge status={session.status} />
            {session.origin === 'vscode' && (
              <span className="text-[10px] text-purple-400 bg-purple-400/10 px-1.5 py-0.5 rounded">VS Code</span>
            )}
            {session.config.controllerMode && (
              <span
                className="text-[10px] text-purple-300 bg-purple-500/20 border border-purple-500/40 px-1.5 py-0.5 rounded"
                title="This session can orchestrate other sessions via MCP tools"
              >
                Controller
              </span>
            )}
            <ModelSelector
              model={session.config.model}
              onChange={(model) => setModel(session.id, model)}
            />
            <EffortSelector
              effort={session.config.effort}
              onChange={(effort) => setEffort(session.id, effort || '')}
            />
            <PermissionModeSelector
              mode={session.permissionMode}
              onChange={(mode) => setPermissionMode(session.id, mode)}
            />
          </div>
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
              className="text-xs text-gray-400 bg-gray-800 border border-gray-600 rounded px-1.5 py-0.5 w-full focus:outline-none focus:border-blue-500"
            />
          ) : (
            <div
              className="text-xs text-gray-500 truncate cursor-pointer hover:text-gray-400 transition-colors"
              onClick={() => { setCwdValue(session.config.cwd); setIsEditingCwd(true); }}
              title="Click to edit working directory"
            >
              {session.config.cwd}
            </div>
          )}
        </div>
        {contextPct !== null && (
          <div className="flex items-center gap-1.5">
            <div className="w-16 h-1.5 bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  contextPct >= 80 ? 'bg-red-500' : contextPct >= 50 ? 'bg-amber-500' : 'bg-blue-500'
                }`}
                style={{ width: `${contextPct}%` }}
              />
            </div>
            <span
              className={`text-[10px] cursor-help ${
                contextPct >= 80 ? 'text-red-400' : contextPct >= 50 ? 'text-amber-400' : 'text-gray-500'
              }`}
              title={session.contextUsage ? `In: ${session.contextUsage.inputTokens.toLocaleString()} / Out: ${session.contextUsage.outputTokens.toLocaleString()} / Window: ${session.contextUsage.contextWindow.toLocaleString()} tokens` : undefined}
            >
              {contextPct}%
            </span>
            <button
              onClick={() => compactSession(session.id)}
              className="text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
            >
              Compact
            </button>
          </div>
        )}
        {session.config.isScratch ? (
          <button
            onClick={() => {
              if (confirm('Clear scratch conversation? This cannot be undone.')) {
                clearSession(session.id);
              }
            }}
            className="text-xs text-amber-400 hover:text-amber-300 transition-colors"
            title="Wipe the scratch conversation. The session itself stays."
          >
            Clear
          </button>
        ) : (
          <button
            onClick={() => {
              if (confirm('Destroy this session?')) {
                destroySession(session.id);
                onBack();
              }
            }}
            className="text-xs text-red-400 hover:text-red-300 transition-colors"
          >
            Destroy
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-gray-800 shrink-0">
        <button
          onClick={() => setActiveTab('chat')}
          className={`px-4 py-2 text-xs font-medium transition-colors ${
            activeTab === 'chat'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Chat
        </button>
        <button
          onClick={() => setActiveTab('files')}
          className={`px-4 py-2 text-xs font-medium transition-colors ${
            activeTab === 'files'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Files
        </button>
        <button
          onClick={() => setActiveTab('summary')}
          className={`px-4 py-2 text-xs font-medium transition-colors ${
            activeTab === 'summary'
              ? 'text-blue-400 border-b-2 border-blue-400'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          Summary
        </button>
        <button
          onClick={() => setActiveTab('debug')}
          className={`px-4 py-2 text-xs font-medium transition-colors ${
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
            <div className="px-4 py-2 border-b border-gray-800/50 bg-gray-900/30 shrink-0">
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

          {/* Plan awaiting accept/reject */}
          {state.pendingPlans.has(session.id) && (
            <PlanBanner
              plan={state.pendingPlans.get(session.id)!}
              onAccept={(feedback) => respondToPlan(session.id, state.pendingPlans.get(session.id)!.toolUseId, 'accept', feedback)}
              onReject={(feedback) => respondToPlan(session.id, state.pendingPlans.get(session.id)!.toolUseId, 'reject', feedback)}
            />
          )}

          {/* Auth expired banner */}
          {session.error === 'AUTH_EXPIRED' && (
            <div className="mx-4 mt-2 px-3 py-2 bg-amber-900/30 border border-amber-700 rounded text-xs text-amber-200 shrink-0 flex items-center justify-between gap-2">
              <span>Claude authentication expired. Re-login required.</span>
              <button
                onClick={async () => {
                  try {
                    await fetch('/api/claude-auth/login', { method: 'POST' });
                  } catch {}
                }}
                className="px-2.5 py-1 bg-amber-700 hover:bg-amber-600 text-white rounded transition-colors whitespace-nowrap"
              >
                Re-authenticate
              </button>
            </div>
          )}

          {/* Error banner */}
          {session.error && session.error !== 'AUTH_EXPIRED' && (
            <div className="mx-4 mt-2 px-3 py-2 bg-red-900/30 border border-red-800 rounded text-xs text-red-300 shrink-0 flex items-center justify-between gap-2">
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

          {/* Messages */}
          <MessageList messages={session.messages} sessionId={session.id} />

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
            onSend={(msg, images, planMode) => sendMessage(session.id, msg, images, planMode)}
            onInterrupt={() => interruptSession(session.id)}
            isWorking={isWorking}
            draft={draft}
            onDraftChange={onDraftChange}
          />
        </>
      ) : activeTab === 'files' ? (
        <FileBrowser cwd={session.config.cwd} />
      ) : activeTab === 'debug' ? (
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Session metadata bar */}
          <div className="flex items-center gap-4 px-4 py-2 border-b border-gray-800 text-[11px] text-gray-500 shrink-0">
            {session.config.model && <span>Model: <span className="text-gray-400">{session.config.model}</span></span>}
            {session.sdkSessionId && <span>SDK: <span className="text-gray-400 font-mono">{session.sdkSessionId.slice(0, 12)}...</span></span>}
            {session.config.maxTurns && <span>Max turns: <span className="text-gray-400">{session.config.maxTurns}</span></span>}
            <span>Cost: <span className="text-gray-400">${session.totalCostUsd.toFixed(4)}</span></span>
          </div>
          <DebugLogView entries={session.debugLog} />
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
    </div>
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
          className={`${compact ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'} bg-green-700 hover:bg-green-600 text-white font-medium rounded transition-colors`}
        >
          Allow
        </button>
        <button
          onClick={onDeny}
          className={`${compact ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs'} bg-red-800 hover:bg-red-700 text-white font-medium rounded transition-colors`}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

export { PermissionPrompt, formatToolInput };
