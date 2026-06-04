import { useState } from 'react';
import type { Trigger, ProjectRun, RunStatus } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';

interface Props { onClose: () => void }

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatLocal(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return iso; }
}
function localToISO(local: string): string { return new Date(local).toISOString(); }
function defaultDT(): string {
  const d = new Date(Date.now() + 3600_000);
  const p = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ─── Scheduled tab ──────────────────────────────────────────────────────────

function formatInterval(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} day${seconds / 86400 !== 1 ? 's' : ''}`;
  if (seconds % 3600 === 0)  return `${seconds / 3600} hour${seconds / 3600 !== 1 ? 's' : ''}`;
  return `${Math.round(seconds / 60)} min`;
}

function ScheduledTab() {
  const { state } = useSessions();
  const sessions = Array.from(state.sessions.values());
  const triggers = Array.from(state.triggers.values());
  const [creating, setCreating] = useState(false);
  const [sessionId, setSessionId] = useState(sessions[0]?.id || '');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState('');
  const [when, setWhen] = useState(defaultDT());
  // Repeat controls
  const [repeat, setRepeat] = useState(false);
  const [repeatEvery, setRepeatEvery] = useState('1');
  const [repeatUnit, setRepeatUnit] = useState<'minutes' | 'hours' | 'days'>('hours');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const scheduled = triggers
    .filter((t: Trigger) => t.source === 'scheduled')
    .sort((a: Trigger, b: Trigger) => {
      const ms = (t: Trigger) => t.schedule.type === 'once' ? new Date(t.schedule.at).getTime() : new Date(t.schedule.nextAt).getTime();
      return ms(a) - ms(b);
    });

  const sessionName = (id: string) => sessions.find(s => s.id === id)?.config.name || id.slice(0, 8);

  const intervalSeconds = () => {
    const n = Math.max(1, Number(repeatEvery) || 1);
    if (repeatUnit === 'minutes') return n * 60;
    if (repeatUnit === 'hours')   return n * 3600;
    return n * 86400;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!sessionId || !message.trim() || !when) { setError('Session, message, and time are required'); return; }
    const firstAt = localToISO(when);
    if (new Date(firstAt).getTime() < Date.now()) { setError('Scheduled time must be in the future'); return; }
    const schedule = repeat
      ? { type: 'recurring', intervalSeconds: intervalSeconds(), nextAt: firstAt }
      : { type: 'once', at: firstAt };
    setSubmitting(true);
    try {
      const res = await fetch('/api/triggers', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: message.trim(), description: description.trim() || 'Scheduled task', schedule, source: 'scheduled' }),
      });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      setCreating(false); setMessage(''); setDescription(''); setWhen(defaultDT()); setRepeat(false);
    } catch (err: any) { setError(err.message); }
    finally { setSubmitting(false); }
  };

  const handleRemove = async (id: string) => { try { await fetch(`/api/triggers/${id}`, { method: 'DELETE' }); } catch {} };

  const inputCls = 'bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500';

  return (
    <div className="space-y-3">
      {scheduled.length === 0 && !creating && (
        <div className="text-sm text-gray-500 text-center py-8">No scheduled tasks. Create one below to fire a message to a session at a specific time.</div>
      )}
      {scheduled.map((t: Trigger) => (
        <div key={t.id} className="bg-gray-800/60 border border-gray-700 rounded-lg p-3 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium text-gray-100">{t.description}</span>
              <span className="text-[10px] text-blue-300 bg-blue-500/20 px-1.5 py-0.5 rounded">→ {sessionName(t.sessionId)}</span>
              {t.schedule.type === 'recurring' && (
                <span className="text-[10px] text-purple-300 bg-purple-500/20 px-1.5 py-0.5 rounded">↻ every {formatInterval(t.schedule.intervalSeconds)}</span>
              )}
            </div>
            <div className="text-xs text-gray-400 mt-1">
              {t.schedule.type === 'once'
                ? `Fires at ${formatLocal(t.schedule.at)}`
                : `Next: ${formatLocal(t.schedule.nextAt)}`}
            </div>
            <div className="text-xs text-gray-500 italic mt-1 truncate" title={t.message}>"{t.message}"</div>
          </div>
          <button onClick={() => handleRemove(t.id)} className="text-red-400 hover:text-red-300 text-xs px-2 py-1 hover:bg-red-900/30 rounded transition-colors shrink-0">Delete</button>
        </div>
      ))}
      {creating ? (
        <form onSubmit={handleSubmit} className="bg-gray-800/40 border border-blue-700/50 rounded-lg p-3 space-y-2">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Target Session</label>
            <select value={sessionId} onChange={e => setSessionId(e.target.value)} className={`w-full ${inputCls}`}>
              {sessions.map(s => <option key={s.id} value={s.id}>{s.config.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Description</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Start overnight refactor" className={`w-full ${inputCls}`} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">{repeat ? 'First fires at' : 'When'}</label>
            <input type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} className={`w-full ${inputCls}`} />
          </div>
          {/* Repeat toggle */}
          <div className="flex items-center gap-3 pt-0.5">
            <label className="flex items-center gap-1.5 text-sm text-gray-300 cursor-pointer select-none">
              <input type="checkbox" checked={repeat} onChange={e => setRepeat(e.target.checked)} className="accent-blue-500" />
              Repeat every
            </label>
            {repeat && (
              <>
                <input
                  type="number" min="1" value={repeatEvery}
                  onChange={e => setRepeatEvery(e.target.value)}
                  className="w-16 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-500"
                />
                <select
                  value={repeatUnit}
                  onChange={e => setRepeatUnit(e.target.value as 'minutes' | 'hours' | 'days')}
                  className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm focus:outline-none focus:border-blue-500"
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                </select>
              </>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Message to send</label>
            <textarea value={message} onChange={e => setMessage(e.target.value)} placeholder="The message that will be sent to the session at the scheduled time" rows={3} className={`w-full ${inputCls} resize-none`} />
          </div>
          {error && <div className="text-xs text-red-400">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => { setCreating(false); setError(null); }} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
            <button type="submit" disabled={submitting} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded disabled:opacity-50">{submitting ? 'Scheduling…' : 'Schedule'}</button>
          </div>
        </form>
      ) : (
        <button onClick={() => setCreating(true)} disabled={sessions.length === 0} className="w-full px-3 py-2 bg-blue-600/20 hover:bg-blue-600/40 border border-blue-600/50 text-blue-300 text-sm rounded-lg transition-colors disabled:opacity-50">
          + Schedule a new task
        </button>
      )}
    </div>
  );
}

// ─── Overnight Runs tab ─────────────────────────────────────────────────────

function statusStyle(status: RunStatus): { label: string; cls: string } {
  switch (status) {
    case 'negotiating': return { label: 'Negotiating', cls: 'text-purple-300 bg-purple-900/40 border-purple-700/50' };
    case 'running':     return { label: 'Running',     cls: 'text-blue-300   bg-blue-900/40   border-blue-700/50'   };
    case 'paused':      return { label: 'Paused',      cls: 'text-amber-300  bg-amber-900/40  border-amber-700/50'  };
    case 'blocked':     return { label: 'Needs you',   cls: 'text-orange-300 bg-orange-900/40 border-orange-700/50' };
    case 'done':        return { label: 'Done',        cls: 'text-green-300  bg-green-900/40  border-green-700/50'  };
    case 'failed':      return { label: 'Failed',      cls: 'text-red-300    bg-red-900/40    border-red-700/50'    };
    case 'cancelled':   return { label: 'Cancelled',   cls: 'text-gray-400   bg-gray-800      border-gray-700'      };
  }
}

function RunRow({ run }: { run: ProjectRun }) {
  const { approveProjectRun, cancelProjectRun, setActiveSession } = useSessions();
  const s = statusStyle(run.status);
  const active = ['negotiating', 'running', 'paused', 'blocked'].includes(run.status);
  return (
    <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-3 flex items-start gap-3">
      <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${s.cls}`}>{s.label}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{run.name}</span>
          {run.cycleCount > 0 && <span className="text-[10px] text-gray-600">cycle {run.cycleCount}</span>}
        </div>
        <div className="text-xs text-gray-500 truncate">{run.repoPath}</div>
        {run.lastNote && <div className="text-xs text-gray-400 mt-0.5">{run.lastNote}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {run.executorSessionId && (
          <button onClick={() => setActiveSession(run.executorSessionId!)} className="text-[10px] text-blue-400 hover:text-blue-300">Open</button>
        )}
        {run.status === 'negotiating' && (
          <button
            onClick={() => { if (confirm('Approve the negotiated contract and start the autonomous run?')) approveProjectRun(run.id); }}
            className="text-[10px] px-1.5 py-0.5 rounded bg-green-700 hover:bg-green-600 text-white"
          >
            Approve & Start
          </button>
        )}
        {active && (
          <button onClick={() => { if (confirm('Cancel this run?')) cancelProjectRun(run.id); }} className="text-[10px] text-red-400 hover:text-red-300">Cancel</button>
        )}
      </div>
    </div>
  );
}

