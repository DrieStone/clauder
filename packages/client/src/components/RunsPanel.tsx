import { useState } from 'react';
import type { ProjectRun, RunStatus } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';

function statusStyle(status: RunStatus): { label: string; cls: string } {
  switch (status) {
    case 'negotiating': return { label: 'Negotiating', cls: 'bg-purple-900/40 text-purple-300 border-purple-700/50' };
    case 'running':     return { label: 'Running',     cls: 'bg-blue-900/40 text-blue-300 border-blue-700/50' };
    case 'paused':      return { label: 'Paused',      cls: 'bg-amber-900/40 text-amber-300 border-amber-700/50' };
    case 'blocked':     return { label: 'Needs you',   cls: 'bg-orange-900/40 text-orange-300 border-orange-700/50' };
    case 'done':        return { label: 'Done',        cls: 'bg-green-900/40 text-green-300 border-green-700/50' };
    case 'failed':      return { label: 'Failed',      cls: 'bg-red-900/40 text-red-300 border-red-700/50' };
    case 'cancelled':   return { label: 'Cancelled',   cls: 'bg-gray-800 text-gray-400 border-gray-700' };
  }
}

function RunRow({ run }: { run: ProjectRun }) {
  const { approveProjectRun, cancelProjectRun, setActiveSession } = useSessions();
  const s = statusStyle(run.status);
  const active = ['negotiating', 'running', 'paused', 'blocked'].includes(run.status);
  return (
    <div className="flex items-start gap-3 rounded-lg border border-gray-800 bg-gray-900/60 px-3 py-2">
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
          <button
            onClick={() => { if (confirm('Cancel this run?')) cancelProjectRun(run.id); }}
            className="text-[10px] text-red-400 hover:text-red-300"
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function NewRunForm({ onClose }: { onClose: () => void }) {
  const { createProjectRun } = useSessions();
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [goal, setGoal] = useState('');
  const [maxWeeklyPercent, setMaxWeeklyPercent] = useState('50');
  const [hardStopAt, setHardStopAt] = useState('');

  const submit = () => {
    if (!name.trim() || !repoPath.trim() || !goal.trim()) return;
    createProjectRun({
      name: name.trim(),
      repoPath: repoPath.trim(),
      goal: goal.trim(),
      budget: {
        maxWeeklyPercent: maxWeeklyPercent ? Number(maxWeeklyPercent) : null,
        hardStopAt: hardStopAt ? new Date(hardStopAt).toISOString() : null,
      },
    });
    onClose();
  };

  const field = 'w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm';
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900/60 p-3 space-y-2">
      <input className={field} placeholder="Run name (e.g. Wedding site checkout flow)" value={name} onChange={e => setName(e.target.value)} />
      <input className={field} placeholder="Repo path (absolute)" value={repoPath} onChange={e => setRepoPath(e.target.value)} />
      <textarea className={`${field} h-20 resize-none`} placeholder="Goal — what should it accomplish overnight?" value={goal} onChange={e => setGoal(e.target.value)} />
      <div className="flex items-center gap-3">
        <label className="text-xs text-gray-500">Pause above
          <input type="number" min="1" max="100" className="ml-1 w-14 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs" value={maxWeeklyPercent} onChange={e => setMaxWeeklyPercent(e.target.value)} />% weekly
        </label>
        <label className="text-xs text-gray-500">Hard stop
          <input type="datetime-local" className="ml-1 bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-xs" value={hardStopAt} onChange={e => setHardStopAt(e.target.value)} />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-gray-200">Cancel</button>
        <button onClick={submit} className="text-xs px-2 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white">Start negotiation</button>
      </div>
      <p className="text-[10px] text-gray-600">It will interrogate the repo + goal, ask you about every foreseeable blocker, then write a contract for you to approve before going autonomous.</p>
    </div>
  );
}

export function RunsPanel() {
  const { state } = useSessions();
  const [showForm, setShowForm] = useState(false);
  const runs = Array.from(state.projectRuns.values())
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  if (runs.length === 0 && !showForm) {
    return (
      <section>
        <button onClick={() => setShowForm(true)} className="text-xs text-gray-500 hover:text-gray-300">
          + Start an overnight run
        </button>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Overnight Runs</h2>
        {!showForm && (
          <button onClick={() => setShowForm(true)} className="text-xs text-blue-400 hover:text-blue-300">+ New run</button>
        )}
      </div>
      <div className="space-y-2">
        {showForm && <NewRunForm onClose={() => setShowForm(false)} />}
        {runs.map(run => <RunRow key={run.id} run={run} />)}
      </div>
    </section>
  );
}
