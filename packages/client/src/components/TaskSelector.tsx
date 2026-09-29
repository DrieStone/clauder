import { useState, useRef, useEffect } from 'react';
import type { SessionState, EffortLevel } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';
import { ModelEffortSelector, MODELS } from './ModelEffortSelector';
import { usePopoverPlacement } from '../lib/popoverPosition';

function relativeTime(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

const modelLabel = (id?: string | null) =>
  id ? (MODELS.find(m => m.id === id)?.label ?? id.replace(/^claude-/, '')) : null;

/** What the New-task form starts on: the session's current model/effort, falling back to the same
 *  defaults ModelEffortSelector displays — so what you see is what the task gets. */
const startingModel = (s: SessionState) => (MODELS.some(m => m.id === s.config.model) ? s.config.model! : 'claude-sonnet-5-5');
const startingEffort = (s: SessionState): EffortLevel => s.config.effort ?? 'medium';

/** The session's tasks, replacing the old park/resume bar. Each task is its own conversation (a
 *  parked thread server-side, carrying its own model and effort); "+ New task" names one and picks
 *  its starting model — the one moment a model change is free, since a new conversation has no
 *  prompt cache to lose. Switching is bookkeeping only: no CLI spawn, no quota. */
export function TaskSelector({ session, isWorking }: { session: SessionState; isWorking: boolean }) {
  const { startTask, resumeThread, discardThread, renameThread, logEvent } = useSessions();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newModel, setNewModel] = useState(() => startingModel(session));
  const [newEffort, setNewEffort] = useState<EffortLevel>(() => startingEffort(session));
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const placement = usePopoverPlacement(wrapRef, open, 340);
  const tasks = session.threads ?? [];

  // Close on outside click / Escape; drop any half-finished edit when closed.
  useEffect(() => {
    if (!open) { setCreating(false); setRenamingId(null); setConfirmingDelete(null); return; }
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // Same guard as the server's assertCanSwitchThread.
  const blocked = isWorking
    ? 'Finish or stop the current turn before switching tasks.'
    : session.waitingFor || session.pendingPermission
      ? 'Answer the pending question or permission before switching tasks.'
      : null;

  const beginNewTask = () => {
    setNewName('');
    setNewModel(startingModel(session));
    setNewEffort(startingEffort(session));
    setCreating(true);
  };

  const submitNewTask = () => {
    const name = newName.trim();
    if (!name || blocked) return;
    logEvent('task_new', { model: newModel, effort: newEffort });
    startTask(session.id, name, newModel, newEffort);
    setOpen(false);
  };

  const switchTo = (threadId: string) => {
    if (blocked) return;
    logEvent('task_switch');
    resumeThread(session.id, threadId);
    setOpen(false);
  };

  const beginRename = (id: string, current: string) => {
    setRenamingId(id);
    setRenameValue(current);
    setConfirmingDelete(null);
  };
  const submitRename = () => {
    const name = renameValue.trim();
    if (renamingId && name) renameThread(session.id, renamingId, name);
    setRenamingId(null);
  };

  const currentName = session.activeThreadName ?? 'Untitled task';
  const currentCount = session.messageCount ?? session.messages.length;
  const currentModel = modelLabel(session.config.model);

  const renameInput = (
    <input
      autoFocus
      value={renameValue}
      onChange={(e) => setRenameValue(e.target.value)}
      onBlur={submitRename}
      onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenamingId(null); }}
      className="w-full text-sm text-gray-100 bg-gray-800 border border-gray-600 rounded px-1.5 py-1 focus:outline-none focus:border-blue-500"
    />
  );

  return (
    <div className="px-3 sm:px-4 py-0.5 border-b border-gray-800/50 bg-gray-900/30 shrink-0">
      <div className="relative inline-block max-w-full" ref={wrapRef}>
        <button
          onClick={() => { if (!open) logEvent('task_selector_open'); setOpen(o => !o); }}
          className="flex items-center gap-1.5 min-h-[36px] max-w-full text-xs text-gray-300 hover:text-gray-100 transition-colors"
          title="Switch task"
        >
          <span className="text-gray-500 shrink-0">Task</span>
          <span className="font-medium truncate">{currentName}</span>
          {tasks.length > 0 && (
            <span className="shrink-0 text-[10px] text-gray-400 bg-gray-800 rounded px-1 leading-4">{tasks.length + 1}</span>
          )}
          <span className="shrink-0 text-gray-500">▾</span>
        </button>

        {open && (
          <div
            className="absolute left-0 top-full mt-1 z-50 w-[340px] bg-gray-900 border border-gray-700 rounded-lg shadow-xl overflow-hidden"
            style={placement ?? undefined}
          >
            {blocked && (
              <div className="px-3 py-2 text-[11px] text-amber-300 bg-amber-950/30 border-b border-gray-800">{blocked}</div>
            )}

            {creating ? (
              <div className="p-3 border-b border-gray-800 space-y-2.5">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitNewTask(); if (e.key === 'Escape') setCreating(false); }}
                  placeholder="Name the task…"
                  className="w-full text-sm text-gray-100 bg-gray-800 border border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
                />
                <div className="flex items-center gap-2 text-[11px] text-gray-500">
                  <span className="shrink-0">Starts on</span>
                  <ModelEffortSelector
                    model={newModel}
                    effort={newEffort}
                    onModelChange={setNewModel}
                    onEffortChange={(e) => setNewEffort(e ?? 'medium')}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button onClick={() => setCreating(false)} className="px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
                  <button
                    onClick={submitNewTask}
                    disabled={!newName.trim() || !!blocked}
                    className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded"
                  >
                    Start task
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={beginNewTask}
                disabled={!!blocked}
                className="w-full text-left px-3 min-h-[44px] text-sm font-medium text-blue-300 hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed border-b border-gray-800"
              >
                + New task
              </button>
            )}

            <div className="max-h-[50vh] overflow-y-auto">
              <div className="px-3 py-2 min-h-[44px] border-b border-gray-800 flex items-center gap-2 bg-gray-800/40">
                <span className="w-3 shrink-0 text-green-400" aria-label="Current task">✓</span>
                <div className="flex-1 min-w-0">
                  {renamingId === session.activeThreadId ? renameInput : (
                    <div className="text-sm text-gray-100 truncate">{currentName}</div>
                  )}
                  <div className="text-[11px] text-gray-500 truncate">
                    current · {currentCount} msg{currentCount !== 1 ? 's' : ''}{currentModel ? ` · ${currentModel}` : ''}
                  </div>
                </div>
                <button
                  onClick={() => beginRename(session.activeThreadId, session.activeThreadName ?? '')}
                  className="p-1.5 text-gray-500 hover:text-gray-200 shrink-0"
                  title="Rename task"
                  aria-label="Rename current task"
                >
                  ✎
                </button>
              </div>

              {tasks.map((t) => (
                <div key={t.id} className="px-3 py-2 min-h-[44px] border-b border-gray-800 last:border-b-0 flex items-center gap-2">
                  <span className="w-3 shrink-0" />
                  <div className="flex-1 min-w-0">
                    {renamingId === t.id ? renameInput : (
                      <button
                        onClick={() => switchTo(t.id)}
                        disabled={!!blocked}
                        className="block w-full text-left disabled:cursor-not-allowed"
                        title={blocked ?? (t.preview || `Switch to "${t.name}"`)}
                      >
                        <div className="text-sm text-gray-200 truncate hover:text-white">{t.name}</div>
                        <div className="text-[11px] text-gray-500 truncate">
                          {t.messageCount} msg{t.messageCount !== 1 ? 's' : ''} · {relativeTime(t.lastActiveAt)}
                          {modelLabel(t.model) ? ` · ${modelLabel(t.model)}` : ''}
                        </div>
                      </button>
                    )}
                  </div>
                  {confirmingDelete === t.id ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <span className="text-[11px] text-gray-400">Delete?</span>
                      <button
                        onClick={() => { discardThread(session.id, t.id); setConfirmingDelete(null); }}
                        className="px-2 py-1 text-xs bg-red-800 hover:bg-red-700 text-white rounded"
                      >
                        Yes
                      </button>
                      <button onClick={() => setConfirmingDelete(null)} className="px-2 py-1 text-xs text-gray-400 hover:text-gray-200">No</button>
                    </div>
                  ) : (
                    <div className="flex items-center shrink-0">
                      <button onClick={() => beginRename(t.id, t.name)} className="p-1.5 text-gray-500 hover:text-gray-200" title="Rename task" aria-label={`Rename ${t.name}`}>✎</button>
                      <button onClick={() => setConfirmingDelete(t.id)} className="p-1.5 text-gray-500 hover:text-red-400" title="Delete task" aria-label={`Delete ${t.name}`}>🗑</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
