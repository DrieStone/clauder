import fs from 'fs';
import os from 'os';
import path from 'path';
import { v4 as uuid } from 'uuid';

// Project notes: a shared board for a project's sessions (the main session and its tasks). Any of
// them can leave a note (<<note>>, or a task's check-in) without waking anyone; each session gets
// the notes it hasn't seen ahead of its next message, as a note in the message (never its system
// prompt), so the board costs nothing until a session runs anyway. Direct messages between sessions
// are kept for what is actionable or important.

const FILE = path.join(os.homedir(), '.clauder', 'project-notes.json');
const MAX_NOTES = 200;      // kept per project
const MAX_DELIVER = 25;     // given to a session at once (the newest)
const MAX_TEXT = 4_000;

export interface ProjectNote {
  id: string;
  at: string;
  fromId: string;
  fromName: string;
  text: string;
}

/** What a closed task leaves behind: a summary of its work, kept for good. */
export interface ClosedTask {
  name: string;
  closedAt: string;
  startedAt: string;
  summary: string;
}

interface Data {
  notes: Record<string, ProjectNote[]>;
  closed: Record<string, ClosedTask[]>;
  /** Per session: the id of the last note it has been given. */
  seen: Record<string, string>;
}

const fmt = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export class ProjectNotes {
  private data: Data = { notes: {}, closed: {}, seen: {} };
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private file = FILE) {}

  load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const d = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      this.data = { notes: d?.notes ?? {}, closed: d?.closed ?? {}, seen: d?.seen ?? {} };
    } catch (err) {
      console.error('[ProjectNotes] Failed to load:', err);
    }
  }

  private save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.saveNow(); }, 500);
    this.timer.unref();
  }

  saveNow(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      console.error('[ProjectNotes] Failed to save:', err);
    }
  }

  add(projectId: string, from: { id: string; name: string }, text: string): ProjectNote | null {
    const body = String(text ?? '').trim().slice(0, MAX_TEXT);
    if (!body) return null;
    const note: ProjectNote = { id: uuid(), at: new Date().toISOString(), fromId: from.id, fromName: from.name, text: body };
    const list = [...(this.data.notes[projectId] ?? []), note].slice(-MAX_NOTES);
    this.data.notes[projectId] = list;
    // (Unread skips a session's own notes, so the writer's position is left alone.)
    this.save();
    return note;
  }

  /** Notes by others this session hasn't been given, oldest first. Doesn't mark them. */
  unread(projectId: string, sessionId: string): ProjectNote[] {
    const list = this.data.notes[projectId] ?? [];
    const last = this.data.seen[sessionId];
    const from = last ? list.findIndex(n => n.id === last) + 1 : 0;
    return list.slice(from).filter(n => n.fromId !== sessionId);
  }

  /** The block for a session's next message (null if nothing new), marking those notes given. */
  take(projectId: string, sessionId: string): string | null {
    const list = this.data.notes[projectId] ?? [];
    const fresh = this.unread(projectId, sessionId);
    if (list.length) this.data.seen[sessionId] = list[list.length - 1].id;
    if (!fresh.length) { if (list.length) this.save(); return null; }
    this.save();
    const shown = fresh.slice(-MAX_DELIVER);
    const skipped = fresh.length - shown.length;
    return `[Clauder: new notes on this project's shared board since you last worked${skipped ? ` (the ${shown.length} newest; ${skipped} older ones not shown)` : ''}:\n` +
      shown.map(n => `- ${fmt(n.at)}, from "${n.fromName}": ${n.text.replace(/\n+/g, ' ⏎ ')}`).join('\n') +
      `\nRead them before you start; act on any that concern your work.]`;
  }

  /** Keep a closed task's summary (never trimmed: the board's notes scroll away, these don't). */
  addClosed(projectId: string, task: ClosedTask): void {
    this.data.closed[projectId] = [...(this.data.closed[projectId] ?? []), task];
    this.save();
  }

  closed(projectId: string): ClosedTask[] {
    return this.data.closed[projectId] ?? [];
  }

  removeSession(sessionId: string): void {
    if (sessionId in this.data.seen) { delete this.data.seen[sessionId]; this.save(); }
  }

  removeProject(projectId: string): void {
    if (projectId in this.data.notes || projectId in this.data.closed) {
      delete this.data.notes[projectId];
      delete this.data.closed[projectId];
      this.save();
    }
  }
}
