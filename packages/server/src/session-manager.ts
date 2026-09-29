import { ManagedSession } from './session.js';
import type { SessionConfig, SessionState, PermissionMode, ImageAttachment, FileAttachment, EffortLevel, MessageAuthor } from '@clauder/shared';
import type { WsOutboundMessage } from '@clauder/shared';
import { toClientState } from './client-view.js';
import { saveSessions, loadSessions, type SessionStateForPersist } from './persistence.js';
import { archiveSession as runArchive, type ArchiveStage } from './archive.js';
import { existsSync } from 'fs';
import { DEFAULT_MODEL } from './models.js';

const MAX_SESSIONS = 100;
const SUMMARY_DELAY_MS = 4 * 60 * 60 * 1000; // 4 hours

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private broadcast: (msg: WsOutboundMessage) => void;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pauseUntil: string | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private summaryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Sessions already warned about a missing cwd (unmounted volume etc.) — log once, not per cycle. */
  private warnedMissingCwd = new Set<string>();
  private triggerCreator: ((input: { sessionId: string; message: string; description: string; at: string }) => void) | null = null;
  /** Writes the note Claude reads ahead of a guest's message (shares.ts guestNote). */
  private authorDescriber: ((author: MessageAuthor) => string) | null = null;
  private destroyListeners: ((sessionId: string) => void)[] = [];

  constructor(broadcast: (msg: WsOutboundMessage) => void) {
    this.broadcast = broadcast;
  }

  /** Wire up trigger creation so sessions can schedule themselves via <<schedule_trigger>> sentinels. */
  setTriggerCreator(fn: (input: { sessionId: string; message: string; description: string; at: string }) => void): void {
    this.triggerCreator = fn;
    // Apply to existing sessions (e.g. restored sessions)
    for (const session of this.sessions.values()) {
      session.onScheduleTrigger = fn;
    }
  }

  /** Wire up guest attribution for share links (index.ts), for every session now and later. */
  setAuthorDescriber(fn: (author: MessageAuthor) => string): void {
    this.authorDescriber = fn;
    for (const session of this.sessions.values()) session.describeAuthor = fn;
  }

  /** Called with a session's id after it's destroyed, e.g. to revoke its share links. */
  onSessionDestroyed(fn: (sessionId: string) => void): void {
    this.destroyListeners.push(fn);
  }

  /** Restore sessions from disk. Call once at startup after broadcast is wired. */
  restoreFromDisk(): void {
    const persisted = loadSessions();
    if (persisted.length === 0) return;

    console.log(`[SessionManager] Restoring ${persisted.length} session(s) from disk`);
    for (const data of persisted) {
      try {
        const session = ManagedSession.restore(data, this.broadcast);
        if (this.triggerCreator) session.onScheduleTrigger = this.triggerCreator;
        if (this.authorDescriber) session.describeAuthor = this.authorDescriber;
        this.sessions.set(session.id, session);
        console.log(`  - Restored: ${data.config.name} (${data.id})`);
        // Schedule summary if session has been idle long enough and has no summary
        this.scheduleSummary(session.id);
      } catch (err) {
        console.error(`  - Failed to restore session ${data.id}:`, err);
      }
    }
  }

  private persist(): void {
    // Debounce saves to avoid hammering disk during rapid updates
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      saveSessions(this.getAllSessionsForPersist());
    }, 500);
  }

  /** Force an immediate save (e.g. before shutdown) */
  persistNow(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    saveSessions(this.getAllSessionsForPersist());
  }

  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values()).map(s => s.getState());
  }

  /** Same as getAllSessions() but with full ParkedThread[] (message bodies included) instead of
   *  the lightweight ThreadSummary[] the client sees — getState() intentionally keeps parked
   *  message content off the wire, but the disk copy needs it to resume a thread after a
   *  restart. See SessionStateForPersist. */
  private getAllSessionsForPersist(): SessionStateForPersist[] {
    return Array.from(this.sessions.values()).map(s => ({ ...s.getState(), threads: s.threads }));
  }

  getSession(id: string): ManagedSession | undefined {
    return this.sessions.get(id);
  }

  createSession(config: SessionConfig): SessionState {
    // The scratch session is exempt from the cap — it's auto-created and the user
    // shouldn't be punished for using it.
    if (!config.isScratch && this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Maximum of ${MAX_SESSIONS} sessions reached`);
    }

    // Strip surrounding quotes from cwd (common copy-paste artifact). Every session gets a model:
    // without one the CLI runs its own default while the picker shows Clauder's (adopting a VS
    // Code session sends none).
    const sanitizedConfig = {
      ...config,
      cwd: config.cwd.replace(/^['"](.*)['"]$/, '$1').trim(),
      model: config.model || DEFAULT_MODEL,
    };

    const session = new ManagedSession(sanitizedConfig, this.broadcast);
    if (this.triggerCreator) session.onScheduleTrigger = this.triggerCreator;
    if (this.authorDescriber) session.describeAuthor = this.authorDescriber;
    this.sessions.set(session.id, session);

    const state = session.getState();
    this.broadcast({ type: 'session_created', session: toClientState(state) });
    session.broadcastSkills();
    this.persist();
    return state;
  }

  async sendMessage(sessionId: string, message: string, images?: ImageAttachment[], opts?: { internal?: boolean; planMode?: boolean; files?: FileAttachment[]; model?: string; effort?: string; author?: MessageAuthor }): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // If paused, queue instead of sending
    if (this.pauseUntil && new Date(this.pauseUntil).getTime() > Date.now()) {
      session.queueMessage(message, images, { internal: opts?.internal, files: opts?.files, model: opts?.model, effort: opts?.effort, author: opts?.author });
      return;
    }

    // Don't await - let it run in the background while streaming events
    session.sendMessage(message, images, opts && { ...opts, effort: opts.effort as EffortLevel | undefined }).then(() => {
      this.persist();
      this.scheduleSummary(sessionId);
    }).catch(err => {
      console.error(`Error in session ${sessionId}:`, err);
      this.persist();
      this.scheduleSummary(sessionId);
    });
  }

  async compactSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    session.compact().then(() => {
      this.persist();
    }).catch(err => {
      console.error(`Error compacting session ${sessionId}:`, err);
    });
  }

  async resetSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    console.log(`[SessionManager] Resetting SDK session for ${sessionId} (was: ${session.sdkSessionId})`);
    session.reset();
    this.persist();
  }

  async clearSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    console.log(`[SessionManager] Clearing session ${sessionId}`);
    session.clearMessages();
    this.persist();
  }

  parkThread(sessionId: string, name?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    console.log(`[SessionManager] Parking thread for session ${sessionId}`);
    session.parkThread(name);
    this.persist();
  }

  resumeThread(sessionId: string, threadId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    console.log(`[SessionManager] Resuming thread ${threadId} for session ${sessionId}`);
    session.resumeThread(threadId);
    this.persist();
  }

  discardThread(sessionId: string, threadId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.discardThread(threadId);
    this.persist();
  }

  renameThread(sessionId: string, threadId: string, name: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.renameThread(threadId, name);
    this.persist();
  }

  startTask(sessionId: string, opts: { name: string; model?: string; effort?: string }): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    console.log(`[SessionManager] Starting task "${opts.name}" for session ${sessionId}`);
    session.startTask({ name: opts.name, model: opts.model, effort: opts.effort as EffortLevel | undefined });
    this.persist();
  }

  dequeueMessage(sessionId: string, index: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.dequeueMessage(index);
  }

  async interruptSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    await session.interrupt();
    this.persist();
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (session.config.isScratch) {
      throw new Error('Scratch session cannot be destroyed — use Clear instead.');
    }
    await session.destroy();
    this.sessions.delete(sessionId);
    const summaryTimer = this.summaryTimers.get(sessionId);
    if (summaryTimer) { clearTimeout(summaryTimer); this.summaryTimers.delete(sessionId); }
    this.broadcast({ type: 'session_destroyed', sessionId });
    this.persist();
    for (const fn of this.destroyListeners) {
      try { fn(sessionId); } catch (err) { console.error('[SessionManager] destroy listener failed:', err); }
    }
  }

  /** Archive a project: AI wrap-up → zip → verify → move the project dir to Trash → destroy
   *  the session. See archive.ts for THE SAFETY INVARIANT — the directory is only ever touched
   *  after a verified zip exists. Returns the final zip path. */
  async archiveSession(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const others = [...this.sessions.values()].filter(s => s.id !== sessionId);
    const { zipPath } = await runArchive(session, others, (stage: ArchiveStage, message: string) => {
      this.broadcast({ type: 'archive_status', sessionId, stage, message });
    });
    await this.destroySession(sessionId); // removes from map, persists, broadcasts session_destroyed
    this.broadcast({ type: 'archive_complete', sessionId, zipPath });
    return zipPath;
  }

  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    await session.setPermissionMode(mode);
    this.persist();
  }

  respondToPermission(_sessionId: string, _toolUseId: string, _decision: 'allow' | 'deny', _message?: string): void {
    // No-op in v2: permission mode is a CLI startup flag, not an interactive callback.
    // The server never sends permission_request events, so this is never called in practice.
  }

  respondToQuestion(sessionId: string, toolUseId: string, answer: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.respondToQuestion(toolUseId, answer);
  }

  renameSession(sessionId: string, newName: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.rename(newName);
    this.persist();
  }

  updateCwd(sessionId: string, cwd: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.setCwd(cwd);
    this.persist();
  }

  setModel(sessionId: string, model: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.setModel(model);
    this.persist();
  }

  setEffort(sessionId: string, effort: string | undefined): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.setEffort(effort);
    this.persist();
  }

  setGoal(sessionId: string, goal: { text: string; checkEveryMin?: number; deadlineHours?: number; maxNudges?: number } | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.setGoal(goal);
    this.persist();
  }

  setNotes(sessionId: string, notes: string | null): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.setNotes(notes);
    this.persist();
  }

  setPinned(sessionId: string, pinned: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.setPinned(pinned);
    this.persist();
  }

  setTags(sessionId: string, tags: string[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.setTags(tags);
    this.persist();
  }

  /** Strip a deleted tag id from every session that carries it (delete cascade from the tag
   *  registry). Persists once at the end. */
  removeTagFromAllSessions(tagId: string): void {
    let changed = false;
    for (const session of this.sessions.values()) {
      const tags = session.config.tags;
      if (tags && tags.includes(tagId)) {
        session.setTags(tags.filter(t => t !== tagId));
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  stopModelPlan(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.stopModelPlan();
    this.persist();
  }

  setMessagePinned(sessionId: string, messageId: string, pinned: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.setMessagePinned(messageId, pinned);
    this.persist();
  }

  cancelWakeup(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.cancelWakeup();
    this.persist();
  }

  stopMonitor(sessionId: string, monitorId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.monitors.stop(monitorId, false);
  }

  async generateSessionSummary(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const summary = await session.generateSummary();
    session.summary = summary;
    session.summaryGeneratedAt = new Date().toISOString();
    this.broadcast({
      type: 'summary_generated',
      sessionId: session.id,
      summary,
      summaryGeneratedAt: session.summaryGeneratedAt,
    });
    this.persist();
  }

  private scheduleSummary(sessionId: string): void {
    // Clear any existing timer for this session
    const existing = this.summaryTimers.get(sessionId);
    if (existing) clearTimeout(existing);

    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Calculate delay: 4 hours from lastActiveAt
    const lastActive = new Date(session.lastActiveAt).getTime();
    const targetTime = lastActive + SUMMARY_DELAY_MS;
    const delay = Math.max(0, targetTime - Date.now());

    // If already past 4 hours and no summary, generate immediately (with a small delay to not block startup)
    // If has a summary already, still schedule for next update
    // Stagger startup summaries: each session gets an extra 15s offset to avoid spawning many processes at once
    const staggerOffset = delay < 1000 ? (this.summaryTimers.size * 15_000 + 10_000) : 0;
    const timer = setTimeout(() => {
      this.summaryTimers.delete(sessionId);
      // Only generate if the session hasn't been active since we scheduled
      const s = this.sessions.get(sessionId);
      if (!s) return;
      const elapsed = Date.now() - new Date(s.lastActiveAt).getTime();
      // Skip when the existing summary already covers all activity — without this, every
      // server restart regenerated a summary for EVERY restored idle session (36 CLI spawns
      // in a row in the log), even though nothing had changed since the last one.
      const summaryCurrent = !!s.summaryGeneratedAt
        && new Date(s.summaryGeneratedAt).getTime() >= new Date(s.lastActiveAt).getTime();
      // Skip (with a once-per-run warning) when the cwd is gone — e.g. a session on an
      // unmounted network volume. Spawning would just throw "Working directory does not
      // exist" on every cycle, which is exactly the retry-forever spam seen in prod.
      if (!existsSync(s.config.cwd)) {
        if (!this.warnedMissingCwd.has(sessionId)) {
          this.warnedMissingCwd.add(sessionId);
          console.warn(`[SessionManager] Skipping summaries for "${s.config.name}" (${sessionId}) — cwd missing: ${s.config.cwd} (volume unmounted?)`);
        }
        return;
      }
      this.warnedMissingCwd.delete(sessionId); // cwd is back — allow future warnings if it vanishes again
      if (elapsed >= SUMMARY_DELAY_MS && !summaryCurrent) {
        console.log(`[SessionManager] Generating summary for session ${sessionId}`);
        this.generateSessionSummary(sessionId).catch(err => {
          console.error(`[SessionManager] Summary generation failed for ${sessionId}:`, err);
        });
      }
    }, delay < 1000 ? staggerOffset : delay);

    this.summaryTimers.set(sessionId, timer);
  }

  clearSummaryTimers(): void {
    for (const timer of this.summaryTimers.values()) {
      clearTimeout(timer);
    }
    this.summaryTimers.clear();
  }

  async destroyAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys()).filter(
      id => !this.sessions.get(id)?.config.isScratch
    );
    await Promise.all(ids.map(id => this.destroySession(id)));
  }

  /** Kill all child processes without modifying session state or re-persisting.
   *  Use this at shutdown so persistNow()'s save isn't overwritten by deletions. */
  async terminateAll(): Promise<void> {
    const sessions = Array.from(this.sessions.values());
    await Promise.all(sessions.map(s => s.destroy()));
  }

  // ─── Pause / Resume ─────────────────────────────────────────────────────────

  getPauseUntil(): string | null {
    if (this.pauseUntil && new Date(this.pauseUntil).getTime() <= Date.now()) {
      this.pauseUntil = null;
    }
    return this.pauseUntil;
  }

  pauseSessions(pauseUntil: string): void {
    const untilMs = new Date(pauseUntil).getTime();
    const delayMs = untilMs - Date.now();
    if (delayMs <= 0) return;

    this.pauseUntil = pauseUntil;
    this.broadcast({ type: 'pause_update', pauseUntil: this.pauseUntil });
    console.log(`[SessionManager] All sessions paused until ${this.pauseUntil}`);

    // Set timer to auto-resume and drain queues
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = setTimeout(() => {
      this.resumeSessions();
    }, delayMs);
  }

  resumeSessions(): void {
    if (this.pauseTimer) {
      clearTimeout(this.pauseTimer);
      this.pauseTimer = null;
    }
    this.pauseUntil = null;
    this.broadcast({ type: 'pause_update', pauseUntil: null });
    console.log('[SessionManager] Sessions resumed — draining queued messages');

    // Drain all queued messages across all sessions
    // Use status !== 'working' so error-state sessions also get their queues drained
    for (const session of this.sessions.values()) {
      const state = session.getState();
      if (state.queuedMessages.length > 0 && state.status !== 'working') {
        const next = session.queuedMessages.shift()!;
        this.broadcast({
          type: 'queue_update',
          sessionId: session.id,
          queue: [...session.queuedMessages],
        });
        // Carry every option the message was queued with. Above all `author`: without it a guest's
        // message would reach Claude as the owner's.
        session.sendMessage(next.text, next.images, { internal: next.internal, files: next.files, model: next.model, effort: next.effort as EffortLevel | undefined, author: next.author }).then(() => {
          this.persist();
        }).catch(err => {
          console.error(`Error draining queue for session ${session.id}:`, err);
          this.persist();
        });
      }
    }
  }
}
