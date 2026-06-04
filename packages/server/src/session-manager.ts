import { ManagedSession } from './session.js';
import type { SessionConfig, SessionState, PermissionMode, ImageAttachment } from '@clauder/shared';
import type { WsOutboundMessage } from '@clauder/shared';
import { saveSessions, loadSessions } from './persistence.js';

const MAX_SESSIONS = 100;
const SUMMARY_DELAY_MS = 4 * 60 * 60 * 1000; // 4 hours

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private broadcast: (msg: WsOutboundMessage) => void;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private pauseUntil: string | null = null;
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  private summaryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(broadcast: (msg: WsOutboundMessage) => void) {
    this.broadcast = broadcast;
  }

  /** Restore sessions from disk. Call once at startup after broadcast is wired. */
  restoreFromDisk(): void {
    const persisted = loadSessions();
    if (persisted.length === 0) return;

    console.log(`[SessionManager] Restoring ${persisted.length} session(s) from disk`);
    for (const data of persisted) {
      try {
        const session = ManagedSession.restore(data, this.broadcast);
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
      saveSessions(this.getAllSessions());
    }, 500);
  }

  /** Force an immediate save (e.g. before shutdown) */
  persistNow(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    saveSessions(this.getAllSessions());
  }

  getAllSessions(): SessionState[] {
    return Array.from(this.sessions.values()).map(s => s.getState());
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

    // Strip surrounding quotes from cwd (common copy-paste artifact)
    const sanitizedConfig = {
      ...config,
      cwd: config.cwd.replace(/^['"](.*)['"]$/, '$1').trim(),
    };

    const session = new ManagedSession(sanitizedConfig, this.broadcast);
    this.sessions.set(session.id, session);

    const state = session.getState();
    this.broadcast({ type: 'session_created', session: state });
    session.broadcastSkills();
    this.persist();
    return state;
  }

  async sendMessage(sessionId: string, message: string, images?: ImageAttachment[], opts?: { internal?: boolean; planMode?: boolean }): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // If paused, queue instead of sending
    if (this.pauseUntil && new Date(this.pauseUntil).getTime() > Date.now()) {
      session.queueMessage(message, images, { internal: opts?.internal });
      return;
    }

    // Don't await - let it run in the background while streaming events
    session.sendMessage(message, images, opts).then(() => {
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

  cancelWakeup(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    session.cancelWakeup();
    this.persist();
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
      if (elapsed >= SUMMARY_DELAY_MS) {
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
        session.sendMessage(next.text, next.images).then(() => {
          this.persist();
        }).catch(err => {
          console.error(`Error draining queue for session ${session.id}:`, err);
          this.persist();
        });
      }
    }
  }
}
