import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SessionState, SessionOrigin, PendingWakeup, PendingPlan, ParkedThread } from '@clauder/shared';
import { trimMessages } from '@clauder/shared';

const CLAUDER_DIR = path.join(os.homedir(), '.clauder');
const SESSIONS_FILE = path.join(CLAUDER_DIR, 'sessions.json');

export interface PersistedSession {
  id: string;
  config: SessionState['config'];
  origin: SessionOrigin;
  sdkSessionId: string | null;
  totalCostUsd: number;
  contextUsage: SessionState['contextUsage'];
  messages: SessionState['messages'];
  permissionMode?: string;
  summary?: string | null;
  summaryGeneratedAt?: string | null;
  compactedContext?: string | null;
  notes?: string | null;
  notesUpdatedAt?: string | null;
  pendingWakeup?: PendingWakeup | null;
  /** A plan awaiting accept/reject, persisted so the banner survives a server restart (not just
   *  WS reconnects). lastPlanText is rebuilt from pendingPlan.plan on restore. */
  pendingPlan?: PendingPlan | null;
  createdAt: string;
  lastActiveAt: string;
  /** Full parked-thread snapshots (messages included) — NOT the lightweight ThreadSummary[]
   *  the client sees on SessionState.threads. See SessionStateForPersist. */
  threads?: ParkedThread[];
  activeThreadId?: string;
  activeThreadName?: string | null;
}

/** What saveSessions() actually needs per session: the normal SessionState fields, PLUS the
 *  full ParkedThread[] snapshots (with message bodies) that getState()/SessionState deliberately
 *  omit from the client-facing `threads: ThreadSummary[]`. Callers build this by combining
 *  session.getState() with the ManagedSession's own `.threads` field — see
 *  SessionManager.getAllSessionsForPersist(). */
export type SessionStateForPersist = Omit<SessionState, 'threads'> & { threads: ParkedThread[] };

function ensureDir() {
  if (!fs.existsSync(CLAUDER_DIR)) {
    fs.mkdirSync(CLAUDER_DIR, { recursive: true });
  }
}

/** Write a file atomically: write to a temp sibling, then rename over the target.
 *  rename(2) is atomic on the same filesystem, so a crash mid-write can never leave
 *  a truncated target — it leaves either the old complete file or a stray .tmp. */
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const SESSIONS_BAK = `${SESSIONS_FILE}.bak`;

const PERSIST_TOOL_RESULT_MAX = 2_000;
/** Chat messages kept per session in sessions.json. Pinned messages are exempt — see trimMessages. */
const PERSIST_MESSAGES_MAX = 50;

const MAX_BACKUPS = 48; // ~8 hours at 10-minute intervals

export function backupSessions(): void {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const backupsRoot = path.join(CLAUDER_DIR, 'backups');
    const backupDir = path.join(backupsRoot, `backup-${stamp}`);
    fs.mkdirSync(backupDir, { recursive: true });
    fs.copyFileSync(SESSIONS_FILE, path.join(backupDir, 'sessions.json'));

    // Prune oldest backups beyond MAX_BACKUPS
    const entries = fs.readdirSync(backupsRoot)
      .filter(e => e.startsWith('backup-'))
      .sort(); // lexicographic == chronological given the timestamp format
    for (const old of entries.slice(0, Math.max(0, entries.length - MAX_BACKUPS))) {
      fs.rmSync(path.join(backupsRoot, old), { recursive: true, force: true });
    }
  } catch (err) {
    console.error('[Persistence] Failed to create backup:', err);
  }
}

/** Trim a message list for disk: cap the count (pinned messages exempt, see trimMessages) and
 *  truncate each tool result's content. Shared between a session's live messages and each of
 *  its parked threads' messages — same size concerns apply to both. */
function trimMessagesForPersist(messages: SessionState['messages']): SessionState['messages'] {
  return trimMessages(messages, PERSIST_MESSAGES_MAX).map((m) => ({
    ...m,
    toolUses: m.toolUses?.map((tu) => ({
      ...tu,
      result: tu.result ? {
        ...tu.result,
        content: tu.result.content.slice(0, PERSIST_TOOL_RESULT_MAX),
        originalLength: tu.result.content.length > PERSIST_TOOL_RESULT_MAX
          ? (tu.result.originalLength ?? tu.result.content.length)
          : tu.result.originalLength,
      } : undefined,
    })),
  }));
}

