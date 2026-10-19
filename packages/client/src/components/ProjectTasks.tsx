import { useState, useRef, useEffect } from 'react';
import type { SessionState, EffortLevel } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';
import { ModelEffortSelector, MODELS } from './ModelEffortSelector';
import { projectIdOf, tasksOf } from '../lib/projects';

// The task bar: a project's main session and its tasks (server/src/project.ts), each a session of
// its own working in the same folder, possibly at the same time. Sits just above the message box,
// so it's always clear which conversation a message goes to.

const MAX_TASKS = 12; // MAX_TASKS_PER_PROJECT on the server

export function StatusDot({ s, unread }: { s: SessionState; unread: boolean }) {
  if (s.status === 'working') return <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" title="Working" />;
  if (s.waitingFor) return <span className="h-1.5 w-1.5 rounded-full bg-amber-300 ring-2 ring-amber-500/40 shrink-0" title="Needs you" />;
  if (s.status === 'error') return <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" title="Stopped on an error" />;
  if (unread) return <span className="h-1.5 w-1.5 rounded-full bg-red-500 shrink-0" title="Unread" />;
  return <span className="h-1.5 w-1.5 rounded-full bg-gray-600 shrink-0" />;
}

/** The buttons for a project's sessions. Rename and delete are offered on the current one when
 *  `onRename` / `onDelete` are given (the owner's view; a guest only switches). */
