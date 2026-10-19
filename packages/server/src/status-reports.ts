import fs from 'fs';
import path from 'path';
import os from 'os';
import { STATUS_IDLE_DAYS, type SessionState, type StatusReport, type GitStatus, type RateLimitInfo } from '@clauder/shared';
import { runClaudeOneShot } from './claude-oneshot.js';
import { getGitStatus } from './git-status.js';
import { getRateLimitInfo } from './rate-limits.js';
import { DEFAULT_MODEL } from './models.js';

const REPORTS_FILE = path.join(os.homedir(), '.clauder', 'status-reports.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const IDLE_MS = STATUS_IDLE_DAYS * DAY_MS;
const FIRST_SWEEP_MS = 3 * 60 * 1000;     // after startup settles
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const GAP_MS = 60 * 1000;                 // between automatic notes, so a backlog trickles out
const RETRY_AFTER_MS = DAY_MS;            // after a failed automatic attempt
const WRITE_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_REPORT_CHARS = 8_000;
// Background notes stay out of the way of real work: skip a sweep while either window is this full.
const MAX_SESSION_PERCENT = 75;
const MAX_WEEKLY_PERCENT = 85;

const day = (iso: string) => iso.slice(0, 10);

function ago(fromIso: string, now: number): string {
  const days = Math.floor((now - Date.parse(fromIso)) / DAY_MS);
  return days < 1 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Shorten a long message to its start and end, where the gist and the conclusion usually are. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  return `${text.slice(0, head)}\n[…]\n${text.slice(-(max - head))}`;
}

/** The conversation, oldest first, keeping the most recent messages that fit the budget. */
export function transcriptFor(messages: SessionState['messages']): string {
  const entries: string[] = [];
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'system') continue;
    let body = (m.content ?? '').trim();
    if (!body && m.toolUses?.length) body = `[used tools: ${m.toolUses.slice(0, 8).map(t => t.name).join(', ')}]`;
    if (!body) continue;
    const who = m.role === 'assistant' ? 'Claude' : m.author ? `${m.author.name} (a guest)` : 'Owner';
    const entry = `${who}, ${day(m.timestamp)}: ${clip(body, MAX_MESSAGE_CHARS)}`;
    if (total + entry.length > MAX_TRANSCRIPT_CHARS) break;
    entries.push(entry);
    total += entry.length;
  }
  return entries.reverse().join('\n\n');
}

function repoLine(git: GitStatus | null, cwdExists: boolean): string {
  if (!cwdExists) return 'The folder no longer exists (moved, deleted, or on a disconnected drive).';
  if (!git?.isRepo) return 'Not a git repository.';
  const parts = [git.branch ? `branch ${git.branch}` : 'detached HEAD'];
  parts.push(git.lastCommitAt ? `last commit ${day(git.lastCommitAt)} ("${git.lastCommitSubject ?? ''}")` : 'no commits yet');
  parts.push(git.changedFiles ? `${git.changedFiles} file(s) with uncommitted changes` : 'no uncommitted changes');
  parts.push(git.unpushedCommits == null ? 'no remote' : git.unpushedCommits ? `${git.unpushedCommits} commit(s) not pushed` : 'everything pushed');
  return parts.join('; ') + '.';
}

/** What Claude is asked, for one session. Exported for tests. */
export function buildStatusPrompt(s: SessionState, git: GitStatus | null, cwdExists: boolean, now: number): string {
  const tasks = (s.threads ?? []).map(t => t.name).filter(Boolean);
  const notes = (s.notes ?? '').trim();
  return [
    `The owner of this project, last worked on ${ago(s.lastActiveAt, now)}, wants a status note so they can pick it back up weeks or months from now without rereading the conversation. Use only what's below. Don't use tools, and don't invent details.`,
    '',
    'Write markdown with exactly these three headings, in this order:',
    '### Where it stands',
    "2-4 sentences: what the project is, what's working, and the state it was left in.",
    '### Last worked on',
    '2-5 bullets on the most recent work, saying when it happened.',
    '### Open threads',
    'Bullets: unfinished work, known problems, decisions still pending, and the obvious next step. Mention uncommitted or unpushed changes if the repo line shows any. Write "Nothing open." if there is nothing.',
    '',
    'Use plain words. No preamble, and under 250 words.',
    '',
    `Project: ${s.config.name}`,
    `Folder: ${s.config.cwd}`,
    `Started ${day(s.createdAt)}; last activity ${day(s.lastActiveAt)}.`,
    `Repo: ${repoLine(git, cwdExists)}`,
    ...(tasks.length ? [`Other tasks in this session: ${tasks.join(', ')}.`] : []),
    ...(notes ? ['', "The owner's notes for this session:", clip(notes, 3_000)] : []),
    '',
    'The conversation (oldest first; long messages shortened):',
    transcriptFor(s.messages),
  ].join('\n');
}

