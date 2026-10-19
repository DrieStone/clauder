import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuid } from 'uuid';
import type { WsOutboundMessage } from '@clauder/shared';

// Folder notes: when one session changes files in another session's folder (a different project,
// say the planning session editing the website's files), the other session gets a note: a line in
// its chat at once, and, for Claude, a note on the next message sent to it (not a turn of its own,
// and never its system prompt, so it costs no extra turn and no prompt cache). Changes are read
// off the tool calls each turn makes: file edits exactly, shell commands by a best guess (a
// command that names the folder and looks like it writes).

const NOTES_FILE = path.join(os.homedir(), '.clauder', 'folder-notes.json');
const MAX_NOTES_PER_SESSION = 20;
const MAX_FILES_PER_NOTE = 25;
const MAX_SUMMARY = 700;

export type ChangeHow = 'edited' | 'shell';

export interface FolderNote {
  id: string;
  fromSessionId: string;
  fromName: string;
  fromCwd: string;
  at: string;
  /** Paths relative to the receiving session's folder. */
  files: { path: string; how: ChangeHow }[];
  /** What the session that made the changes said at the end of that turn. */
  summary: string;
}

/** A session as far as folder notes care. */
export interface NoteSession {
  id: string;
  name: string;
  cwd: string;
  projectId: string;
  /** Scratch and its conversations share the scratch folder; nobody is told about it. */
  scratch: boolean;
}

const HOME = os.homedir();
const norm = (p: string) => path.resolve(p.startsWith('~/') || p === '~' ? path.join(HOME, p.slice(1)) : p).replace(/\/+$/, '');
const inside = (file: string, folder: string) => file === folder || file.startsWith(folder + '/');

// A shell command that probably writes to every path it names: a file-changing program, an
// in-place edit, or a git command that changes the tree. Otherwise only an output redirect's own
// target counts (not a numbered stream like 2>/dev/null), so `grep x /a/b > /tmp/out` flags nothing.
const PROGRAM_WRITES_RE = /(?:^|[\s;&|(])(?:cp|mv|rm|rmdir|mkdir|touch|tee|ln|rsync|install|unzip|tar|patch|truncate|dd)\s|\bsed\s+(?:-[a-zA-Z]*i|--in-place)|\bperl\s+-[a-zA-Z]*i|\bgit\s+(?:-C\s+\S+\s+)?(?:commit|add|checkout|switch|reset|restore|apply|merge|rebase|stash|pull|rm|mv|clean|cherry-pick|revert)\b/;
const REDIRECT_RE = /(?:^|[^0-9&>])>>?\s*["']?((?:~\/|\/)[^\s'"|;&<>()]+)/g;
const PATH_RE = /(?:^|[\s'"=:(])((?:~\/|\/)[^\s'"|;&<>()]+)/g;

/** The files a tool call changed, or probably changed: absolute paths. */
export function changedPaths(tool: { name: string; input: Record<string, unknown> }): { path: string; how: ChangeHow }[] {
  const input = tool.input ?? {};
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool.name)) {
    const p = input.file_path ?? input.notebook_path;
    return typeof p === 'string' && p.startsWith('/') ? [{ path: norm(p), how: 'edited' }] : [];
  }
  if (tool.name === 'Bash' && typeof input.command === 'string') {
    const cmd = input.command;
    const found = PROGRAM_WRITES_RE.test(cmd) ? cmd.matchAll(PATH_RE) : cmd.matchAll(REDIRECT_RE);
    const out: { path: string; how: ChangeHow }[] = [];
    for (const m of found) {
      const p = m[1].replace(/[.,:]+$/, '');
      if (p.length > 1 && !p.startsWith('/dev/') && !p.startsWith('/tmp/')) out.push({ path: norm(p), how: 'shell' });
    }
    return out;
  }
  return [];
}

// A session whose folder is this broad (the disk, the home folder, or a folder that holds
// whole projects) would hear about nearly everything, so it hears about nothing.
const TOO_BROAD = new Set(['/', '/Users', '/Volumes', HOME, ...['Documents', 'Desktop', 'Downloads', 'development'].map(d => path.join(HOME, d))]);

/** Who should hear about a change to `file` made by `from`: sessions whose folder holds it, other
 *  than the sender's own project (it coordinates through check-ins) and Scratch. */
export function recipientsOf(file: string, from: NoteSession, sessions: NoteSession[]): NoteSession[] {
  return sessions.filter(s => {
    if (s.id === from.id || s.projectId === from.projectId || s.scratch || !s.cwd) return false;
    const folder = norm(s.cwd);
    return !TOO_BROAD.has(folder) && inside(file, folder);
  });
}

const fmtTime = (iso: string) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const tidy = (p: string) => p.replace(HOME, '~');

/** The note Claude reads on its next message: every change since it last worked, oldest first. */
export function noteText(notes: FolderNote[]): string {
  const blocks = notes.map(n => {
    const files = n.files.map(f => `  - ${f.path || '(the folder itself)'}${f.how === 'shell' ? ' (by a shell command; it may not have changed it)' : ' (edited)'}`).join('\n');
    return `- "${n.fromName}", working in ${tidy(n.fromCwd)}, on ${fmtTime(n.at)}:\n${files}` +
      (n.summary ? `\n  What it said about that work: "${n.summary.replace(/\s+/g, ' ')}"` : '');
  });
  return `[Clauder: since this session last worked, other Claude sessions changed files in this folder:\n${blocks.join('\n')}\n` +
    `Re-read these files before relying on what you remember of them, and don't undo those changes without asking the owner.]`;
}