function NewRunForm({ onClose }: { onClose: () => void }) {
  const { createProjectRun, state } = useSessions();
  const sessions = Array.from(state.sessions.values()).filter(s => !s.config.isScratch);
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [goal, setGoal] = useState('');
  const [maxWeeklyPercent, setMaxWeeklyPercent] = useState('50');
  const [hardStopAt, setHardStopAt] = useState('');
  const field = 'w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500';

  const pickSession = (id: string) => {
    const s = sessions.find(s => s.id === id);
    if (!s) return;
    if (!repoPath) setRepoPath(s.config.cwd);
    if (!name) setName(s.config.name);
  };

  const submit = () => {
    if (!name.trim() || !repoPath.trim() || !goal.trim()) return;
    createProjectRun({
      name: name.trim(), repoPath: repoPath.trim(), goal: goal.trim(),
      budget: {
        maxWeeklyPercent: maxWeeklyPercent ? Number(maxWeeklyPercent) : null,
        hardStopAt: hardStopAt ? new Date(hardStopAt).toISOString() : null,
      },
    });
    onClose();
  };
  return (
    <div className="bg-gray-800/40 border border-blue-700/50 rounded-lg p-3 space-y-2">
      {sessions.length > 0 && (
        <div>
          <label className="block text-xs font-medium text-gray-400 mb-1">Pre-fill from existing session</label>
          <select
            defaultValue=""
            onChange={e => pickSession(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500 text-gray-300"
          >
            <option value="" disabled>Pick a session to copy its repo path…</option>
            {sessions.map(s => (
              <option key={s.id} value={s.id}>{s.config.name} — {s.config.cwd}</option>
            ))}
          </select>
          <p className="text-[10px] text-gray-600 mt-0.5">A new executor session will be created — this just pre-fills the path.</p>
        </div>
      )}
      <input className={field} placeholder="Run name (e.g. Wedding site checkout)" value={name} onChange={e => setName(e.target.value)} />
      <input className={field} placeholder="Repo path (absolute)" value={repoPath} onChange={e => setRepoPath(e.target.value)} />
      <textarea className={`${field} h-20 resize-none`} placeholder="Goal — what should it accomplish overnight?" value={goal} onChange={e => setGoal(e.target.value)} />
      <div className="flex items-center gap-4">
        <label className="text-xs text-gray-500 flex items-center gap-1">
          Pause above
          <input type="number" min="1" max="100" className="w-12 bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-xs" value={maxWeeklyPercent} onChange={e => setMaxWeeklyPercent(e.target.value)} />
          % weekly
        </label>
        <label className="text-xs text-gray-500 flex items-center gap-1">
          Hard stop
          <input type="datetime-local" className="bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-xs" value={hardStopAt} onChange={e => setHardStopAt(e.target.value)} />
        </label>
      </div>
      <p className="text-[10px] text-gray-600">The run will interrogate the repo, ask you about every foreseeable blocker, then write a contract for you to approve before going autonomous.</p>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
        <button onClick={submit} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded">Start negotiation</button>
      </div>
    </div>
  );
}

function RunsTab() {
  const { state } = useSessions();
  const [showForm, setShowForm] = useState(false);
  const runs = Array.from(state.projectRuns.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="space-y-3">
      {runs.length === 0 && !showForm && (
        <div className="text-sm text-gray-500 text-center py-8">
          No overnight runs yet. Start one and it will negotiate a plan with you before going autonomous.
        </div>
      )}
      {showForm && <NewRunForm onClose={() => setShowForm(false)} />}
      {runs.map(run => <RunRow key={run.id} run={run} />)}
      {!showForm && (
        <button onClick={() => setShowForm(true)} className="w-full px-3 py-2 bg-blue-600/20 hover:bg-blue-600/40 border border-blue-600/50 text-blue-300 text-sm rounded-lg transition-colors">
          + Start an overnight run
        </button>
      )}
    </div>
  );
}

// ─── Modal shell ────────────────────────────────────────────────────────────

type Tab = 'scheduled' | 'runs';

export function SchedulerModal({ onClose }: Props) {
  const [tab, setTab] = useState<Tab>('scheduled');

  const tabCls = (t: Tab) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t
      ? 'border-blue-500 text-blue-300'
      : 'border-transparent text-gray-400 hover:text-gray-200'}`;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Automation</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200 text-xl leading-none w-7 h-7 flex items-center justify-center hover:bg-gray-800 rounded">×</button>
        </div>
        {/* Tabs */}
        <div className="flex border-b border-gray-800 px-5">
          <button className={tabCls('scheduled')} onClick={() => setTab('scheduled')}>Scheduled Tasks</button>
          <button className={tabCls('runs')} onClick={() => setTab('runs')}>Overnight Runs</button>
        </div>
        {/* Body */}
        <div className="overflow-y-auto flex-1 p-4">
          {tab === 'scheduled' ? <ScheduledTab /> : <RunsTab />}
        </div>
      </div>
    </div>
  );
}
