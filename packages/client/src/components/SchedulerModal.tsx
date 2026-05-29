import { useState } from 'react';
import type { SessionState, Trigger } from '@clauder/shared';

interface SchedulerModalProps {
  sessions: SessionState[];
  triggers: Trigger[];
  onClose: () => void;
}

function formatLocal(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Convert local datetime-local input to ISO string */
function localInputToISO(local: string): string {
  return new Date(local).toISOString();
}

/** Get default datetime-local value (now + 1 hour) */
function defaultDateTime(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  // datetime-local expects YYYY-MM-DDTHH:MM (local time)
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SchedulerModal({ sessions, triggers, onClose }: SchedulerModalProps) {
  const [creating, setCreating] = useState(false);
  const [sessionId, setSessionId] = useState(sessions[0]?.id || '');
  const [description, setDescription] = useState('');
  const [message, setMessage] = useState('');
  const [when, setWhen] = useState(defaultDateTime());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Show only scheduled triggers (not watches) sorted by next fire
  const scheduled = triggers
    .filter(t => t.source === 'scheduled')
    .sort((a, b) => {
      const aMs = a.schedule.type === 'once' ? new Date(a.schedule.at).getTime() : new Date(a.schedule.nextAt).getTime();
      const bMs = b.schedule.type === 'once' ? new Date(b.schedule.at).getTime() : new Date(b.schedule.nextAt).getTime();
      return aMs - bMs;
    });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!sessionId || !message.trim() || !when) {
      setError('Session, message, and time are required');
      return;
    }
    const at = localInputToISO(when);
    if (new Date(at).getTime() < Date.now()) {
      setError('Scheduled time must be in the future');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/triggers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          message: message.trim(),
          description: description.trim() || 'Scheduled task',
          schedule: { type: 'once', at },
          source: 'scheduled',
        }),
      });
      if (!res.ok) throw new Error(await res.text() || `HTTP ${res.status}`);
      setCreating(false);
      setMessage('');
      setDescription('');
      setWhen(defaultDateTime());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      await fetch(`/api/triggers/${id}`, { method: 'DELETE' });
    } catch {}
  };

  const sessionName = (id: string) => sessions.find(s => s.id === id)?.config.name || id.slice(0, 8);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Scheduled Tasks</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 text-xl leading-none w-7 h-7 flex items-center justify-center hover:bg-gray-800 rounded"
          >
            ×
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-4 space-y-3">
          {scheduled.length === 0 && !creating && (
            <div className="text-sm text-gray-500 text-center py-8">
              No scheduled tasks. Create one below to fire a message to a session at a specific time.
            </div>
          )}

          {scheduled.map(t => (
            <div key={t.id} className="bg-gray-800/60 border border-gray-700 rounded-lg p-3 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium text-gray-100">{t.description}</span>
                  <span className="text-[10px] text-blue-300 bg-blue-500/20 px-1.5 py-0.5 rounded">→ {sessionName(t.sessionId)}</span>
                </div>
                <div className="text-xs text-gray-400 mt-1">
                  Fires {t.schedule.type === 'once' ? `at ${formatLocal(t.schedule.at)}` : `every ${Math.round(t.schedule.intervalSeconds / 60)}m`}
                </div>
                <div className="text-xs text-gray-500 italic mt-1 truncate" title={t.message}>
                  "{t.message}"
                </div>
              </div>
              <button
                onClick={() => handleRemove(t.id)}
                className="text-red-400 hover:text-red-300 text-xs px-2 py-1 hover:bg-red-900/30 rounded transition-colors shrink-0"
              >
                Delete
              </button>
            </div>
          ))}

          {creating ? (
            <form onSubmit={handleSubmit} className="bg-gray-800/40 border border-blue-700/50 rounded-lg p-3 space-y-2">
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Target Session</label>
                <select
                  value={sessionId}
                  onChange={e => setSessionId(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                >
                  {sessions.map(s => (
                    <option key={s.id} value={s.id}>{s.config.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="e.g. Start overnight refactor"
                  className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">When</label>
                <input
                  type="datetime-local"
                  value={when}
                  onChange={e => setWhen(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-400 mb-1">Message to send</label>
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  placeholder="The message that will be sent to the session at the scheduled time"
                  rows={3}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-blue-500 resize-none"
                />
              </div>
              {error && <div className="text-xs text-red-400">{error}</div>}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => { setCreating(false); setError(null); }}
                  className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded disabled:opacity-50"
                >
                  {submitting ? 'Scheduling…' : 'Schedule'}
                </button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => setCreating(true)}
              disabled={sessions.length === 0}
              className="w-full px-3 py-2 bg-blue-600/20 hover:bg-blue-600/40 border border-blue-600/50 text-blue-300 text-sm rounded-lg transition-colors disabled:opacity-50"
            >
              + Schedule a new task
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
