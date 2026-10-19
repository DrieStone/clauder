import { memo, useState } from 'react';
import { STATUS_IDLE_DAYS, type StatusReport } from '@clauder/shared';
import { RichMarkdown } from './RichMarkdown';
import { useSessionActions } from '../context/SessionContext';

// Status notes: where an idle project stands, written by the server (status-reports.ts) after
// STATUS_IDLE_DAYS without activity, or on request from the Summary tab.

const DAY_MS = 24 * 60 * 60 * 1000;
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function writtenLabel(report: StatusReport): string {
  const idleDays = Math.floor((Date.parse(report.generatedAt) - Date.parse(report.coversActivityAt)) / DAY_MS);
  return `written ${fmtDate(report.generatedAt)}${report.trigger === 'idle' && idleDays > 0 ? `, after ${idleDays} days idle` : ''}`;
}

const NOTE_PROSE = 'prose prose-invert prose-sm max-w-none break-words [&_h3]:text-sky-200 [&_h3]:text-[13px] [&_h3]:mt-3 [&_h3]:mb-1 [&_h3:first-child]:mt-0 [&_ul]:my-1 [&_p]:my-1';

/** The note's "Where it stands" paragraph as plain text, for the dashboard's ⓘ preview. */
export function whereItStands(text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^#{1,6}\s*where it stands/i.test(l.trim()));
  const body: string[] = [];
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      if (/^#{1,6}\s/.test(line.trim())) break;
      body.push(line);
    }
  }
  const para = body.join(' ').trim() || text.split(/\n\s*\n/).find(p => p.trim() && !p.trim().startsWith('#')) || '';
  return para.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
}

/** Whether a note still describes the project: nothing has happened in the session since. */
export function isCurrent(report: StatusReport, lastActiveAt: string): boolean {
  return Date.parse(report.coversActivityAt) >= Date.parse(lastActiveAt);
}

/** A note in the chat, at the point it was written. Open while it's the latest thing in the
 *  conversation; once work has picked up again it starts folded to one line. */
export const StatusNoteCard = memo(function StatusNoteCard({ report, latest }: { report: StatusReport; latest: boolean }) {
  const [open, setOpen] = useState(latest);
  return (
    <div className="w-full rounded-lg border border-sky-800/50 bg-sky-950/20">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
        <span aria-hidden>📋</span>
        <span className="text-sm font-medium text-sky-200 shrink-0">Status note</span>
        <span className="text-xs text-gray-500 truncate min-w-0">{writtenLabel(report)}</span>
        <span className="ml-auto text-[11px] text-sky-400/80 shrink-0">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open && (
        <div className={`px-3 pb-3 ${NOTE_PROSE}`}>
          <RichMarkdown>{report.text}</RichMarkdown>
        </div>
      )}
    </div>
  );
});

/** The Summary tab's status-note section: the latest note (current or not), and a way to write
 *  one now, e.g. when putting a project down. */
export function StatusNotePanel({ sessionId, report, lastActiveAt, writing, failed }: {
  sessionId: string;
  report: StatusReport | null;
  lastActiveAt: string;
  writing: boolean;
  failed: boolean;
}) {
  const { generateStatusReport, logEvent } = useSessionActions();
  const write = () => { logEvent('status_note_write'); generateStatusReport(sessionId); };
  return (
    <div className="max-w-xl mt-8 pt-6 border-t border-gray-800">
      <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">📋 Status note</h3>
      {writing ? (
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <span className="flex gap-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce [animation-delay:0ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce [animation-delay:150ms]" />
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce [animation-delay:300ms]" />
          </span>
          Writing a status note… this takes a minute or two.
        </div>
      ) : report ? (
        <>
          <div className={NOTE_PROSE}>
            <RichMarkdown>{report.text}</RichMarkdown>
          </div>
          <p className="text-xs text-gray-500 mt-3">
            {writtenLabel(report).replace(/^w/, 'W')}
            {isCurrent(report, lastActiveAt) ? '' : '. The project has moved on since.'}
          </p>
          <button onClick={write} className="mt-3 text-xs text-blue-400 hover:text-blue-300 transition-colors">
            Write a new one now
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-500">
            No status note yet. When a project has been idle for {STATUS_IDLE_DAYS} days, Clauder writes one: where it
            stands, what you last worked on, and what's still open. It shows at the end of the chat, so you can pick the
            project back up later.
          </p>
          <button onClick={write} className="mt-3 text-xs text-blue-400 hover:text-blue-300 transition-colors">
            Write one now
          </button>
        </>
      )}
      {failed && !writing && (
        <p className="text-xs text-red-300 mt-2">The last try didn't produce a note. Try again in a bit.</p>
      )}
    </div>
  );
}