export function saveSessions(sessions: SessionStateForPersist[]): void {
  ensureDir();
  // Roll the current good file to a single rolling .bak before overwriting. This is the
  // near-current recovery source for loadSessions() if a write is ever corrupted. (We keep
  // one rolling .bak rather than a timestamped backup per save — at debounced save rates a
  // per-save timestamped dir would churn disk and blow MAX_BACKUPS down to seconds of history.
  // The periodic timestamped backups in backupSessions() remain the deep history.)
  try {
    if (fs.existsSync(SESSIONS_FILE)) fs.copyFileSync(SESSIONS_FILE, SESSIONS_BAK);
  } catch (err) {
    console.error('[Persistence] Failed to roll .bak:', err);
  }
  const persisted: PersistedSession[] = sessions.map((s) => ({
    id: s.id,
    config: s.config,
    origin: s.origin,
    sdkSessionId: s.sdkSessionId,
    totalCostUsd: s.totalCostUsd,
    contextUsage: s.contextUsage,
    messages: trimMessagesForPersist(s.messages),
    permissionMode: s.permissionMode,
    summary: s.summary,
    summaryGeneratedAt: s.summaryGeneratedAt,
    compactedContext: s.compactedContext,
    notes: s.notes,
    notesUpdatedAt: s.notesUpdatedAt,
    pendingWakeup: s.pendingWakeup,
    pendingPlan: s.pendingPlan,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
    threads: s.threads.map((t) => ({ ...t, messages: trimMessagesForPersist(t.messages) })),
    activeThreadId: s.activeThreadId,
    activeThreadName: s.activeThreadName,
  }));
  atomicWrite(SESSIONS_FILE, JSON.stringify(persisted, null, 2));
}

/** Try to read a sessions file; returns the parsed array, or null if missing/unparseable. */
function tryReadSessions(file: string): PersistedSession[] | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Find the newest usable session list among recovery sources: the rolling .bak first,
 *  then timestamped backups newest-first. Returns null if none are usable. */
function recoverSessions(): PersistedSession[] | null {
  const fromBak = tryReadSessions(SESSIONS_BAK);
  if (fromBak) {
    console.error(`[Persistence] Recovered ${fromBak.length} session(s) from ${SESSIONS_BAK}`);
    return fromBak;
  }
  try {
    const backupsRoot = path.join(CLAUDER_DIR, 'backups');
    const dirs = fs.readdirSync(backupsRoot).filter(e => e.startsWith('backup-')).sort();
    for (let i = dirs.length - 1; i >= 0; i--) {
      const file = path.join(backupsRoot, dirs[i], 'sessions.json');
      const recovered = tryReadSessions(file);
      if (recovered) {
        console.error(`[Persistence] Recovered ${recovered.length} session(s) from ${file}`);
        return recovered;
      }
    }
  } catch { /* no backups dir */ }
  return null;
}

export function loadSessions(): PersistedSession[] {
  // Missing file = genuinely fresh install. Safe to start empty.
  if (!fs.existsSync(SESSIONS_FILE)) return [];

  const parsed = tryReadSessions(SESSIONS_FILE);
  if (parsed) return parsed;

  // The file EXISTS but is unparseable. Returning [] here would let the next debounced
  // save overwrite it with an empty list — turning one bad write into permanent total loss.
  // Instead: preserve the corrupt file for forensics, then recover from a backup.
  console.error('[Persistence] sessions.json exists but is unparseable — attempting recovery');
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    fs.copyFileSync(SESSIONS_FILE, path.join(CLAUDER_DIR, `sessions.corrupt-${stamp}.json`));
  } catch (err) {
    console.error('[Persistence] Failed to preserve corrupt file:', err);
  }

  const recovered = recoverSessions();
  if (recovered) return recovered;

  // Nothing to recover from. Abort startup LOUDLY rather than silently starting empty
  // and overwriting the (recoverable-by-hand) corrupt file. Jonathan inspects ~/.clauder/.
  throw new Error(
    'sessions.json is corrupt and no usable backup was found. Refusing to start with an ' +
    'empty session list (which would overwrite recoverable data). Inspect ~/.clauder/ ' +
    '(sessions.corrupt-*.json, sessions.json.bak, backups/) and restore manually.',
  );
}
