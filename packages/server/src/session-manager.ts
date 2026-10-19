import { v4 as uuid } from 'uuid';
import { ManagedSession } from './session.js';
import type { SessionConfig, SessionState, PermissionMode, ImageAttachment, FileAttachment, EffortLevel, MessageAuthor, ParkedThread } from '@clauder/shared';
import type { WsOutboundMessage } from '@clauder/shared';
import { projectFolderProblem, SCRATCH_EXPIRY_DAYS, SCRATCH_NEW_NAME, SCRATCH_CONVERSATION_MODEL, SCRATCH_CONVERSATION_EFFORT } from '@clauder/shared';
import { toClientState } from './client-view.js';
import { saveSessions, loadSessions, type SessionStateForPersist } from './persistence.js';
import { archiveSession as runArchive, type ArchiveStage } from './archive.js';
import { existsSync } from 'fs';
import { DEFAULT_MODEL } from './models.js';
import { removeTaskRoster } from './task-roster.js';
import {
  projectIdOf, writeProjectRoster, mainProjectNote, relayNote, crossRelayNote, canMessageNote, spinOffRequest, clip, NOTES_REMINDER,
  MAX_TASKS_PER_PROJECT, MAX_RELAYS_WITHOUT_OWNER,
} from './project.js';
import { FolderNotes, type NoteSession } from './folder-notes.js';
import { ProjectNotes } from './project-notes.js';
import { runClaudeOneShot } from './claude-oneshot.js';
import { transcriptFor } from './status-reports.js';
import type { ApiCredits } from './api-credits.js';
import { subscriptionBlockedUntilMs } from './rate-limits.js';
import { nameFromMessage, handoffRequest, handoffMessage } from './scratch.js';
import { ensureProjectFolder, devRootForDisplay } from './projects.js';

const MAX_SESSIONS = 100;
const SUMMARY_DELAY_MS = 4 * 60 * 60 * 1000; // 4 hours
const DAY_MS = 24 * 60 * 60 * 1000;
/** Scratch conversations held at most (scratch.ts). At the cap, starting one deletes the oldest
 *  that isn't kept or busy. They don't count toward MAX_SESSIONS. */
const MAX_SCRATCH_CONVERSATIONS = 60;
/** A Scratch conversation opened but never written in goes after this long. */
const EMPTY_SCRATCH_MS = DAY_MS;

/** Where a Scratch conversation is handed off to (scratchHandoff). */
export type HandoffTarget = { kind: 'new_project'; folder: string } | { kind: 'task'; projectId: string };