/** A reply is usable if it has some substance and at least one of the asked-for headings. */
export function cleanReport(text: string): string | null {
  const t = text.trim();
  if (t.length < 40 || !/where it stands|last worked on|open threads/i.test(t)) return null;
  return t.slice(0, MAX_REPORT_CHARS);
}

function quotaTight(info: RateLimitInfo, now: number): boolean {
  const full = (w: RateLimitInfo['session'], max: number) =>
    !!w && Date.parse(w.resetsAt) > now && (w.status === 'rejected' || (w.usedPercent ?? 0) >= max);
  return full(info.session, MAX_SESSION_PERCENT) || full(info.weekly, MAX_WEEKLY_PERCENT);
}

export interface StatusReportDeps {
  /** A session's full state (all of its messages), or null if it's gone. */
  getSession: (id: string) => SessionState | null;
  listSessions: () => SessionState[];
  /** True while the owner has paused all sessions. */
  isPaused: () => boolean;
  broadcast: (reports: StatusReport[], writing: string[], failed: string[]) => void;
  /** Ask Claude; resolves '' on any failure. Tests replace it. */
  ask?: (prompt: string, cwd: string) => Promise<string>;
  rateLimits?: () => RateLimitInfo;
  file?: string;
}

/** Status notes for projects that have gone quiet. Once a session has had no activity for
 *  STATUS_IDLE_DAYS, an hourly sweep asks Claude (one cheap, tool-less call on Sonnet at low
 *  effort, run in the project's folder) for a short note on where it stands, what was last worked
 *  on and what's left, from Clauder's own copy of the conversation plus the repo's state. The
 *  session itself is never touched: no turn, no change to lastActiveAt, nothing in its CLI
 *  transcript. Notes are written one at a time, a minute apart, and not while sessions are paused
 *  or the subscription is busy. Persisted TagManager-style to `~/.clauder/status-reports.json`. */
export class StatusReportManager {
  private reports = new Map<string, StatusReport>();
  private writing = new Set<string>();
  /** When a session's last attempt failed (manual or automatic); cleared by a success. */
  private failedAt = new Map<string, number>();
  private sweeping = false;
  private timers: NodeJS.Timeout[] = [];
  private readonly file: string;
  private readonly ask: (prompt: string, cwd: string) => Promise<string>;
  private readonly rateLimits: () => RateLimitInfo;

  constructor(private deps: StatusReportDeps) {
    this.file = deps.file ?? REPORTS_FILE;
    this.ask = deps.ask ?? ((prompt, cwd) => runClaudeOneShot({ prompt, cwd, model: DEFAULT_MODEL, effort: 'low', timeoutMs: WRITE_TIMEOUT_MS }));
    this.rateLimits = deps.rateLimits ?? getRateLimitInfo;
  }