export function TaskChips({ main, tasks, activeId, onSelect, isUnread, onRename, onDelete }: {
  main: SessionState;
  tasks: SessionState[];
  activeId: string;
  onSelect: (id: string) => void;
  isUnread: (s: SessionState) => boolean;
  onRename?: (id: string, name: string) => void;
  onDelete?: (task: SessionState) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const submit = () => {
    const name = value.trim();
    if (renaming && name && onRename) onRename(renaming, name);
    setRenaming(null);
  };
  return (
    <>
      {[main, ...tasks].map(s => {
        const active = s.id === activeId;
        const isMain = s.id === main.id;
        if (renaming === s.id) {
          return (
            <input
              key={s.id}
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onBlur={submit}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setRenaming(null); }}
              maxLength={80}
              className="shrink-0 w-40 text-xs bg-gray-800 border border-gray-600 rounded px-1.5 py-1 text-white outline-none focus:border-blue-500"
            />
          );
        }
        return (
          <span key={s.id} className={`shrink-0 inline-flex items-center rounded-md border ${active ? 'bg-gray-800 border-gray-600' : 'border-transparent hover:bg-gray-800/60'}`}>
            <button
              onClick={() => onSelect(s.id)}
              className={`inline-flex items-center gap-1.5 max-w-[13rem] text-xs pl-2 ${active && (onRename || onDelete) ? 'pr-1' : 'pr-2'} py-1 min-h-[30px] ${active ? 'text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}
              title={isMain ? `Main session: ${s.config.name}. It does the check-ins (commits).` : s.config.name}
            >
              <StatusDot s={s} unread={!active && isUnread(s)} />
              <span className="truncate">{isMain ? 'Main' : s.config.name}</span>
            </button>
            {active && onRename && (
              <button
                onClick={() => { setRenaming(s.id); setValue(s.config.name); }}
                className="px-1 py-1 text-[11px] text-gray-500 hover:text-gray-200"
                title={isMain ? 'Rename the project' : 'Rename this task'}
                aria-label="Rename"
              >✎</button>
            )}
            {active && !isMain && onDelete && (
              <button
                onClick={() => onDelete(s)}
                className="pl-0.5 pr-1.5 py-1 text-[11px] text-gray-500 hover:text-red-400"
                title="Close this task (a summary of its work is kept)"
                aria-label={`Close ${s.config.name}`}
              >✕</button>
            )}
          </span>
        );
      })}
    </>
  );
}

/** The owner's task bar, with "+ New task". */
export function ProjectTaskBar({ session, onSwitchSession }: { session: SessionState; onSwitchSession: (id: string) => void }) {
  const { state, createTask, renameSession, closeTask, isUnread, logEvent } = useSessions();
  const mainId = projectIdOf(session);
  const main = state.sessions.get(mainId) ?? session;
  const tasks = tasksOf(mainId, state.sessions.values());
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [what, setWhat] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<EffortLevel>('medium');
  const wrapRef = useRef<HTMLDivElement>(null);
  /** The task just asked for: switch to it as soon as the server says it exists. */
  const awaiting = useRef<{ name: string; known: Set<string> } | null>(null);

  useEffect(() => {
    const a = awaiting.current;
    if (!a) return;
    const made = tasks.find(t => !a.known.has(t.id) && t.config.name === a.name);
    if (made) { awaiting.current = null; onSwitchSession(made.id); }
  }, [tasks, onSwitchSession]);

  // Close the form on an outside click or Escape.
  useEffect(() => {
    if (!creating) return;
    const onDown = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setCreating(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setCreating(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [creating]);

  if (main.config.isScratch) return null;

  const open = () => {
    setName('');
    setWhat('');
    setModel(MODELS.some(m => m.id === main.config.model) ? main.config.model! : 'claude-sonnet-5-5');
    setEffort(main.config.effort ?? 'medium');
    setCreating(true);
  };
  const start = () => {
    const n = name.trim();
    if (!n) return;
    logEvent('task_create', { withMessage: !!what.trim(), model });
    awaiting.current = { name: n.slice(0, 80), known: new Set(tasks.map(t => t.id)) };
    createTask(mainId, n, model, effort, what.trim() || undefined);
    setCreating(false);
  };
  const remove = (task: SessionState) => {
    if (task.status === 'working') { alert(`"${task.config.name}" is working. Stop it or let it finish, then close it.`); return; }
    if (!confirm(`Close the task "${task.config.name}"?\n\nA summary of its work is written and kept on the project's notes board and task list. Its conversation is deleted; changes it made to files stay.`)) return;
    if (task.id === session.id) onSwitchSession(mainId);
    closeTask(task.id);
  };

  return (
    <div className="relative shrink-0 border-t border-gray-800/60 bg-gray-900/30" ref={wrapRef}>
      <div className="px-3 sm:px-4 py-1 flex items-center gap-1 overflow-x-auto">
        <span className="text-[10px] uppercase tracking-wider text-gray-500 shrink-0 mr-1">Tasks</span>
        {tasks.length > 0 && (
          <TaskChips
            main={main}
            tasks={tasks}
            activeId={session.id}
            onSelect={(id) => { if (id !== session.id) { logEvent('task_switch'); onSwitchSession(id); } }}
            isUnread={isUnread}
            onRename={(id, n) => renameSession(id, n)}
            onDelete={remove}
          />
        )}
        <button
          onClick={() => (creating ? setCreating(false) : open())}
          disabled={tasks.length >= MAX_TASKS}
          className="shrink-0 text-xs px-2 py-1 min-h-[30px] rounded-md text-blue-300 hover:text-blue-200 hover:bg-gray-800/60 disabled:opacity-40 disabled:cursor-not-allowed"
          title={tasks.length >= MAX_TASKS ? `A project can have up to ${MAX_TASKS} tasks` : 'Start a task: another session working in this folder, alongside this one'}
        >
          + New task
        </button>
        {tasks.length === 0 && (
          <span className="shrink-0 text-[11px] text-gray-600 hidden sm:inline">or type <span className="font-mono text-gray-500">/task</span> to spin this work off</span>
        )}
      </div>

      {creating && (
        <div className="absolute bottom-full left-2 sm:left-4 mb-1 z-50 w-[min(360px,calc(100vw-1rem))] bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-3 space-y-2.5">
          <div className="text-[11px] text-gray-400 leading-snug">
            A task is another Claude session in this project's folder. It can work at the same time as this one, and checks its work in with the main session, which does the commits.
          </div>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') start(); }}
            placeholder="Task name, e.g. Ghost pathing"
            maxLength={80}
            className="w-full text-sm text-gray-100 bg-gray-800 border border-gray-600 rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          />
          <textarea
            value={what}
            onChange={(e) => setWhat(e.target.value)}
            rows={3}
            placeholder="What should it do? (optional; it starts on this right away)"
            className="w-full resize-y text-xs text-gray-200 bg-gray-800 border border-gray-600 rounded px-2 py-1.5 placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <div className="flex items-center gap-2 text-[11px] text-gray-500">
            <span className="shrink-0">Runs on</span>
            <ModelEffortSelector model={model} effort={effort} onModelChange={setModel} onEffortChange={(e) => setEffort(e ?? 'medium')} />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setCreating(false)} className="px-2.5 py-1.5 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
            <button
              onClick={start}
              disabled={!name.trim()}
              className="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded"
            >
              Start task
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