const samePath = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
const hasConversation = (s: ManagedSession) => s.messages.some(m => m.role === 'user' || m.role === 'assistant');

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
  /** Projects (project.ts): messages a project's sessions have sent each other since the owner
   *  last wrote in it, by project id — the guard against two Claudes messaging back and forth. */
  private relayCounts = new Map<string, number>();
  private rosterTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The project of sessions destroyed lately, so their last events still reach that project's guests. */
  private destroyedProjects = new Map<string, string>();
  /** Notes for a session when another changes files in its folder (folder-notes.ts). */
  private folderNotes: FolderNotes;
  /** Each project's shared notes board (project-notes.ts). */
  private projectNotes = new ProjectNotes();
  /** Scratch conversations asked for a handoff note, and where it goes once written (scratchHandoff). */
  private pendingHandoffs = new Map<string, { name: string; target: HandoffTarget }>();
  /** Whether something still needs a Scratch conversation, so it doesn't expire (a trigger aimed at it). */
  private scratchKeepAlive: (sessionId: string) => boolean = () => false;
  /** API credits for when the subscription is out of usage (api-credits.ts). */
  private apiCredits: ApiCredits | null = null;
  /** <<to_session>> between projects: messages sent within a pair of projects since a person last
   *  wrote in either (the same loop guard as within a project), by "projA|projB". */
  private crossCounts = new Map<string, number>();
  /** A project that got a message from another may answer it for a day, whitelisted or not:
   *  receiving project -> (sending project -> until, epoch ms). */
  private replyWindows = new Map<string, Map<string, number>>();
  /** Whether a project is shared with a guest (index.ts); those never send or receive <<to_session>>. */
  private isShared: (projectId: string) => boolean = () => false;

  constructor(broadcast: (msg: WsOutboundMessage) => void) {
    this.broadcast = broadcast;
    this.folderNotes = new FolderNotes({
      sessions: () => this.noteSessions(),
      tell: (id, text) => { this.sessions.get(id)?.emitSystemMessage(text); this.persist(); },
    });
    this.folderNotes.load();
    this.projectNotes.load();
  }

  /** Hand a session its hooks into the rest of Clauder (on create, restore and migration). */
  private wire(session: ManagedSession): void {
    if (this.triggerCreator) session.onScheduleTrigger = this.triggerCreator;
    if (this.authorDescriber) session.describeAuthor = this.authorDescriber;
    session.onProjectMessage = (m) => this.deliverProjectMessage(session.id, m);
    session.onNewTask = (m) => this.taskFromSentinel(session.id, m);
    session.describeProject = () => this.projectNoteFor(session.id);
    if (this.apiCredits) session.apiCredits = this.apiCredits;
  }

  /** Tell <<to_session>> which projects are shared with guests (index.ts). */
  setIsShared(fn: (projectId: string) => boolean): void {
    this.isShared = fn;
  }

  /** Which sessions a project may message with <<to_session>> (main session ids). */
  setCanMessage(sessionId: string, ids: string[]): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    const main = this.sessions.get(projectIdOf(s)) ?? s;
    const clean = [...new Set(ids)].filter(id => id !== main.id && this.sessions.get(id) && !this.sessions.get(id)!.config.mainSessionId && !this.sessions.get(id)!.config.isScratch);
    if (clean.length) main.updateConfig({ canMessage: clean });
    else main.updateConfig({}, ['canMessage']);
    this.persist();
  }

  /** Wire up API credits (index.ts), for every session now and later. */
  setApiCredits(ac: ApiCredits): void {
    this.apiCredits = ac;
    for (const session of this.sessions.values()) session.apiCredits = ac;
  }

  /** Let a session run on API credits when the subscription is out of usage, or stop letting it.
   *  Allowing one that is asleep on the limit right now wakes it, if credits can be used. */
  setApiAllowed(sessionId: string, allowed: boolean): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    if (allowed) s.updateConfig({ apiCredits: true });
    else s.updateConfig({}, ['apiCredits']);
    this.persist();
    if (allowed && this.apiCredits && !this.apiCredits.whyNot(true)) s.approveApiNow(s.apiApprovedUntilMs);
  }

  /** The owner chose "use API credits" for a session sleeping on the usage limit: it carries on now,
   *  and keeps using them for the rest of this outage. */
  useApiCreditsNow(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    const why = this.apiCredits ? this.apiCredits.whyNot(true) : 'API credits are not set up.';
    if (why) throw new Error(why);
    s.approveApiNow(subscriptionBlockedUntilMs() ?? Date.now() + 6 * 60 * 60 * 1000);
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
        this.wire(session);
        this.sessions.set(session.id, session);
        console.log(`  - Restored: ${data.config.name} (${data.id})`);
        // Schedule summary if session has been idle long enough and has no summary
        this.scheduleSummary(session.id);
      } catch (err) {
        console.error(`  - Failed to restore session ${data.id}:`, err);
      }
    }
    this.migrateParkedThreads();
    this.splitScratch();
    for (const s of this.sessions.values()) if (!s.config.mainSessionId && this.tasksOf(s.id).length) this.writeRoster(s.id);
  }

  /** A parked conversation as a session of its own, added to the map. `owner` is the session it
   *  was parked in; `config` adds to (or overrides) the config it gets from there. */
  private sessionFromThread(owner: ManagedSession, t: ParkedThread, config: Partial<SessionConfig>, extra?: { notes?: string | null; notesUpdatedAt?: string | null; lastActiveAt?: string }): ManagedSession {
    const session = ManagedSession.restore({
      id: uuid(),
      config: {
        name: t.name || 'Task',
        cwd: t.cwd,
        model: t.model ?? owner.config.model,
        effort: t.effort ?? owner.config.effort,
        permissionMode: owner.config.permissionMode,
        questionTimeoutSeconds: owner.config.questionTimeoutSeconds,
        ...config,
      },
      origin: 'clauder',
      sdkSessionId: t.sdkSessionId,
      totalCostUsd: t.sdkCostSoFar ?? 0,
      contextUsage: t.contextUsage,
      messages: t.messages,
      permissionMode: owner.permissionMode,
      summary: t.summary,
      summaryGeneratedAt: t.summaryGeneratedAt,
      compactedContext: t.compactedContext,
      notes: extra?.notes ?? null,
      notesUpdatedAt: extra?.notesUpdatedAt ?? null,
      pendingWakeup: t.pendingWakeup,
      pendingPlan: t.pendingPlan,
      activeThreadId: t.id,
      activeThreadName: t.name,
      createdAt: t.messages[0]?.timestamp ?? t.parkedAt,
      lastActiveAt: extra?.lastActiveAt ?? t.lastActiveAt,
    }, this.broadcast);
    this.wire(session);
    this.sessions.set(session.id, session);
    return session;
  }

  /** Tasks used to be parked conversations inside one session; now each is a session of its own.
   *  Moves any parked conversation left from before into its own session: a task of the same
   *  project if it was parked in the session's folder, otherwise a standalone session in its own.
   *  One-time: the parked list is emptied once moved, and the result saved. */
  private migrateParkedThreads(): void {
    let moved = 0;
    for (const main of [...this.sessions.values()]) {
      if (!main.threads.length || main.config.isScratch) continue;
      for (const t of main.threads) {
        try {
          const sameFolder = t.cwd === main.config.cwd && !main.config.mainSessionId;
          const task = this.sessionFromThread(main, t, sameFolder ? { mainSessionId: main.id } : {});
          moved++;
          console.log(`[SessionManager] Moved parked task "${t.name}" out of "${main.config.name}" into its own session (${task.id})${sameFolder ? '' : ' (different folder: standalone)'}`);
        } catch (err) {
          console.error(`[SessionManager] Couldn't move parked task "${t.name}" out of "${main.config.name}":`, err);
        }
      }
      main.threads = [];
    }
    if (moved) this.persist();
  }

  /** Scratch used to be one conversation; now it holds many, each a session (scratch.ts). Moves the
   *  conversation Scratch had, and any it had parked, into Scratch conversations, and leaves Scratch
   *  itself empty: scheduled jobs aimed at it still run there. One-time, marked by scratchSplitAt. */
  private splitScratch(): void {
    const main = this.scratchMain();
    if (!main || main.config.scratchSplitAt) return;
    const hadLive = hasConversation(main);
    try {
      if (hadLive) main.parkThread('Earlier Scratch');
    } catch (err) {
      console.error('[SessionManager] Couldn\'t split Scratch into conversations; trying again at the next start:', err);
      return;
    }
    // A conversation moved out gets at least a week before it can expire.
    const floor = new Date(Date.now() - (SCRATCH_EXPIRY_DAYS - 7) * DAY_MS).toISOString();
    main.threads.forEach((t, i) => {
      const notes = i === 0 && hadLive && main.notes ? { notes: main.notes, notesUpdatedAt: main.notesUpdatedAt } : {};
      const conv = this.sessionFromThread(main, t, { mainSessionId: main.id, scratchConversation: true },
        { ...notes, lastActiveAt: t.lastActiveAt > floor ? t.lastActiveAt : floor });
      console.log(`[SessionManager] Moved "${t.name}" out of Scratch into a Scratch conversation (${conv.id})`);
    });
    if (hadLive && main.notes) main.setNotes(null);
    main.threads = [];
    main.updateConfig({ scratchSplitAt: new Date().toISOString() });
    this.persist();
  }

  private scratchMain(): ManagedSession | undefined {
    for (const s of this.sessions.values()) if (s.config.isScratch) return s;
    return undefined;
  }

  /** Every session as folder notes see it. Scratch's folder is a shared scratchpad, so nobody
   *  working in it is told about changes there. */
  private noteSessions(): NoteSession[] {
    const scratchCwd = this.scratchMain()?.config.cwd;
    return [...this.sessions.values()].map(s => ({
      id: s.id,
      name: s.config.name,
      cwd: s.config.cwd,
      projectId: projectIdOf(s),
      scratch: !!(s.config.isScratch || s.config.scratchConversation) || (!!scratchCwd && samePath(s.config.cwd, scratchCwd)),
    }));
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
    this.projectNotes.saveNow();
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

  /** `asTaskOf` makes it a task of that project (createTask); a config can't claim that itself. */
  createSession(config: SessionConfig, asTaskOf?: string): SessionState {
    // A task of Scratch is a Scratch conversation (scratch.ts).
    const scratchConversation = !!(asTaskOf && this.sessions.get(asTaskOf)?.config.isScratch);
    // Scratch and its conversations are exempt from the cap: Scratch is auto-created, and its
    // conversations have a cap and an expiry of their own.
    const counted = [...this.sessions.values()].filter(s => !s.config.isScratch && !s.config.scratchConversation).length;
    if (!config.isScratch && !scratchConversation && counted >= MAX_SESSIONS) {
      throw new Error(`Maximum of ${MAX_SESSIONS} sessions reached`);
    }

    // Strip surrounding quotes from cwd (common copy-paste artifact). Every session gets a model:
    // without one the CLI runs its own default while the picker shows Clauder's (adopting a VS
    // Code session sends none).
    const { mainSessionId: _ignored, scratchConversation: _scratch, keep: _keep, ...rest } = config;
    const sanitizedConfig: SessionConfig = {
      ...rest,
      cwd: config.cwd.replace(/^['"](.*)['"]$/, '$1').trim(),
      model: config.model || DEFAULT_MODEL,
      ...(asTaskOf ? { mainSessionId: asTaskOf } : {}),
      ...(scratchConversation ? { scratchConversation: true } : {}),
    };

    const session = new ManagedSession(sanitizedConfig, this.broadcast);
    this.wire(session);
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

    // A person wrote in this project (the owner, or a guest): its sessions may message each other again.
    if (!opts?.internal) {
      const pid = projectIdOf(session);
      this.relayCounts.delete(pid);
      for (const k of this.crossCounts.keys()) if (k.split('|').includes(pid)) this.crossCounts.delete(k);
    }

    // A new Scratch conversation is named after the first thing asked in it.
    if (!opts?.internal && session.config.scratchConversation && session.config.name === SCRATCH_NEW_NAME) {
      const name = nameFromMessage(message);
      if (name) session.rename(name);
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
    // A project's main session takes its tasks with it.
    for (const task of this.tasksOf(sessionId)) await this.destroySession(task.id);
    this.destroyedProjects.set(sessionId, projectIdOf(session));
    if (this.destroyedProjects.size > 200) this.destroyedProjects.delete(this.destroyedProjects.keys().next().value!);
    await session.destroy();
    this.sessions.delete(sessionId);
    this.folderNotes.removeSession(sessionId);
    this.projectNotes.removeSession(sessionId);
    if (!session.config.mainSessionId) this.projectNotes.removeProject(sessionId);
    this.pendingHandoffs.delete(sessionId);
    const summaryTimer = this.summaryTimers.get(sessionId);
    if (summaryTimer) { clearTimeout(summaryTimer); this.summaryTimers.delete(sessionId); }
    this.broadcast({ type: 'session_destroyed', sessionId });
    this.persist();
    if (session.config.mainSessionId) this.tasksChanged(session.config.mainSessionId);
    else this.relayCounts.delete(sessionId);
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
    // A project is archived whole, from its main session: the folder goes, so its tasks go too.
    if (session.config.scratchConversation) throw new Error("A Scratch conversation can't be archived. Delete it instead.");
    if (session.config.mainSessionId) throw new Error('This is a task. Archive the project from its main session.');
    const tasks = this.tasksOf(sessionId);
    if (tasks.some(t => t.status === 'working')) {
      throw new Error('A task in this project is still working. Stop it or let it finish, then archive.');
    }
    const others = [...this.sessions.values()].filter(s => s.id !== sessionId && s.config.mainSessionId !== sessionId);
    const { zipPath } = await runArchive(session, others, (stage: ArchiveStage, message: string) => {
      this.broadcast({ type: 'archive_status', sessionId, stage, message });
    });
    await this.destroySession(sessionId); // removes it and its tasks, persists, broadcasts session_destroyed
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

    // Scratch conversations are quick and many: no automatic summaries (one can still be asked for).
    const session = this.sessions.get(sessionId);
    if (!session || session.config.scratchConversation) return;

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

  // ─── Projects (project.ts) ──────────────────────────────────────────────────
  // A project is a main session plus tasks: sessions with config.mainSessionId pointing at it, in
  // the same folder, free to run alongside it. Only the main session commits.

  /** The project (main session id) a session belongs to, also for one destroyed lately; null if unknown. */
  projectIdOfAny(id: string): string | null {
    const s = this.sessions.get(id);
    return s ? projectIdOf(s) : this.destroyedProjects.get(id) ?? null;
  }

  /** A project's sessions, main first. */
  projectSessions(mainId: string): ManagedSession[] {
    const main = this.sessions.get(mainId);
    return main ? [main, ...this.tasksOf(mainId)] : [];
  }

  /** A main session's tasks. */
  tasksOf(mainId: string): ManagedSession[] {
    return [...this.sessions.values()].filter(s => s.config.mainSessionId === mainId);
  }

  /** A project's main session and tasks, from any session in it. */
  private projectOf(id: string): { main: ManagedSession; tasks: ManagedSession[] } | null {
    const s = this.sessions.get(id);
    const main = s && this.sessions.get(projectIdOf(s));
    return main ? { main, tasks: this.tasksOf(main.id) } : null;
  }

  /** The notes on a message to a session: for a main session with tasks, the project's rules (a
   *  task's are in its system prompt); for any session, what others changed in its folder since it
   *  last worked (folder-notes.ts), which are then cleared. */
  private projectNoteFor(id: string): string | null {
    const s = this.sessions.get(id);
    if (!s) return null;
    const tasks = s.config.mainSessionId || s.config.isScratch ? [] : this.tasksOf(id);
    const project = tasks.length ? mainProjectNote(id, tasks.map(t => t.config.name)) : null;
    // A project the owner lets message others is told who and how, on each message (never the system prompt).
    const main = s.config.scratchConversation ? undefined : this.sessions.get(projectIdOf(s));
    const names = (main?.config.canMessage ?? []).map(t => this.sessions.get(t)?.config.name).filter((n): n is string => !!n);
    const reach = names.length ? canMessageNote(names) : null;
    // A project with tasks: its shared notes board — what's new for this session, and how to use it.
    const inProject = !s.config.isScratch && !s.config.scratchConversation && (!!s.config.mainSessionId || tasks.length > 0);
    const board = inProject ? [this.projectNotes.take(projectIdOf(s), id), NOTES_REMINDER].filter(Boolean).join('\n\n') : null;
    return [project, board, reach, this.folderNotes.take(id)].filter(Boolean).join('\n\n') || null;
  }

  /** Claude's note ahead of a message one session of a project sent another. */
  describeRelay(author: MessageAuthor): string {
    if (author.crossProject) return crossRelayNote(author.name);
    const from = author.sessionId ? this.sessions.get(author.sessionId) : undefined;
    return relayNote(author.name, from ? projectIdOf(from) : (author.sessionId ?? ''));
  }

  private writeRoster(mainId: string): void {
    const p = this.projectOf(mainId);
    const closed = this.projectNotes.closed(mainId);
    if (!p || (!p.tasks.length && !closed.length) || p.main.config.isScratch) return;
    writeProjectRoster(p.main.getState(), p.tasks.map(t => t.getState()), closed);
  }

  /** A task came or went: rewrite the project's task list, or, with no tasks left, remove it so
   *  the main session's own (empty) roster comes back. */
  private tasksChanged(mainId: string): void {
    const main = this.sessions.get(mainId);
    if (!main || main.config.isScratch) return;
    if (this.tasksOf(mainId).length || this.projectNotes.closed(mainId).length) this.writeRoster(mainId);
    else { removeTaskRoster(mainId); this.relayCounts.delete(mainId); }
  }

  /** Fed every broadcast (index.ts): folder notes watch each turn's changes, and project task
   *  lists are kept current as their sessions change. */
  onEvent(msg: WsOutboundMessage): void {
    this.folderNotes.observe(msg);
    if (msg.type !== 'state_change' && msg.type !== 'session_renamed') return;
    const s = this.sessions.get(msg.sessionId);
    if (!s || s.config.isScratch || s.config.scratchConversation) return;
    const mainId = projectIdOf(s);
    if (!s.config.mainSessionId && !this.tasksOf(mainId).length) return;
    if (this.rosterTimers.has(mainId)) return;
    const timer = setTimeout(() => { this.rosterTimers.delete(mainId); this.writeRoster(mainId); }, 1000);
    timer.unref();
    this.rosterTimers.set(mainId, timer);
  }

  /** A new task: a session in the project's folder, beside its main session. `projectId` may be any
   *  session of the project. `message` (the owner's, or a handoff from another session, with its
   *  `author`) starts it working. */
  createTask(projectId: string, opts: { name: string; model?: string; effort?: string; message?: string; author?: MessageAuthor }): SessionState {
    const p = this.projectOf(projectId);
    if (!p) throw new Error(`Session ${projectId} not found`);
    const { main, tasks } = p;
    // Scratch's tasks are its conversations (scratch.ts), on their own defaults.
    const scratch = !!main.config.isScratch;
    if (scratch) this.makeRoomInScratch(tasks);
    else if (tasks.length >= MAX_TASKS_PER_PROJECT) throw new Error(`A project can have up to ${MAX_TASKS_PER_PROJECT} tasks.`);
    const state = this.createSession({
      name: clip(opts.name, 80) || (scratch ? SCRATCH_NEW_NAME : 'New task'),
      cwd: main.config.cwd,
      model: opts.model || (scratch ? SCRATCH_CONVERSATION_MODEL : main.config.model),
      effort: (opts.effort as EffortLevel | undefined) || (scratch ? SCRATCH_CONVERSATION_EFFORT : main.config.effort),
      permissionMode: main.permissionMode,
      questionTimeoutSeconds: main.config.questionTimeoutSeconds,
      // A project the owner lets use API credits lets its new tasks use them too.
      ...(main.config.apiCredits && !scratch ? { apiCredits: true } : {}),
    }, main.id);
    this.writeRoster(main.id);
    console.log(`[SessionManager] ${scratch ? 'Scratch conversation' : 'Task'} "${state.config.name}" added to "${main.config.name}" (${state.id})`);
    const message = opts.message?.trim();
    if (message) {
      this.sendMessage(state.id, message, undefined, opts.author ? { internal: true, author: opts.author } : undefined).catch(err => {
        console.error(`[SessionManager] Couldn't start task ${state.id}:`, err);
      });
    }
    return state;
  }

  /** /task: ask this session's Claude for a handoff; its <<new_task>> reply starts the task. */
  spinOffTask(sessionId: string, description: string): void {
    const p = this.projectOf(sessionId);
    if (!p) throw new Error(`Session ${sessionId} not found`);
    if (p.main.config.isScratch) throw new Error('A Scratch conversation can\'t spin off tasks. Use "Make it a session…" to move it into a project.');
    if (p.tasks.length >= MAX_TASKS_PER_PROJECT) throw new Error(`A project can have up to ${MAX_TASKS_PER_PROJECT} tasks.`);
    const what = clip(description, 2_000);
    if (!what) throw new Error('Say what the new task should do, e.g. /task fix the ghost pathing');
    this.relayCounts.delete(p.main.id); // the owner asked for this
    this.sendMessage(sessionId, spinOffRequest(what), undefined, { internal: true }).catch(err => {
      console.error(`[SessionManager] Spin-off request failed for ${sessionId}:`, err);
    });
  }

  /** <<new_task>>: start the task with the handoff, as a message from the session that wrote it. */
  private taskFromSentinel(fromId: string, m: { name: string; brief: string }): string | null {
    const from = this.sessions.get(fromId);
    if (!from || from.config.isScratch) return null;
    if (from.config.scratchConversation) return this.finishHandoff(from, m);
    const brief = clip(m.brief);
    if (!brief) return "⚠️ The new task had no handoff, so it wasn't started.";
    const projectId = projectIdOf(from);
    const sent = this.relayCounts.get(projectId) ?? 0;
    if (sent >= MAX_RELAYS_WITHOUT_OWNER) return '⏸ Not started: this project\'s sessions have acted on their own a lot since you last wrote. Send any message in the project to let them continue.';
    try {
      const task = this.createTask(fromId, {
        name: m.name,
        model: from.config.model,
        effort: from.config.effort,
        message: brief,
        author: { name: from.config.name, sessionId: from.id },
      });
      this.relayCounts.set(projectId, sent + 1);
      return `🧵 Started the task "${task.config.name}" with this handoff.`;
    } catch (err: any) {
      return `⚠️ Couldn't start the task: ${err.message}`;
    }
  }

  /** <<to_main>> / <<to_task>>: deliver a message to another session of the project, as from this
   *  one. A check-in becomes a request to the main session to review and commit just its files. */
  private deliverProjectMessage(fromId: string, m: { to: 'main' | 'note' | { task: string } | { session: string }; message: string; checkin?: { summary: string; files: string[] } }): string | null {
    if (typeof m.to === 'object' && 'session' in m.to) return this.deliverToSession(fromId, m.to.session, m.message);
    const from = this.sessions.get(fromId);
    const p = this.projectOf(fromId);
    // Scratch's conversations aren't a project: they have no one to message.
    if (!from || !p || p.main.config.isScratch) return null;
    // Notes and check-ins go on the project's board and wake no one (project-notes.ts).
    if (m.to === 'note' || m.checkin) {
      const files = (m.checkin?.files ?? []).map(f => clip(f, 300)).filter(Boolean);
      const text = m.checkin
        ? `Check-in: ${clip(m.checkin.summary, 3_000) || '(no summary)'}${files.length ? `\nFiles: ${files.join(', ')}` : ''}`
        : clip(m.message, 4_000);
      if (!this.projectNotes.add(p.main.id, { id: from.id, name: from.config.name }, text)) return null;
      return m.checkin
        ? `📌 Check-in posted to the project's notes board (${files.length} file${files.length === 1 ? '' : 's'}); no session was woken.`
        : '📌 Note posted to the project\'s notes board.';
    }
    let target: ManagedSession | undefined;
    if (m.to === 'main') {
      if (!from.config.mainSessionId) return '⚠️ This is the main session; <<to_main>> is for its tasks.';
      target = p.main;
    } else {
      const want = m.to.task.trim().toLowerCase();
      const others = [p.main, ...p.tasks].filter(s => s.id !== fromId);
      target = others.find(s => s.config.name.trim().toLowerCase() === want)
        ?? (want.length >= 3 ? others.find(s => s.config.name.toLowerCase().includes(want)) : undefined);
      if (!target) return `⚠️ No session named "${clip(m.to.task, 80)}" in this project, so the message wasn't sent.`;
    }
    const body = clip(m.message);
    if (!body) return null;
    const sent = this.relayCounts.get(p.main.id) ?? 0;
    if (sent >= MAX_RELAYS_WITHOUT_OWNER) {
      return `⏸ Not sent to "${target.config.name}": this project's sessions have sent each other ${sent} messages since you last wrote. Send any message in the project to let them continue.`;
    }
    this.relayCounts.set(p.main.id, sent + 1);
    this.sendMessage(target.id, body, undefined, { internal: true, author: { name: from.config.name, sessionId: from.id } }).catch(err => {
      console.error(`[SessionManager] Couldn't deliver a message from ${fromId} to ${target!.id}:`, err);
    });
    return `📤 Sent to "${target.config.name}".`;
  }

  /** Close a task: write a summary of its work (one cheap call on Clauder's copy of its chat; the
   *  task itself never runs), post it to the project's notes board, keep it in the project's
   *  task list for good, then delete the task. If the summary can't be written, a plain one is used. */
  private closing = new Set<string>();
  async closeTask(taskId: string): Promise<void> {
    const task = this.sessions.get(taskId);
    if (!task) throw new Error(`Session ${taskId} not found`);
    if (!task.config.mainSessionId || task.config.scratchConversation) throw new Error('Only a task of a project can be closed.');
    if (task.status === 'working') throw new Error('This task is working. Stop it or let it finish, then close it.');
    if (this.closing.has(taskId)) return;
    this.closing.add(taskId);
    const main = this.sessions.get(task.config.mainSessionId);
    task.emitSystemMessage('📝 Closing: writing a summary of this task\'s work for the project…');
    const state = task.getState();
    let summary = '';
    try {
      const prompt = [
        `Summarise the work of "${task.config.name}", a task (a separate Claude session) in the project "${main?.config.name ?? ''}", which is now being closed.`,
        'Write for the project\'s other sessions and for the owner months from now. Plain text, under 220 words, with these parts:',
        'Goal: one line. Done: what was built or changed, naming the important files. Decisions: anything settled and why. Left open: anything unfinished, or "nothing".',
        'Only state what the conversation shows. No preamble.',
        '', 'The conversation (oldest first):', '', transcriptFor(state.messages),
      ].join('\n');
      summary = (await runClaudeOneShot({ prompt, model: 'claude-sonnet-5-5', effort: 'low', cwd: task.config.cwd, timeoutMs: 90_000 })).trim();
      if (!/Goal:|Done:/i.test(summary)) summary = '';
    } catch (err) {
      console.error(`[SessionManager] Summary for closing task ${taskId} failed:`, err);
    }
    if (!summary) {
      const first = state.messages.find(m => m.role === 'user')?.content ?? '';
      const lastReply = [...state.messages].reverse().find(m => m.role === 'assistant' && (m.content ?? '').trim())?.content ?? '';
      summary = `Goal: ${clip(first, 300) || '(unknown)'}\nLast word from the task: ${clip(lastReply, 900) || '(none)'}`;
    }
    summary = clip(summary, 3_000);
    if (main) {
      this.projectNotes.add(main.id, { id: task.id, name: task.config.name }, `✅ Task closed. ${summary}`);
      this.projectNotes.addClosed(main.id, { name: task.config.name, closedAt: new Date().toISOString(), startedAt: state.createdAt, summary });
      main.emitSystemMessage(`✅ Closed the task "${task.config.name}". Its summary is on the project's notes board and in the task list.`);
    }
    this.closing.delete(taskId);
    console.log(`[SessionManager] Closed task "${task.config.name}" (${taskId})`);
    await this.destroySession(taskId);
  }

  /** <<to_session>>: a message to a session of another project, by name. Only to a project on the
   *  sender's whitelist (config.canMessage on its main session), or back to one that messaged it
   *  in the last day; never to or from a project shared with a guest; and capped like relays. */
  private deliverToSession(fromId: string, name: string, text: string): string | null {
    const from = this.sessions.get(fromId);
    if (!from || from.config.isScratch || from.config.scratchConversation) return null;
    const body = clip(text);
    const want = clip(name, 120).toLowerCase();
    if (!body || !want) return null;
    const candidates = [...this.sessions.values()].filter(s => !s.config.mainSessionId && !s.config.isScratch);
    const target = candidates.find(s => s.config.name.trim().toLowerCase() === want)
      ?? (want.length >= 3 ? candidates.find(s => s.config.name.toLowerCase().includes(want)) : undefined);
    if (!target) return `⚠️ No session named "${clip(name, 80)}", so the message wasn't sent.`;
    const fromProject = projectIdOf(from);
    const toProject = target.id;
    // Within its own project, it's an ordinary relay to the main session.
    if (toProject === fromProject) return this.deliverProjectMessage(fromId, { to: 'main', message: text });
    const fromMain = this.sessions.get(fromProject) ?? from;
    const whitelisted = (fromMain.config.canMessage ?? []).includes(toProject);
    const replying = (this.replyWindows.get(fromProject)?.get(toProject) ?? 0) > Date.now();
    if (!whitelisted && !replying) {
      return `⚠️ Not sent: "${fromMain.config.name}" isn't allowed to message "${target.config.name}". The owner can allow it in this session's ⚙ menu ("Can message…").`;
    }
    if (this.isShared(fromProject) || this.isShared(toProject)) {
      return `⚠️ Not sent: messages between projects are off for projects shared with a guest.`;
    }
    const key = [fromProject, toProject].sort().join('|');
    const sent = this.crossCounts.get(key) ?? 0;
    if (sent >= MAX_RELAYS_WITHOUT_OWNER) {
      return `⏸ Not sent to "${target.config.name}": these two projects have sent each other ${sent} messages since you last wrote in either. Send a message in one of them to let them continue.`;
    }
    this.crossCounts.set(key, sent + 1);
    // The receiver may answer for a day.
    const windows = this.replyWindows.get(toProject) ?? new Map<string, number>();
    windows.set(fromProject, Date.now() + DAY_MS);
    this.replyWindows.set(toProject, windows);
    const author: MessageAuthor = { name: fromMain.config.name, sessionId: from.id, crossProject: true };
    this.sendMessage(target.id, body, undefined, { internal: true, author }).catch(err => {
      console.error(`[SessionManager] Couldn't deliver a message from ${fromId} to ${target.id}:`, err);
    });
    console.log(`[SessionManager] to_session: "${fromMain.config.name}" → "${target.config.name}" (${sent + 1}/${MAX_RELAYS_WITHOUT_OWNER})`);
    return `📤 Sent to "${target.config.name}".`;
  }

  // ─── Scratch conversations (scratch.ts) ─────────────────────────────────────
  // Each is a task of the Scratch session (config.scratchConversation), without project rules.

  /** At the cap, the oldest conversation that isn't kept or busy makes way for a new one. */
  private makeRoomInScratch(conversations: ManagedSession[]): void {
    if (conversations.length < MAX_SCRATCH_CONVERSATIONS) return;
    const oldest = conversations
      .filter(c => !c.config.keep && c.status !== 'working' && !this.scratchKeepAlive(c.id))
      .sort((a, b) => a.lastActiveAt.localeCompare(b.lastActiveAt))[0];
    if (!oldest) throw new Error(`Scratch is full: its ${conversations.length} conversations are all kept or busy. Delete one first.`);
    console.log(`[SessionManager] Scratch is full; deleting its oldest conversation "${oldest.config.name}" (${oldest.id})`);
    this.destroySession(oldest.id).catch(err => console.error('[SessionManager] Couldn\'t delete a Scratch conversation:', err));
  }

  /** Something else that keeps a Scratch conversation from expiring (index.ts: a trigger aimed at it). */
  setScratchKeepAlive(fn: (sessionId: string) => boolean): void {
    this.scratchKeepAlive = fn;
  }

  /** Keep a Scratch conversation from expiring, or let it expire again. */
  setKeep(sessionId: string, keep: boolean): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    if (!s.config.scratchConversation) throw new Error('Only a Scratch conversation can be kept.');
    if (keep) s.updateConfig({ keep: true });
    else s.updateConfig({}, ['keep']);
    this.persist();
  }

  /** Make a Scratch conversation a session of its own where it is: same folder, same conversation
   *  and history, and no expiry. */
  promoteScratch(sessionId: string, name: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    if (!s.config.scratchConversation) throw new Error('Only a Scratch conversation can be made a session.');
    s.updateConfig({ name: clip(name, 80) || s.config.name }, ['mainSessionId', 'scratchConversation', 'keep']);
    this.pendingHandoffs.delete(sessionId);
    console.log(`[SessionManager] Scratch conversation ${sessionId} is now the session "${s.config.name}"`);
    this.persist();
  }

  /** Hand a Scratch conversation off to a new session: its Claude writes a handoff note, and the
   *  <<new_task>> that ends it starts the session (finishHandoff), in a new project folder or as a
   *  task of a project. The conversation itself stays in Scratch. */
  scratchHandoff(sessionId: string, name: string, target: HandoffTarget): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new Error(`Session ${sessionId} not found`);
    if (!s.config.scratchConversation) throw new Error('Only a Scratch conversation can be handed off.');
    let where: string;
    if (target.kind === 'new_project') {
      const folder = String(target.folder ?? '').trim();
      const problem = projectFolderProblem(folder);
      if (problem) throw new Error(problem);
      target = { kind: 'new_project', folder };
      where = `a new project in the folder ${devRootForDisplay()}/${folder}`;
    } else {
      const p = this.projectOf(String(target.projectId ?? ''));
      if (!p || p.main.config.isScratch) throw new Error('That project no longer exists.');
      if (p.tasks.length >= MAX_TASKS_PER_PROJECT) throw new Error(`"${p.main.config.name}" already has ${MAX_TASKS_PER_PROJECT} tasks, the most a project can have.`);
      target = { kind: 'task', projectId: p.main.id };
      where = `a task in the project "${p.main.config.name}" (its folder is ${p.main.config.cwd})`;
    }
    this.pendingHandoffs.set(sessionId, { name: clip(name, 80), target });
    this.sendMessage(sessionId, handoffRequest(where), undefined, { internal: true }).catch(err => {
      console.error(`[SessionManager] Handoff request failed for ${sessionId}:`, err);
    });
  }

  /** A Scratch conversation's <<new_task>>, once scratchHandoff asked for one: start the session it's
   *  handed off to, with the note as the first message, from the owner (they asked for it). */
  private finishHandoff(from: ManagedSession, m: { name: string; brief: string }): string | null {
    const handoff = this.pendingHandoffs.get(from.id);
    if (!handoff) return null;
    const brief = clip(m.brief);
    if (!brief) return '⚠️ The handoff note was empty, so nothing was started. Try "Make it a session…" again.';
    this.pendingHandoffs.delete(from.id);
    const name = handoff.name || clip(m.name, 80) || 'New session';
    const message = handoffMessage(from.config.name, brief);
    try {
      if (handoff.target.kind === 'task') {
        const task = this.createTask(handoff.target.projectId, { name, message });
        const main = this.sessions.get(handoff.target.projectId);
        return `🧵 Started the task "${task.config.name}" in "${main?.config.name ?? 'the project'}" with this handoff.`;
      }
      const folder = ensureProjectFolder(handoff.target.folder);
      const state = this.createSession({
        name,
        cwd: folder.path,
        model: from.config.model,
        effort: from.config.effort,
        permissionMode: from.permissionMode,
      });
      this.sendMessage(state.id, message).catch(err => console.error(`[SessionManager] Couldn't start ${state.id}:`, err));
      console.log(`[SessionManager] Scratch conversation ${from.id} handed off to the new session "${name}" in ${folder.path}`);
      return `🚀 Started "${state.config.name}" in ${folder.path} with this handoff.`;
    } catch (err: any) {
      return `⚠️ Couldn't start it: ${err.message}`;
    }
  }

  /** Delete Scratch conversations untouched for SCRATCH_EXPIRY_DAYS unless kept, and ones never
   *  written in after a day. Returns how many went. */
  async sweepScratch(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const s of [...this.sessions.values()]) {
      if (!s.config.scratchConversation || s.config.keep || s.status === 'working') continue;
      if (s.pendingWakeup || s.monitors.list().length || s.queuedMessages.length || this.scratchKeepAlive(s.id)) continue;
      const idle = now - Date.parse(s.lastActiveAt);
      const empty = !hasConversation(s);
      if (!(idle >= (empty ? EMPTY_SCRATCH_MS : SCRATCH_EXPIRY_DAYS * DAY_MS))) continue;
      try {
        await this.destroySession(s.id);
        removed++;
        console.log(`[SessionManager] Scratch conversation "${s.config.name}" (${s.id}) expired: ${empty ? 'never written in' : `untouched ${Math.floor(idle / DAY_MS)} days`}`);
      } catch (err) {
        console.error(`[SessionManager] Couldn't expire Scratch conversation ${s.id}:`, err);
      }
    }
    return removed;
  }

  /** Expire Scratch conversations hourly, starting a few minutes after startup. */
  startScratchSweep(): void {
    const run = () => { this.sweepScratch().catch(err => console.error('[SessionManager] Scratch sweep failed:', err)); };
    setTimeout(run, 3 * 60 * 1000).unref();
    setInterval(run, 60 * 60 * 1000).unref();
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