  load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      if (!Array.isArray(data)) return;
      for (const r of data) {
        if (r && typeof r.sessionId === 'string' && typeof r.text === 'string' && typeof r.generatedAt === 'string' && typeof r.coversActivityAt === 'string') {
          this.reports.set(r.sessionId, r);
        }
      }
      console.log(`[StatusReports] Loaded ${this.reports.size} status note(s) from disk`);
    } catch (err) {
      console.error('[StatusReports] Failed to load:', err);
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.file);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Atomic write: temp sibling + rename, so a crash mid-write can't truncate the file.
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.reports.values()], null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error('[StatusReports] Failed to save:', err);
    }
  }

  private changed(): void {
    const failed = [...this.failedAt.keys()].filter(id => !this.writing.has(id));
    this.deps.broadcast(this.list(), [...this.writing], failed);
  }

  list(): StatusReport[] {
    return [...this.reports.values()];
  }

  snapshot(): { reports: StatusReport[]; writing: string[]; failed: string[] } {
    return { reports: this.list(), writing: [...this.writing], failed: [...this.failedAt.keys()].filter(id => !this.writing.has(id)) };
  }

  /** Start the hourly sweep. */
  start(): void {
    const sweep = () => { this.sweep().catch(err => console.error('[StatusReports] Sweep failed:', err)); };
    const first = setTimeout(sweep, FIRST_SWEEP_MS);
    const every = setInterval(sweep, SWEEP_EVERY_MS);
    first.unref();
    every.unref();
    this.timers.push(first, every);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** Whether a session is due an automatic note: idle long enough, has a conversation, isn't
   *  already covered by a note, and didn't just fail. */
  isDue(s: SessionState, now: number): boolean {
    // Scratch and its quick conversations (which expire anyway) don't get them.
    if (s.config.isScratch || s.config.scratchConversation || s.status === 'working' || this.writing.has(s.id)) return false;
    if (now - Date.parse(s.lastActiveAt) < IDLE_MS) return false;
    const r = this.reports.get(s.id);
    if (r && Date.parse(r.coversActivityAt) >= Date.parse(s.lastActiveAt)) return false;
    const failed = this.failedAt.get(s.id);
    if (failed && now - failed < RETRY_AFTER_MS) return false;
    return s.messages.some(m => m.role !== 'system' && !!(m.content ?? '').trim());
  }

  /** Write every due note, most recently active first, one at a time. Stops for the hour when
   *  sessions are paused or the subscription is busy. */
  async sweep(gapMs = GAP_MS): Promise<number> {
    if (this.sweeping) return 0;
    this.sweeping = true;
    let written = 0;
    try {
      for (;;) {
        const now = Date.now();
        if (this.deps.isPaused() || quotaTight(this.rateLimits(), now)) break;
        const next = this.deps.listSessions()
          .filter(s => this.isDue(s, now))
          .sort((a, b) => Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt))[0];
        if (!next) break;
        if (await this.write(next.id, 'idle')) written++;
        if (gapMs > 0) await new Promise(r => setTimeout(r, gapMs).unref());
      }
    } finally {
      this.sweeping = false;
    }
    return written;
  }

  /** Write a session's note now. Resolves with it, or null if it couldn't be written. */
  async write(sessionId: string, trigger: StatusReport['trigger']): Promise<StatusReport | null> {
    const s = this.deps.getSession(sessionId);
    if (!s || s.config.isScratch || this.writing.has(sessionId)) return null;
    this.writing.add(sessionId);
    this.changed();
    try {
      const cwdExists = fs.existsSync(s.config.cwd);
      const git = cwdExists ? await getGitStatus(s.config.cwd) : null;
      const prompt = buildStatusPrompt(s, git, cwdExists, Date.now());
      console.log(`[StatusReports] Writing a status note for "${s.config.name}" (${trigger})`);
      const text = cleanReport(await this.ask(prompt, cwdExists ? s.config.cwd : os.homedir()));
      if (!text) {
        console.warn(`[StatusReports] No usable note for "${s.config.name}"`);
        this.failedAt.set(sessionId, Date.now());
        return null;
      }
      if (!this.deps.getSession(sessionId)) return null; // destroyed while writing
      const report: StatusReport = {
        sessionId,
        text,
        generatedAt: new Date().toISOString(),
        coversActivityAt: s.lastActiveAt,
        threadId: s.activeThreadId,
        trigger,
      };
      this.reports.set(sessionId, report);
      this.failedAt.delete(sessionId);
      this.save();
      return report;
    } finally {
      this.writing.delete(sessionId);
      this.changed();
    }
  }

  /** A destroyed session takes its note with it. */
  removeSession(sessionId: string): void {
    this.failedAt.delete(sessionId);
    if (!this.reports.delete(sessionId)) return;
    this.save();
    this.changed();
  }
}