export class FolderNotes {
  private inbox = new Map<string, FolderNote[]>();
  /** Per sending session, during its turn: what it changed, and its latest words. */
  private turns = new Map<string, { files: Map<string, ChangeHow>; text: string }>();
  /** Lines this class is adding to a chat right now (they come back through observe). */
  private ownLines = new Set<string>();
  private readonly file: string;

  constructor(private deps: {
    sessions: () => NoteSession[];
    /** Leave a line in a session's chat. */
    tell: (sessionId: string, text: string) => void;
    file?: string;
  }) {
    this.file = deps.file ?? NOTES_FILE;
  }

  load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (!data || typeof data !== 'object') return;
      for (const [id, notes] of Object.entries(data)) if (Array.isArray(notes) && notes.length) this.inbox.set(id, notes as FolderNote[]);
      console.log(`[FolderNotes] Loaded notes for ${this.inbox.size} session(s)`);
    } catch (err) {
      console.error('[FolderNotes] Failed to load:', err);
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.inbox), null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[FolderNotes] Failed to save:', err);
    }
  }

  /** Fed every broadcast: tool calls and text during a turn, then the turn's end. */
  observe(msg: WsOutboundMessage): void {
    if (msg.type === 'assistant_message') {
      // This class's own lines in a chat aren't anything the session said.
      if (this.ownLines.delete(msg.text)) return;
      const turn = this.turns.get(msg.sessionId) ?? { files: new Map<string, ChangeHow>(), text: '' };
      for (const tu of msg.toolUses ?? []) {
        for (const c of changedPaths(tu)) if (turn.files.get(c.path) !== 'edited') turn.files.set(c.path, c.how);
      }
      if (msg.text?.trim()) turn.text = msg.text.trim();
      if (turn.files.size || turn.text) this.turns.set(msg.sessionId, turn);
    } else if (msg.type === 'state_change') {
      if (msg.status !== 'working') this.flush(msg.sessionId);
      // A turn starting: words left over from between turns (a line Clauder added) aren't its.
      else if (!this.turns.get(msg.sessionId)?.files.size) this.turns.delete(msg.sessionId);
    }
  }

  private tell(sessionId: string, text: string): void {
    this.ownLines.add(text);
    try { this.deps.tell(sessionId, text); } finally { this.ownLines.delete(text); }
  }

  /** A turn ended: leave a note for every session whose folder it changed. */
  flush(sessionId: string): void {
    const turn = this.turns.get(sessionId);
    this.turns.delete(sessionId);
    if (!turn?.files.size) return;
    const sessions = this.deps.sessions();
    const from = sessions.find(s => s.id === sessionId);
    if (!from) return;
    const byRecipient = new Map<string, { to: NoteSession; files: { path: string; how: ChangeHow }[] }>();
    for (const [file, how] of turn.files) {
      for (const to of recipientsOf(file, from, sessions)) {
        const entry = byRecipient.get(to.id) ?? { to, files: [] };
        entry.files.push({ path: path.relative(norm(to.cwd), file), how });
        byRecipient.set(to.id, entry);
      }
    }
    if (!byRecipient.size) return;
    const at = new Date().toISOString();
    const summary = turn.text.slice(0, MAX_SUMMARY);
    for (const { to, files } of byRecipient.values()) {
      const note: FolderNote = { id: uuid(), fromSessionId: from.id, fromName: from.name, fromCwd: from.cwd, at, files: files.slice(0, MAX_FILES_PER_NOTE), summary };
      const list = [...(this.inbox.get(to.id) ?? []), note].slice(-MAX_NOTES_PER_SESSION);
      this.inbox.set(to.id, list);
      const names = files.slice(0, 4).map(f => f.path || 'the folder').join(', ') + (files.length > 4 ? `, and ${files.length - 4} more` : '');
      this.tell(to.id, `📝 "${from.name}" changed ${files.length === 1 ? 'a file' : `${files.length} files`} in this folder: ${names}. Claude will see a note about it with your next message.`);
    }
    const toNames = [...byRecipient.values()].map(r => `"${r.to.name}"`).join(', ');
    this.tell(from.id, `📝 Left a note for ${toNames} about the files this turn changed in ${byRecipient.size === 1 ? 'its folder' : 'their folders'}.`);
    this.save();
  }

  /** Whether a session has notes waiting. */
  has(sessionId: string): boolean {
    return (this.inbox.get(sessionId)?.length ?? 0) > 0;
  }

  /** The note for a session's next message, if any, which also clears its inbox. */
  take(sessionId: string): string | null {
    const notes = this.inbox.get(sessionId);
    if (!notes?.length) return null;
    this.inbox.delete(sessionId);
    this.save();
    return noteText(notes);
  }

  /** A destroyed session's notes go with it. */
  removeSession(sessionId: string): void {
    this.turns.delete(sessionId);
    if (this.inbox.delete(sessionId)) this.save();
  }
}
