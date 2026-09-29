import { v4 as uuid } from 'uuid';
import { spawn } from 'child_process';
import { existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { readFile as readFileAsync, stat as statAsync, readdir as readdirAsync } from 'fs/promises';
import { dirname, join, isAbsolute, resolve as resolvePath, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { saveUpload, saveFileUpload } from './uploads.js';
import { homedir } from 'os';
import type { ChildProcess } from 'child_process';
import type { SessionConfig, SessionState, SessionStatus, SessionOrigin, PermissionMode, EffortLevel, UIMessage, ToolActivity, ToolUseInfo, ContextUsage, PendingPermission, PendingWakeup, PendingPlan, ImageAttachment, FileAttachment, QueuedMessage, ToolResultInfo, DebugLogEntry, DebugLogEntryType, RateLimitWindow, GoalState, ModelPlan, ModelPlanStep, MonitorInfo, ParkedThread, ThreadSummary } from '@clauder/shared';
import { trimMessages } from '@clauder/shared';
import { toClientState } from './client-view.js';
import { taskRosterPath, writeTaskRoster as writeRosterFile, removeTaskRoster } from './task-roster.js';
import { MonitorController } from './session-monitors.js';
import { migrateModelId, DEFAULT_MODEL } from './models.js';
import type { WsOutboundMessage } from '@clauder/shared';
import { recordCostDelta, recordSubscriptionLimits, getRateLimitInfo, parseRateLimitEvent, effortCapForQuota, capEffort } from './rate-limits.js';
import { recordTurnCost } from './cost-ledger.js';
import { classifyTaskSwitch } from './task-classifier.js';
import { getSkillsForCwd } from './skills.js';
import { extractClaudeMdCandidates, applyClaudeMdCandidate } from './claude-md.js';

// Walk up the directory tree from this file to find the Claude CLI binary.
// v2.1.120+ ships a native binary at bin/claude.exe instead of cli.js.
export const CLAUDE_CLI_PATH = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Check for native binary first (v2.1.120+), then legacy cli.js
  const candidates = [
    'node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    'node_modules/@anthropic-ai/claude-code/cli.js',
  ];
  while (true) {
    for (const rel of candidates) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) {
        console.log(`[Clauder] Claude CLI found at: ${candidate}`);
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not find Claude CLI binary — is @anthropic-ai/claude-code installed?');
    dir = parent;
  }
})();

// Detect whether the CLI is a native binary or a Node.js script
export const CLI_IS_NATIVE = CLAUDE_CLI_PATH.endsWith('.exe');

// Path to the Clauder MCP server (built from packages/mcp-server)
const CLAUDER_MCP_PATH = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(dir, 'packages', 'mcp-server', 'dist', 'index.js');
    if (existsSync(candidate)) {
      console.log(`[Clauder] MCP server found at: ${candidate}`);
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      console.warn('[Clauder] MCP server not found — controller mode will not work until built');
      return '';
    }
    dir = parent;
  }
})();

// Directory for per-session MCP config files
const MCP_CONFIG_DIR = join(homedir(), '.clauder', 'mcp-configs');
if (!existsSync(MCP_CONFIG_DIR)) {
  mkdirSync(MCP_CONFIG_DIR, { recursive: true });
}

const CLAUDER_PORT = process.env.CLAUDER_PORT || '3001';

/** Max characters for tool result content sent to client */
const MAX_TOOL_RESULT_LENGTH = 10_000;
/** Max characters kept from a thinking block shown as a progress note. Current models' notes stay
 *  under ~500; older models could think 40K characters at a time, which would bloat
 *  sessions.json and the renderer (same concern as MAX_TOOL_RESULT_LENGTH). */
const MAX_THINKING_LENGTH = 4_000;
/** Max characters for debug log entry content */
const MAX_DEBUG_CONTENT_LENGTH = 5_000;
/** Max chat messages kept in memory per session. Without this, a long-lived session (Clauder
 *  stays running for days) accumulates its whole history in RAM and re-sends all of it on
 *  every reconnect/sessions_list — slowing down both the server and the browser rendering it.
 *  Trimmed once per turn (in sendMessage's finally), not on every push, so it's cheap. */
const MAX_MESSAGES_IN_MEMORY = 400;
/** Hard cap on model-plan length — a backstop against a runaway auto-driving plan. */
const MAX_PLAN_STEPS = 20;
/** Image types Claude can display inline via <<show_image>>. */
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.bmp': 'image/bmp',
};
/** Max size for an inline-displayed image (base64 embeds in the message + persistence). */
const MAX_SHOW_IMAGE_BYTES = 5_000_000;
/** Matches the various ways the CLI reports an expired/failed login, so we can surface the
 *  re-authenticate banner instead of a dead-end generic error. Kept broad on purpose — the CLI
 *  has used several wordings ("OAuth token has expired", "OAuth session expired and could not be
 *  refreshed", "authentication_error", bare 401). If a new variant slips through, widen this. */
const AUTH_ERROR_RE = /authentication_error|OAuth (?:token|session) (?:has )?expired|could not be refreshed|token (?:has )?expired|invalid[_ ]grant|refresh(?:ing)? (?:the )?token failed|re-?authenticate|please (?:log ?in|sign ?in)|\b401\b/i;
/** The CLI's context-overflow errors: a request over the size cap (HTTP 413), a conversation over
 *  the context window, or the 1M-context usage-credit wall. Any of them triggers autoRecoverFrom413.
 *  `\b413\b` so a stray "413" inside a request id, path, or line number doesn't count. */
const CONTEXT_ERROR_RE = /request_too_large|\b413\b|prompt is too long|Usage credits required for 1M context/i;
/** Signals that a requested model (Fable, for a plan turn) isn't available on this
 *  subscription — triggers the one-time fallback to Opus. See sendMessage's plan-mode handling. */
const PLAN_MODEL_ERROR_RE = /not_found_error|no such model|model.*not.*(available|found|exist)|invalid model|unknown model|404/i;
/** Signals that a plan turn failed because the (premium, pricier) Fable model specifically is
 *  out of credits/quota — distinct from a whole-subscription rate limit, which isRateLimited()
 *  already covers. Also triggers the Fable→Opus plan fallback: Opus is more likely to still be
 *  usable even when Fable's own allowance is exhausted. */
const PLAN_CREDIT_ERROR_RE = /insufficient.*(credit|balance|quota)|credit.*(required|exhausted|insufficient)|out of credits|payment required|\b402\b/i;
/** Self-directed "I'll follow up on this later" phrasing — the failure mode where a turn ends
 *  saying it will wait/check back on something WITHOUT actually calling ScheduleWakeup, a
 *  <<schedule_trigger>>/<<monitor>> sentinel, or add_watch, so nothing is ever going to bring
 *  the session back. See the stale-wait auto-nudge in the "Query completed" handling. */
const STALE_WAIT_INTENT_RE = /\bI(?:'ll| will)\s+(?:wait|check back|check in|monitor|keep (?:an eye|watching)|come back|circle back)\b|\bwaiting for (?:the|this|it|that)\b/i;
/** Suppresses STALE_WAIT_INTENT_RE when the wait is actually on a human (correct behavior —
 *  no scheduling needed), not on an async process/job the session should be checking on itself.
 *  Deliberately narrow — a bare "you"/"your" anywhere (e.g. "I'll monitor this and let you
 *  know") would false-suppress a real self-directed wait just for mentioning the user at all. */
const HUMAN_WAIT_RE = /\byour\s+(?:confirmation|approval|permission|answer|reply|response|input|go-ahead|feedback|decision|ok\b)|\bwait(?:ing)? (?:for|on) you\b/i;

export class ManagedSession {
  readonly id: string;
  config: SessionConfig;
  status: SessionStatus = 'idle';
  origin: SessionOrigin;
  permissionMode: PermissionMode;
  sdkSessionId: string | null = null;
  totalCostUsd = 0;
  /** this.totalCostUsd's value at the moment the CURRENT underlying SDK conversation began.
   *  The CLI's own resultMsg.total_cost_usd is cumulative WITHIN one conversation but resets
   *  near zero when a fresh one starts (any explicit sdkSessionId = null site below — 413
   *  recovery, a stale/not-found session, setCwd, repeated fatal errors, Clear). Snapshotted
   *  at each of those sites, then added back in the result handler, so totalCostUsd stays
   *  monotonically increasing across a reset instead of being overwritten by the new
   *  conversation's small starting cost (which showed up as negative "Turn done" deltas and
   *  briefly wiped out prior accumulated cost). A normal --resume of the SAME conversation
   *  never touches this — the CLI's own total already carries forward correctly there. */
  private costBaseline = 0;
  error: string | null = null;
  /** What this session is currently waiting on (e.g. 'question', 'permission').
   *  Null when not waiting. Drives the "Needs you" card indicator. */
  waitingFor: string | null = null;
  currentToolActivity: ToolActivity | null = null;
  contextUsage: ContextUsage | null = null;
  messages: UIMessage[] = [];
  summary: string | null = null;
  summaryGeneratedAt: string | null = null;
  /** User-facing reference notes maintained via the `<<notes>>` sentinel. See SessionState.notes. */
  notes: string | null = null;
  notesUpdatedAt: string | null = null;
  debugLog: DebugLogEntry[] = [];
  createdAt: string;
  lastActiveAt: string;

  queuedMessages: QueuedMessage[] = [];

  /** Custom Plan feature: plan turns run on Fable, falling back to Opus once if Fable isn't
   *  available on this subscription. Transient (not persisted) — a missing Fable just gets
   *  re-detected after a restart. */
  private planFallbackToOpus = false;
  /** Whether the credit guardrail's effort cap was in force on the last turn — used to
   *  announce engage/disengage once instead of every turn. */
  private quotaCapActive = false;
  /** The full text of the most recent ExitPlanMode plan (prose + the machine-readable
   *  clauder-steps block). The accept handler parses steps out of this to start a model plan.
   *  Transient — an accept after a restart falls back to legacy behavior. */
  lastPlanText: string | null = null;

  pendingPermission: PendingPermission | null = null;
  pendingWakeup: PendingWakeup | null = null;
  /** A plan awaiting accept/reject. Set alongside lastPlanText when a plan is surfaced; cleared
   *  by the accept/reject handler. Included in getState() so the banner survives WS reconnects —
   *  the live `pending_plan` event alone leaves a reconnecting/late client (a phone) with no banner. */
  pendingPlan: PendingPlan | null = null;
  /** Parked ("tabled") conversation threads for this session panel — see ParkedThread. Full
   *  snapshots live here server-side; getState() exposes only lightweight ThreadSummary rows.
   *  Newest-first. */
  threads: ParkedThread[] = [];
  /** Id of the currently-live thread. A fresh session/thread gets a random id even though it has
   *  no ParkedThread entry yet — parkThread()/resumeThread() are the only things that touch it. */
  activeThreadId: string = uuid();
  /** Human name for the live thread; null shows as "Current thread" in the UI. */
  activeThreadName: string | null = null;
  /** Live event-monitors (the Clauder-native replacement for the CLI's headless-broken `Monitor`
   *  tool). Host members are functions so they read `this.*` at call-time — this field initializer
   *  runs before the constructor body sets `id`/`config`. */
  readonly monitors = new MonitorController({
    id: () => this.id,
    cwd: () => this.config.cwd,
    isIdle: () => this.status === 'idle',
    deliver: (message: string) => this.deliverMonitorMessage(message),
    onMonitorsChanged: (monitors: MonitorInfo[]) =>
      this.broadcast({ type: 'monitors_update', sessionId: this.id, monitors }),
  });
  private wakeupTimer: NodeJS.Timeout | null = null;
  /** Injected by SessionManager after construction. Called when Claude emits a <<schedule_trigger>> sentinel. */
  onScheduleTrigger: ((input: { sessionId: string; message: string; description: string; at: string }) => void) | null = null;
  /** Server-side AskUserQuestion gate. Set when the model asks a question; cleared on
   *  answer, fresh user input, or timeout (after which the session proceeds on its own).
   *  Distinct from the client-side pendingQuestion, which drives the answer UI. */
  pendingQuestion: { toolUseId: string; askedAt: string } | null = null;
  private questionTimer: NodeJS.Timeout | null = null;
  /** True while a Haiku task-switch classification is in flight. Concurrent sendMessage calls queue instead of racing. */
  private pendingTaskSwitch = false;
  /** Epoch ms of last auto-compact, used as a cooldown so the classifier doesn't re-fire on dequeued messages. */
  private lastAutoCompactAt = 0;

  private activeProcess: ChildProcess | null = null;
  private broadcast: (msg: WsOutboundMessage) => void;
  private needsFork = false;
  private wasReset = false;
  private awaitingCompactSummary = false;
  compactedContext: string | null = null;
  private retryCount = 0;
  private consecutiveStalls = 0;
  /** When set, fire auto-recovery as soon as the current query finishes (used when
   * the CLI emits a context-credit error as an assistant message rather than as
   * a result error — we can't recover mid-stream). Consumed by the completion path, or by
   * the catch path when the process dies first. */
  private pendingPostQueryRecover = false;
  /** Deferred flag: a plan turn's result came back with a model-unavailable error (Fable);
   *  retry on Opus after the current query finishes. Mirrors pendingPostQueryRecover. */
  private pendingPlanFallbackRetry = false;
  /** Deferred flag: the CLI emitted an authentication failure as ASSISTANT TEXT (observed:
   *  "Failed to authenticate: OAuth session expired and could not be refreshed") instead of a
   *  result error or stderr — so the AUTH_ERROR_RE checks in the result/catch paths never see
   *  it and the re-auth banner never appears. Set by the assistant-text sniff, consumed after
   *  the query winds down (a mid-stream error would be clobbered by the completion broadcast).
   *  Mirrors pendingPostQueryRecover. */
  private pendingAuthExpired = false;

  constructor(config: SessionConfig, broadcast: (msg: WsOutboundMessage) => void, origin?: SessionOrigin) {
    this.id = uuid();
    this.config = config;
    this.createdAt = new Date().toISOString();
    this.lastActiveAt = this.createdAt;
    this.broadcast = broadcast;
    this.origin = origin ?? (config.resumeSessionId ? 'vscode' : 'clauder');
    this.permissionMode = config.permissionMode ?? 'bypassPermissions';

    // If resuming from an existing session (e.g. VS Code), pre-set the SDK session ID
    // and mark for forking so the original session file isn't modified
    if (config.resumeSessionId) {
      this.sdkSessionId = config.resumeSessionId;
      this.needsFork = true;
    }
  }

  /** Restore a session from persisted data (e.g. after server restart) */
  static restore(
    data: {
      id: string;
      config: SessionConfig;
      origin?: SessionOrigin;
      sdkSessionId: string | null;
      totalCostUsd: number;
      contextUsage: ContextUsage | null;
      messages: UIMessage[];
      permissionMode?: string;
      summary?: string | null;
      summaryGeneratedAt?: string | null;
      compactedContext?: string | null;
      notes?: string | null;
      notesUpdatedAt?: string | null;
      pendingWakeup?: PendingWakeup | null;
      pendingPlan?: PendingPlan | null;
      threads?: ParkedThread[];
      activeThreadId?: string;
      activeThreadName?: string | null;
      createdAt: string;
      lastActiveAt: string;
    },
    broadcast: (msg: WsOutboundMessage) => void,
  ): ManagedSession {
    const origin = data.origin ?? 'clauder';
    // Retired model IDs are rewritten here rather than left to the UI — a session pinned to one
    // would otherwise go on running it while the picker showed something else. See models.ts.
    // A session saved with no model at all gets the default for the same reason: with no
    // --model flag it ran the CLI's own default while the picker showed Clauder's.
    const plan = data.config.modelPlan;
    const config = {
      ...data.config,
      model: migrateModelId(data.config.model) ?? DEFAULT_MODEL,
      modelPlan: plan ? { ...plan, steps: plan.steps.map(s => ({ ...s, model: migrateModelId(s.model) })) } : plan,
      resumeSessionId: data.sdkSessionId || undefined,
    };
    const session = new ManagedSession(config, broadcast, origin);

    // Override the auto-generated fields with persisted data
    (session as any).id = data.id;
    session.totalCostUsd = data.totalCostUsd;
    session.contextUsage = data.contextUsage;
    session.messages = data.messages;
    session.createdAt = data.createdAt;
    session.lastActiveAt = data.lastActiveAt;
    session.permissionMode = (data.permissionMode ?? data.config.permissionMode ?? 'bypassPermissions') as PermissionMode;
    session.summary = data.summary ?? null;
    session.summaryGeneratedAt = data.summaryGeneratedAt ?? null;
    session.compactedContext = data.compactedContext ?? null;
    session.notes = data.notes ?? null;
    session.notesUpdatedAt = data.notesUpdatedAt ?? null;
    // Restore a plan awaiting accept/reject. pendingPlan drives the banner (via the snapshot);
    // lastPlanText is what the accept handler parses steps from, so rebuild it from the plan text.
    session.pendingPlan = data.pendingPlan ?? null;
    session.lastPlanText = data.pendingPlan?.plan ?? null;
    // Parked threads are inert data while parked (no timers) — resumeThread()/loadThread()
    // re-arms a thread's own pendingWakeup only once it becomes live again. Missing on old
    // persisted data (additive field, no migration needed) defaults to none parked.
    session.threads = (data.threads ?? []).map(t => ({ ...t, model: migrateModelId(t.model) }));
    session.activeThreadId = data.activeThreadId ?? uuid();
    session.activeThreadName = data.activeThreadName ?? null;

    // Restore pending wakeup if not past due
    if (data.pendingWakeup) {
      const scheduledMs = new Date(data.pendingWakeup.scheduledAt).getTime();
      const remainingMs = scheduledMs - Date.now();
      if (remainingMs > 0) {
        session.pendingWakeup = data.pendingWakeup;
        session.wakeupTimer = setTimeout(() => session.fireWakeup(), remainingMs);
      } else if (data.pendingWakeup.toolUseId === ManagedSession.RATE_LIMIT_WAKEUP_ID) {
        // Past-due rate-limit resume: the window has long since reset — fire it shortly
        // after startup (small delay so restore/broadcast wiring settles) instead of
        // dropping it and stranding the task the sleep was protecting.
        session.pendingWakeup = data.pendingWakeup;
        session.wakeupTimer = setTimeout(() => session.fireWakeup(), 15_000);
        console.log(`[Session ${data.id}] Past-due rate-limit resume — firing shortly after startup`);
      }
      // Other past-due wakeups drop silently — server was down past the firing time
    }

    // Clauder-native sessions: resume directly (we own the session file)
    // VS Code sessions: they were already forked on first use, so also resume directly
    session.needsFork = false;

    // Mark any pending (no-result) tool uses as failed — they're stale from a previous
    // server instance that died or restarted mid-query
    for (const msg of session.messages) {
      if (msg.toolUses) {
        for (const tu of msg.toolUses) {
          if (!tu.result) {
            tu.result = { content: 'Server restarted — tool result lost', isError: true };
          }
        }
      }
    }

    return session;
  }

  getState(): SessionState {
    return {
      id: this.id,
      config: this.config,
      status: this.status,
      origin: this.origin,
      sdkSessionId: this.sdkSessionId,
      totalCostUsd: this.totalCostUsd,
      error: this.error,
      waitingFor: this.waitingFor,
      currentToolActivity: this.currentToolActivity,
      contextUsage: this.contextUsage,
      messages: this.messages,
      queuedMessages: [...this.queuedMessages],
      permissionMode: this.permissionMode,
      pendingPermission: this.pendingPermission,
      pendingWakeup: this.pendingWakeup,
      pendingPlan: this.pendingPlan,
      monitors: this.monitors.list(),
      summary: this.summary,
      summaryGeneratedAt: this.summaryGeneratedAt,
      compactedContext: this.compactedContext,
      notes: this.notes,
      notesUpdatedAt: this.notesUpdatedAt,
      debugLog: this.debugLog.slice(-200),
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
      activeThreadId: this.activeThreadId,
      activeThreadName: this.activeThreadName,
      threads: this.threadSummaries(),
    };
  }

  // ─── Tasks (parked threads) ────────────────────────────────────────────────────────────
  // Each task is its own CLI conversation; the client's task selector switches between them.
  // Switching never spawns the CLI or touches quota — it's pure bookkeeping over the same fields
  // getState()/persistence already round-trip. A task carries its own model/effort, restored on
  // switch-back so its conversation runs on the model its prompt cache was built with. Tasks are
  // only lightly aware of each other: one fixed system-prompt sentence says a roster exists
  // (task-roster.ts) and Claude reads it on demand — nothing is pushed into a conversation.

  private threadSummaries(): ThreadSummary[] {
    return this.threads.map((t) => ({
      id: t.id,
      name: t.name,
      messageCount: t.messages.length,
      preview: (t.messages.find(m => m.role === 'user')?.content ?? '').slice(0, 80),
      parkedAt: t.parkedAt,
      lastActiveAt: t.lastActiveAt,
      model: t.model ?? null,
    }));
  }

  /** Auto-name for a thread being parked without an explicit name: first line of the first user
   *  message, then first line of the summary, then a numbered fallback. */
  private autoThreadName(): string {
    const firstUserMsg = this.messages.find(m => m.role === 'user')?.content?.trim();
    if (firstUserMsg) return firstUserMsg.split('\n')[0].slice(0, 60);
    const summaryFirstLine = this.summary?.trim().split('\n')[0];
    if (summaryFirstLine) return summaryFirstLine.slice(0, 60);
    return `Thread ${this.threads.length + 1}`;
  }

  /** Throws with a message suitable for the client's `error` broadcast (see the WS case) unless
   *  it's safe to swap the live thread out from under the session right now. */
  private assertCanSwitchThread(): void {
    if (this.status !== 'idle' && this.status !== 'error') {
      throw new Error('Finish or interrupt the current turn before switching threads.');
    }
    if (this.pendingPermission || this.pendingQuestion || this.waitingFor || this.pendingTaskSwitch) {
      throw new Error('Resolve the pending permission/question before switching threads.');
    }
  }

  private snapshotLiveThread(name?: string): ParkedThread {
    const now = new Date().toISOString();
    return {
      id: this.activeThreadId,
      name: name ?? this.activeThreadName ?? this.autoThreadName(),
      cwd: this.config.cwd,
      sdkSessionId: this.sdkSessionId,
      messages: this.messages,
      contextUsage: this.contextUsage,
      summary: this.summary,
      summaryGeneratedAt: this.summaryGeneratedAt,
      compactedContext: this.compactedContext,
      pendingPlan: this.pendingPlan,
      pendingWakeup: this.pendingWakeup,
      queuedMessages: this.queuedMessages,
      sdkCostSoFar: this.totalCostUsd - this.costBaseline,
      wasReset: this.wasReset,
      needsFork: this.needsFork,
      // The task's own model/effort travel with it (null = session default) — see loadThread.
      model: this.config.model ?? null,
      effort: this.config.effort ?? null,
      parkedAt: now,
      lastActiveAt: this.lastActiveAt,
    };
  }

  /** Load a parked thread's fields back as the live conversation. Does NOT touch `threads` or
   *  broadcast — callers (parkThread/resumeThread) own that. */
  private loadThread(t: ParkedThread): void {
    this.activeThreadId = t.id;
    this.activeThreadName = t.name;
    this.sdkSessionId = t.sdkSessionId;
    this.messages = t.messages;
    this.contextUsage = t.contextUsage;
    this.summary = t.summary;
    this.summaryGeneratedAt = t.summaryGeneratedAt;
    this.compactedContext = t.compactedContext;
    this.pendingPlan = t.pendingPlan;
    this.queuedMessages = t.queuedMessages;
    this.wasReset = t.wasReset;
    this.needsFork = t.needsFork;
    // Back on the task's own model/effort, so its conversation keeps using the prompt cache it
    // built rather than cold-starting on whatever the last task ran. Threads parked before tasks
    // existed recorded neither (undefined) and leave the session's model alone; one parked while
    // the session had no model (null) gets the default, as restore() gives such a session.
    if (t.model !== undefined) this.config = { ...this.config, model: t.model ?? DEFAULT_MODEL };
    if (t.effort !== undefined) this.config = { ...this.config, effort: t.effort ?? undefined };
    // costBaseline stays a snapshot of totalCostUsd at the moment the CURRENT conversation
    // began (see the field doc) — restoring a thread whose own cumulative cost was
    // sdkCostSoFar means the current total minus that much is where the baseline belongs, so
    // the next result event's `costBaseline + total_cost_usd` lands back on totalCostUsd
    // unchanged instead of double- or under-counting.
    this.costBaseline = this.totalCostUsd - t.sdkCostSoFar;
    this.retryCount = 0;

    // Re-arm the wakeup exactly like restore() does: fire at the recorded time if still in
    // the future, fire shortly after resume if it's a past-due rate-limit sleep (the user
    // explicitly came back, so don't strand the task the sleep was protecting), otherwise
    // drop it silently.
    this.pendingWakeup = null;
    if (t.pendingWakeup) {
      const remainingMs = new Date(t.pendingWakeup.scheduledAt).getTime() - Date.now();
      if (remainingMs > 0) {
        this.pendingWakeup = t.pendingWakeup;
        this.wakeupTimer = setTimeout(() => this.fireWakeup(), remainingMs);
      } else if (t.pendingWakeup.toolUseId === ManagedSession.RATE_LIMIT_WAKEUP_ID) {
        this.pendingWakeup = t.pendingWakeup;
        this.wakeupTimer = setTimeout(() => this.fireWakeup(), 5_000);
      }
    }
  }

  /** Snapshot the live thread into the parked list, then start a fresh conversation via
   *  clearMessages() (kills any in-flight process, nulls sdkSessionId, broadcasts the full
   *  session_created the client swaps in wholesale). */
  parkThread(name?: string): void {
    this.assertCanSwitchThread();
    if (this.messages.length === 0 && !this.sdkSessionId) {
      throw new Error('Nothing to park — this thread is already empty.');
    }
    // Snapshot BEFORE clearing the timer/field — the wakeup travels with the parked thread
    // (see ParkedThread.pendingWakeup) and gets re-armed on resume, but the fresh live thread
    // must start with none of its own, or it'd show a banner for a wakeup that's actually
    // about the parked conversation.
    const snapshot = this.snapshotLiveThread(name);
    if (this.pendingWakeup) {
      this.clearWakeupTimer();
      this.pendingWakeup = null;
      this.broadcast({ type: 'wakeup_cleared', sessionId: this.id });
    }
    this.threads.unshift(snapshot);
    this.activeThreadId = uuid();
    this.activeThreadName = null;
    this.clearMessages();
    this.refreshTaskRoster();
  }

  /** Swap a parked thread back in. Parks the current live thread first if it has any content
   *  (auto-named), so nothing is silently discarded by resuming something else. */
  resumeThread(threadId: string): void {
    this.assertCanSwitchThread();
    const target = this.threads.find(t => t.id === threadId);
    if (!target) throw new Error('That parked thread no longer exists.');
    if (target.cwd !== this.config.cwd) {
      throw new Error('This thread was parked under a different working directory and can\'t be resumed here.');
    }
    if (this.messages.length > 0 || this.sdkSessionId) {
      if (this.pendingWakeup) {
        this.clearWakeupTimer();
        this.broadcast({ type: 'wakeup_cleared', sessionId: this.id });
      }
      this.threads.unshift(this.snapshotLiveThread());
    }
    this.threads = this.threads.filter(t => t.id !== threadId);
    this.loadThread(target);
    this.refreshTaskRoster();
    this.status = 'idle';
    this.error = null;
    this.currentToolActivity = null;
    this.broadcast({ type: 'session_created', session: toClientState(this.getState()) });
  }

  discardThread(threadId: string): void {
    const before = this.threads.length;
    this.threads = this.threads.filter(t => t.id !== threadId);
    if (this.threads.length === before) throw new Error('That parked thread no longer exists.');
    this.refreshTaskRoster();
    this.broadcastThreadsUpdate();
  }

  /** Rename a thread — the live one (threadId === activeThreadId) or a parked one. */
  renameThread(threadId: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Thread name can\'t be empty.');
    if (threadId === this.activeThreadId) {
      this.activeThreadName = trimmed;
    } else {
      const target = this.threads.find(t => t.id === threadId);
      if (!target) throw new Error('That parked thread no longer exists.');
      target.name = trimmed;
    }
    this.refreshTaskRoster();
    this.broadcastThreadsUpdate();
  }

  /** Task selector's "New task": park the current task if it has anything in it, then start a
   *  fresh conversation under `name` on its chosen starting model/effort. A brand-new
   *  conversation has no prompt cache to lose, so this is the one moment a model change is free. */
  startTask(opts: { name: string; model?: string; effort?: EffortLevel }): void {
    this.assertCanSwitchThread();
    const name = opts.name.trim().slice(0, 80);
    if (!name) throw new Error('Give the new task a name.');
    if (this.messages.length > 0 || this.sdkSessionId) this.parkThread();
    this.activeThreadName = name;
    if (opts.model) this.config = { ...this.config, model: opts.model };
    if (opts.effort) this.config = { ...this.config, effort: opts.effort };
    this.refreshTaskRoster();
    this.broadcast({ type: 'session_created', session: toClientState(this.getState()) });
  }

  /** Keep the on-disk roster (task-roster.ts) in step with the task list. */
  private refreshTaskRoster(): void {
    writeRosterFile(this.id, this.config.name, this.activeThreadName, [...this.threads]
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
      .map(t => ({
        name: t.name,
        messageCount: t.messages.length,
        lastActiveAt: t.lastActiveAt,
        preview: (t.messages.find(m => m.role === 'user')?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
        model: t.model,
      })));
  }

  /** The roster must exist before a turn's system prompt points Claude at it. */
  private ensureTaskRoster(): void {
    if (!existsSync(taskRosterPath(this.id))) this.refreshTaskRoster();
  }

  private broadcastThreadsUpdate(): void {
    this.broadcast({
      type: 'threads_update',
      sessionId: this.id,
      threads: this.threadSummaries(),
      activeThreadId: this.activeThreadId,
      activeThreadName: this.activeThreadName,
    });
  }

  /** Queue a message to be sent after the current turn finishes */
  queueMessage(message: string, images?: ImageAttachment[], opts?: { internal?: boolean; files?: FileAttachment[]; model?: string; effort?: string }): void {
    this.queuedMessages.push({ text: message, images: images?.length ? images : undefined, files: opts?.files?.length ? opts.files : undefined, internal: opts?.internal, model: opts?.model, effort: opts?.effort });
    this.broadcast({
      type: 'queue_update',
      sessionId: this.id,
      queue: [...this.queuedMessages],
    });
  }

  /** Schedule a wakeup from a ScheduleWakeup tool call. Replaces any existing schedule. */
  private scheduleWakeup(input: any, toolUseId: string): void {
    this.clearWakeupTimer();

    // Clamp to [60, 3600] to match the ScheduleWakeup tool's documented bounds,
    // then add a 60-second buffer so rate-limit recovery fires after the window
    // has fully reset (not at the exact boundary where rejection is still possible).
    const rawDelay = Number(input?.delaySeconds) || 60;
    const delaySeconds = Math.max(60, Math.min(3600, Math.floor(rawDelay))) + 60;
    const scheduledAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    const reason = String(input?.reason || '').slice(0, 500);
    const prompt = String(input?.prompt || '');

    this.pendingWakeup = { scheduledAt, reason, delaySeconds, prompt, toolUseId };
    this.wakeupTimer = setTimeout(() => this.fireWakeup(), delaySeconds * 1000);

    console.log(`[Session ${this.id}] Wakeup scheduled in ${delaySeconds}s at ${scheduledAt}`);
    this.broadcast({ type: 'wakeup_scheduled', sessionId: this.id, wakeup: this.pendingWakeup });
  }

  /** Safety net for a common self-correction gap: a turn ends saying "I'll wait for X" or
   *  "I'll check back on this" but never actually calls ScheduleWakeup, emits a
   *  <<schedule_trigger>>/<<monitor>> sentinel, or uses add_watch — so nothing was ever going
   *  to bring the session back, and it silently sits idle forever until a human notices and
   *  re-prompts it. See STALE_WAIT_INTENT_RE at the call site for the detection. Reuses the
   *  existing pendingWakeup machinery (banner, cancel, restart-survival) rather than inventing
   *  new state — a short, one-time default nudge that pushes the session to either schedule
   *  proper follow-up itself or report that it's actually done/waiting on a human. */
  private armStaleWaitNudge(quote: string): void {
    const delaySeconds = 600; // 10 min — short enough not to strand it, long enough not to spam
    const scheduledAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    const reason = "Auto-detected: said it would wait/check back but didn't schedule anything";
    const prompt =
      `[Clauder auto-nudge] Your last message said: "${quote.trim().slice(0, 200)}" — but you didn't call ` +
      'ScheduleWakeup, emit a <<schedule_trigger>>/<<monitor>> sentinel, or use add_watch, so nothing was ' +
      'actually going to check back. If there\'s still something to follow up on, do that now — schedule ' +
      'an appropriate wakeup, trigger, or monitor yourself (this was just a one-time 10-minute stopgap). ' +
      "If it's already resolved, or you were waiting on a human, just say so.";

    this.pendingWakeup = { scheduledAt, reason, delaySeconds, prompt, toolUseId: 'stale-wait-auto-nudge' };
    this.wakeupTimer = setTimeout(() => this.fireWakeup(), delaySeconds * 1000);

    console.log(`[Session ${this.id}] Dangling "I'll wait" with no scheduling detected — auto-nudge armed for ${delaySeconds}s`);
    this.broadcast({ type: 'wakeup_scheduled', sessionId: this.id, wakeup: this.pendingWakeup });
  }

  /** Fire the pending wakeup: send a continuation message to the session.
   *  Runs from a setTimeout callback, so the whole body is guarded — a throw here
   *  (e.g. firing into a session being torn down) must not become an unhandled exception. */
  private fireWakeup(): void {
    try {
      if (!this.pendingWakeup) return;
      const wakeup = this.pendingWakeup;
      this.pendingWakeup = null;
      this.wakeupTimer = null;
      console.log(`[Session ${this.id}] Wakeup firing (reason: ${wakeup.reason})`);

      // Build a continuation message. If the prompt is the autonomous-loop sentinel,
      // Claude won't recognize it — send a generic continue with the reason for context.
      const isSentinel = wakeup.prompt === '<<autonomous-loop-dynamic>>' || wakeup.prompt === '<<autonomous-loop>>';
      const message = isSentinel
        ? `[Scheduled wakeup] Continue with the task.${wakeup.reason ? ` Reason: ${wakeup.reason}` : ''}`
        : wakeup.prompt;

      this.broadcast({ type: 'wakeup_cleared', sessionId: this.id });

      // Send as an internal message — programmatic, not user input, so task-switch
      // classification should skip it
      this.sendMessage(message, [], { internal: true }).catch(err => {
        console.error(`[Session ${this.id}] Wakeup send failed: ${err.message}`);
      });
    } catch (err) {
      console.error(`[Session ${this.id}] Wakeup fire failed:`, err);
    }
  }

  /** Deliver a monitor event into the session: start a turn now if idle, else queue it so it
   *  fires after the current turn drains (mirrors how triggers/wakeups behave when busy). Sent
   *  internal so it skips task-switch classification and wakeup cancellation. */
  private deliverMonitorMessage(message: string): void {
    try {
      if (this.status === 'idle' && !this.pendingTaskSwitch) {
        this.sendMessage(message, [], { internal: true }).catch(err => {
          console.error(`[Session ${this.id}] Monitor send failed: ${err.message}`);
        });
      } else {
        this.queueMessage(message, undefined, { internal: true });
      }
    } catch (err) {
      console.error(`[Session ${this.id}] Monitor deliver failed:`, err);
    }
  }

  /** Cancel a pending wakeup (user-initiated or new message). */
  cancelWakeup(): void {
    if (!this.pendingWakeup) return;
    this.clearWakeupTimer();
    this.pendingWakeup = null;
    console.log(`[Session ${this.id}] Wakeup canceled`);
    this.broadcast({ type: 'wakeup_cleared', sessionId: this.id });
  }

  private clearWakeupTimer(): void {
    if (this.wakeupTimer) {
      clearTimeout(this.wakeupTimer);
      this.wakeupTimer = null;
    }
  }

  /** Sentinel toolUseId marking a pendingWakeup as a rate-limit auto-resume (vs a
   *  Claude-scheduled ScheduleWakeup). Queue draining is held while one is armed. */
  static readonly RATE_LIMIT_WAKEUP_ID = 'rate-limit-auto-resume';

  /** True when a usage-limit rejection caused this failure. Prefer the CLI's own
   *  rate_limit_event (recorded before the error surfaces) over error-text matching. */
  private isRateLimited(errorText: string): boolean {
    if (getRateLimitInfo().session?.status === 'rejected') return true;
    return /usage limit|rate.?limit(ed)?|limit (reached|will reset)|hit your.*limit/i.test(errorText);
  }

  /** True when a failed plan turn should retry on Opus instead of Fable: Fable is unavailable
   *  on this subscription, Fable-specific credits are exhausted, OR the account is generally
   *  rate-limited. Opus is worth trying even in the rate-limited case — it's the account's
   *  cheaper, subscription-included model, so it may still have quota when the pricier Fable
   *  doesn't. If Opus fails too, planFallbackToOpus is already set, so the normal (non-plan)
   *  error handling — including sleepUntilRateLimitReset() — takes over from there. */
  private planShouldFallbackToOpus(errorText: string): boolean {
    return PLAN_MODEL_ERROR_RE.test(errorText) || PLAN_CREDIT_ERROR_RE.test(errorText) || this.isRateLimited(errorText);
  }

  /** Usage limit hit mid-task: instead of stranding the session in an error state until a
   *  human notices, arm a pendingWakeup for just after the window resets and continue
   *  automatically. Reuses the wakeup machinery so it persists across restarts, shows the
   *  countdown banner (with cancel) in the UI, and is cleared by fresh user input.
   *  Applies to EVERY session — Goal Mode and ProjectRunner add their own supervision on top. */
  private sleepUntilRateLimitReset(): void {
    const rl = getRateLimitInfo();
    const resetsAtIso = rl.session?.resetsAt ?? rl.weekly?.resetsAt ?? null;
    const resetMs = resetsAtIso ? new Date(resetsAtIso).getTime() : NaN;
    // +60s past the boundary so we never fire into a still-closed window; if the CLI never
    // told us the reset time, probe again in an hour rather than giving up.
    const fireAtMs = !isNaN(resetMs) && resetMs > Date.now()
      ? resetMs + 60_000
      : Date.now() + 60 * 60_000;
    const delaySeconds = Math.max(60, Math.round((fireAtMs - Date.now()) / 1000));

    this.clearWakeupTimer();
    this.pendingWakeup = {
      scheduledAt: new Date(fireAtMs).toISOString(),
      reason: 'Usage limit reached — auto-resuming when the window resets',
      delaySeconds,
      prompt: 'Continue where you left off.',
      toolUseId: ManagedSession.RATE_LIMIT_WAKEUP_ID,
    };
    this.wakeupTimer = setTimeout(() => this.fireWakeup(), delaySeconds * 1000);

    const friendly = new Date(fireAtMs).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    this.emitSystemMessage(`💤 Usage limit reached — auto-resuming at ${friendly}.`);
    this.broadcast({ type: 'wakeup_scheduled', sessionId: this.id, wakeup: this.pendingWakeup });
    console.log(`[Session ${this.id}] Rate limited — sleeping until ${this.pendingWakeup.scheduledAt}`);
  }

  /** Arm the answer gate when the model asks a question. If no answer arrives within
   *  the timeout, the session proceeds on its own with a best-effort default. */
  private armQuestionTimeout(toolUseId: string): void {
    this.clearQuestionTimer();
    this.pendingQuestion = { toolUseId, askedAt: new Date().toISOString() };
    this.waitingFor = 'question';
    const seconds = this.config.questionTimeoutSeconds ?? 300;
    this.questionTimer = setTimeout(() => this.fireQuestionTimeout(), seconds * 1000);
    console.log(`[Session ${this.id}] Question gate armed — proceeding on its own in ${seconds}s if unanswered`);
    this.broadcast({ type: 'state_change', sessionId: this.id, status: this.status, waitingFor: 'question' });
  }

  /** No human answer arrived in time — tell the session to make the best call itself. */
  private fireQuestionTimeout(): void {
    try {
      const gate = this.pendingQuestion;
      if (!gate) return;
      this.pendingQuestion = null;
      this.questionTimer = null;
      this.waitingFor = null;
      const seconds = this.config.questionTimeoutSeconds ?? 300;
      const waited = seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds}s`;
      console.log(`[Session ${this.id}] Question unanswered after ${waited} — proceeding on its own`);
      this.broadcast({ type: 'question_resolved', sessionId: this.id, toolUseId: gate.toolUseId });
      this.broadcast({ type: 'state_change', sessionId: this.id, status: this.status, waitingFor: null });
      const msg = `[No answer received within ${waited}] Proceed by making the best decision for the situation. Briefly note the assumption you made so it can be reviewed later.`;
      // internal: programmatic, so it skips task-switch classification
      this.sendMessage(msg, [], { internal: true }).catch(err => {
        console.error(`[Session ${this.id}] Question-timeout send failed: ${err.message}`);
      });
    } catch (err) {
      console.error(`[Session ${this.id}] fireQuestionTimeout failed:`, err);
    }
  }

  /** Clear the answer gate (answer arrived, user moved on, or session torn down). */
  private clearQuestionTimer(): void {
    if (this.questionTimer) {
      clearTimeout(this.questionTimer);
      this.questionTimer = null;
    }
  }

  /** Remove a queued message by index */
  dequeueMessage(index: number): void {
    if (index < 0 || index >= this.queuedMessages.length) return;
    this.queuedMessages.splice(index, 1);
    this.broadcast({
      type: 'queue_update',
      sessionId: this.id,
      queue: [...this.queuedMessages],
    });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    // In v2, permission mode is a CLI startup flag — changes take effect on next query
    this.broadcast({ type: 'permission_mode_change', sessionId: this.id, mode: this.permissionMode });
  }

  setModel(model: string): void {
    this.config = { ...this.config, model: model || undefined };
    this.broadcast({
      type: 'model_changed',
      sessionId: this.id,
      model,
    });
  }

  setEffort(effort: string | undefined): void {
    this.config = { ...this.config, effort: (effort || undefined) as any };
    this.broadcast({
      type: 'effort_changed',
      sessionId: this.id,
      effort: effort || null,
    });
  }

  private normalizeModel(m: unknown): string {
    if (typeof m === 'string' && /^claude-/.test(m.trim())) return m.trim();
    return this.config.model || DEFAULT_MODEL;
  }

  private normalizeEffort(e: unknown): EffortLevel {
    const allowed: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];
    return (typeof e === 'string' && (allowed as string[]).includes(e))
      ? e as EffortLevel
      : ((this.config.effort as EffortLevel) || 'medium');
  }

  /** Start a model plan (from a `<<model_plan>>` sentinel). Each step is pinned to a model +
   *  effort; model-plan-runner.ts advances one step per idle, switching the session's model
   *  between them. Bad/empty steps are dropped; unknown models fall back to the current one. */
  setModelPlan(rawSteps: unknown[]): void {
    const steps: ModelPlanStep[] = [];
    for (const s of rawSteps.slice(0, MAX_PLAN_STEPS)) {
      const task = String((s as any)?.task ?? '').trim();
      if (!task) continue;
      steps.push({
        model: this.normalizeModel((s as any)?.model),
        effort: this.normalizeEffort((s as any)?.effort),
        task: task.slice(0, 4000),
      });
    }
    if (steps.length === 0) return;
    const plan: ModelPlan = {
      steps,
      cursor: 0,
      status: 'running',
      startedAt: new Date().toISOString(),
      restoreModel: this.config.model ?? DEFAULT_MODEL,
      restoreEffort: (this.config.effort as EffortLevel) ?? 'medium',
    };
    this.config = { ...this.config, modelPlan: plan };
    this.broadcast({ type: 'model_plan_updated', sessionId: this.id, plan });
    this.emitSystemMessage(`🔀 Model plan started — ${steps.length} step${steps.length !== 1 ? 's' : ''}, switching models as it runs.`);
    console.log(`[Session ${this.id}] Model plan started: ${steps.length} steps`);
  }

  /** Advance the plan one step: returns the step to run now (after moving the cursor forward
   *  and broadcasting), or null when the plan is finished (clearing it + noting completion).
   *  Called by ModelPlanRunner on each idle. */
  takeNextPlanStep(): ModelPlanStep | null {
    const plan = this.config.modelPlan;
    if (!plan || plan.status !== 'running') return null;
    if (plan.cursor >= plan.steps.length) {
      const { restoreModel, restoreEffort } = plan;
      this.emitSystemMessage(`✅ Model plan complete (${plan.steps.length} step${plan.steps.length !== 1 ? 's' : ''}).`);
      this.config = { ...this.config, modelPlan: null };
      this.broadcast({ type: 'model_plan_updated', sessionId: this.id, plan: null });
      if (restoreModel) this.setModel(restoreModel);
      if (restoreEffort) this.setEffort(restoreEffort);
      return null;
    }
    const step = plan.steps[plan.cursor];
    plan.cursor += 1;
    this.broadcast({ type: 'model_plan_updated', sessionId: this.id, plan });
    return step;
  }

  /** Stop a running model plan (user Stop button, or a fresh user message interrupting it). */
  stopModelPlan(notify = true): void {
    const plan = this.config.modelPlan;
    if (!plan) return;
    const { restoreModel, restoreEffort } = plan;
    if (notify) this.emitSystemMessage('⏹ Model plan stopped.');
    this.config = { ...this.config, modelPlan: null };
    this.broadcast({ type: 'model_plan_updated', sessionId: this.id, plan: null });
    if (restoreModel) this.setModel(restoreModel);
    if (restoreEffort) this.setEffort(restoreEffort);
    console.log(`[Session ${this.id}] Model plan stopped`);
  }

  /** Count tool uses across the transcript — a progress proxy for goal supervision. */
  private countToolUses(): number {
    let n = 0;
    for (const m of this.messages) if (m.toolUses) n += m.toolUses.length;
    return n;
  }

  /** Turn Goal Mode on (or adjust it). Passing null/empty text clears it. Merges with any
   *  existing active goal so Claude can retune cadence/deadline/patience mid-run without
   *  losing the original createdAt. Called from the UI (via SessionManager) and from a
   *  `<<goal>>` sentinel. See GoalState. */
  setGoal(input: { text: string; checkEveryMin?: number; deadlineHours?: number; maxNudges?: number } | null): void {
    if (!input || !input.text?.trim()) {
      this.config = { ...this.config, goal: null };
      this.broadcast({ type: 'goal_updated', sessionId: this.id, goal: null });
      console.log(`[Session ${this.id}] Goal mode OFF (cleared)`);
      return;
    }
    const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(n)));
    // Merge onto an existing NON-terminal goal (preserve createdAt/deadline when unspecified).
    const existing = this.config.goal && this.config.goal.status !== 'complete' && this.config.goal.status !== 'expired'
      ? this.config.goal
      : null;
    const now = Date.now();
    const checkEveryMin = clamp(input.checkEveryMin ?? existing?.checkEveryMin ?? 15, 1, 720);
    const maxNudges = clamp(input.maxNudges ?? existing?.maxNudges ?? 6, 1, 100);
    const deadlineAt = input.deadlineHours != null
      ? new Date(now + clamp(input.deadlineHours * 60, 1, 72 * 60) * 60_000).toISOString()
      : existing?.deadlineAt ?? new Date(now + 8 * 60 * 60_000).toISOString();
    const goal: GoalState = {
      text: input.text.trim().slice(0, 2000),
      createdAt: existing?.createdAt ?? new Date(now).toISOString(),
      deadlineAt,
      checkEveryMin,
      maxNudges,
      nudgeCount: 0,
      lastNudgeAt: null,
      progressMark: this.countToolUses(),
      status: 'active',
    };
    this.config = { ...this.config, goal };
    this.broadcast({ type: 'goal_updated', sessionId: this.id, goal });
    console.log(`[Session ${this.id}] Goal mode ON: "${goal.text.slice(0, 80)}" (deadline ${deadlineAt}, every ${checkEveryMin}m, max ${maxNudges} nudges)`);
  }

  /** Mutate goal runtime fields in place and broadcast. No-op if goal mode is off.
   *  Used by the GoalSupervisor to bump nudge counts / flip sleeping status. */
  updateGoal(mutator: (g: GoalState) => void): void {
    if (!this.config.goal) return;
    mutator(this.config.goal);
    this.broadcast({ type: 'goal_updated', sessionId: this.id, goal: this.config.goal });
  }

  /** Turn Goal Mode off with a completion note in the transcript. `reason` picks the label. */
  completeGoal(summary: string, reason: 'complete' | 'expired' = 'complete'): void {
    if (!this.config.goal) return;
    const label = reason === 'complete' ? '🎯 Goal complete' : '⏰ Goal deadline reached';
    this.emitSystemMessage(`${label}${summary ? ` — ${summary}` : ''}`);
    this.config = { ...this.config, goal: null };
    this.broadcast({ type: 'goal_updated', sessionId: this.id, goal: null });
    console.log(`[Session ${this.id}] Goal mode OFF (${reason})`);
  }

  /** Escalate to the user after too many no-progress check-ins. Keeps the goal (inert,
   *  status='stuck') so it can be resumed, and sets waitingFor so the card floats to "Needs you". */
  markGoalStuck(): void {
    const goal = this.config.goal;
    if (!goal) return;
    this.updateGoal(g => { g.status = 'stuck'; });
    this.waitingFor = 'goal';
    this.emitSystemMessage(`⚠️ Goal mode paused after ${goal.maxNudges} check-ins with no visible progress. Goal: "${goal.text}". Send a message to continue, or clear the goal.`);
    this.broadcast({ type: 'state_change', sessionId: this.id, status: this.status, waitingFor: 'goal' });
    console.log(`[Session ${this.id}] Goal stuck after ${goal.maxNudges} no-progress check-ins`);
  }

  /** Set (replace) or clear the session's user-facing reference notes. Called from the UI
   *  (via SessionManager) and from a `<<notes>>` sentinel — each replaces the whole note body
   *  rather than appending, so Claude just re-emits the full up-to-date text each time. */
  setNotes(notes: string | null): void {
    const trimmed = notes?.trim() || null;
    this.notes = trimmed ? trimmed.slice(0, 20_000) : null;
    this.notesUpdatedAt = trimmed ? new Date().toISOString() : null;
    this.broadcast({ type: 'notes_updated', sessionId: this.id, notes: this.notes, notesUpdatedAt: this.notesUpdatedAt });
  }

  /** Push a system message into the transcript and broadcast it. */
  emitSystemMessage(text: string): void {
    const sysMsg: UIMessage = { id: uuid(), role: 'system', content: text, timestamp: new Date().toISOString() };
    this.messages.push(sysMsg);
    this.broadcast({ type: 'assistant_message', sessionId: this.id, messageId: sysMsg.id, text });
  }

  /** Push an image (with an optional caption) inline into the chat as an assistant message.
   *  Stored as role 'assistant' — NOT 'system' — because the client only renders images inside
   *  assistant/user bubbles (system messages are centered gray text), and this must round-trip
   *  correctly through persistence too. */
  private emitImageMessage(caption: string, images: ImageAttachment[]): void {
    const msg: UIMessage = { id: uuid(), role: 'assistant', content: caption, images, timestamp: new Date().toISOString() };
    this.messages.push(msg);
    this.broadcast({ type: 'assistant_message', sessionId: this.id, messageId: msg.id, text: caption, images });
  }

  /** Display an on-disk image inline in the chat (from a <<show_image>> sentinel). Reads the
   *  file, base64-encodes it, and emits an image message. This is the ONLY way Claude can show
   *  the user an image — it can't otherwise surface a file's visual contents. Any file the
   *  server can read is allowed (Claude already has full filesystem read via its tools, so this
   *  is no escalation); relative paths resolve against the session cwd. Async + guarded so a
   *  bad path just posts a visible warning instead of throwing. */
  async showImageFromSentinel(rawPath: string, caption: string): Promise<void> {
    const path = String(rawPath || '').trim();
    if (!path) return;
    const abs = isAbsolute(path) ? path : resolvePath(this.config.cwd, path);
    const mime = IMAGE_MIME[extname(abs).toLowerCase()];
    if (!mime) {
      this.emitSystemMessage(`⚠️ Can't show "${path}" — not a supported image type (png, jpg, gif, webp, svg, avif, bmp).`);
      return;
    }
    try {
      const st = await statAsync(abs);
      if (!st.isFile()) { this.emitSystemMessage(`⚠️ Can't show "${path}" — not a file.`); return; }
      if (st.size > MAX_SHOW_IMAGE_BYTES) {
        // Too big to embed as-is — downscale to an inline preview via sips (ships with macOS)
        // instead of refusing. JPEG preview at ≤2048px longest side compresses a photo-sized
        // PNG by 10-50×. Falls back to the old advisory message only if sips can't handle it
        // (e.g. avif on older macOS, or a corrupt file). SVG can't be sips'd — advise directly.
        if (mime === 'image/svg+xml') {
          this.emitSystemMessage(`⚠️ SVG "${path}" is too large to show inline (${(st.size / 1e6).toFixed(1)}MB, max ${MAX_SHOW_IMAGE_BYTES / 1e6}MB). Open it from the Files tab instead.`);
          return;
        }
        const preview = await this.makeImagePreview(abs);
        if (preview) {
          const label = `${caption?.trim() || basename(abs)} (preview — full ${(st.size / 1e6).toFixed(1)}MB file in the Files tab)`;
          this.emitImageMessage(label, [{ data: preview, mimeType: 'image/jpeg' }]);
          console.log(`[Session ${this.id}] Showed downscaled preview inline: ${abs}`);
        } else {
          this.emitSystemMessage(`⚠️ Image "${path}" is too large to show inline (${(st.size / 1e6).toFixed(1)}MB, max ${MAX_SHOW_IMAGE_BYTES / 1e6}MB) and preview generation failed. Open it from the Files tab instead.`);
        }
        return;
      }
      const data = (await readFileAsync(abs)).toString('base64');
      this.emitImageMessage(caption?.trim() || basename(abs), [{ data, mimeType: mime }]);
      console.log(`[Session ${this.id}] Showed image inline: ${abs}`);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        this.emitSystemMessage(`⚠️ Couldn't show image "${path}" — file not found. ${await this.describeMissingPath(abs)}`);
      } else {
        this.emitSystemMessage(`⚠️ Couldn't show image "${path}": ${err.message}`);
      }
    }
  }

  /** Downscale an oversized image to a base64 JPEG preview using macOS's built-in `sips`
   *  (no dependency). Tries 2048px longest-side first, then 1280px if the result is somehow
   *  still over the cap. Returns null on any failure (unsupported format, corrupt file) —
   *  the caller falls back to the "open it from the Files tab" advisory. Temp file is always
   *  cleaned up. */
  private async makeImagePreview(absPath: string): Promise<string | null> {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const { tmpdir } = await import('os');
    const { unlink } = await import('fs/promises');
    const execFileP = promisify(execFile);
    const tmpOut = join(tmpdir(), `clauder-preview-${uuid()}.jpg`);
    try {
      for (const maxDim of [2048, 1280]) {
        await execFileP('sips', ['-Z', String(maxDim), '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', absPath, '--out', tmpOut], { timeout: 60_000 });
        const st = await statAsync(tmpOut);
        if (st.size > 0 && st.size <= MAX_SHOW_IMAGE_BYTES) {
          return (await readFileAsync(tmpOut)).toString('base64');
        }
      }
      return null;
    } catch {
      return null;
    } finally {
      await unlink(tmpOut).catch(() => {});
    }
  }

  /** Diagnostic context for a missing show_image path: what's actually in its parent directory
   *  (or the nearest existing ancestor), so a failed upstream step (a hung screenshot, a crop
   *  that silently produced nothing) is visible immediately instead of a dead-end "not found" —
   *  Claude can see the dir is empty/has a differently-named file and self-correct on retry. */
  private async describeMissingPath(abs: string): Promise<string> {
    let dir = dirname(abs);
    try {
      for (let i = 0; i < 5; i++) {
        if (existsSync(dir)) break;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      if (!existsSync(dir)) return '';
      const st = await statAsync(dir);
      if (!st.isDirectory()) return '';
      const entries = await readdirAsync(dir);
      if (entries.length === 0) return `"${dir}" exists but is empty — whatever was supposed to write this file didn't.`;
      const listed = entries.slice(0, 15).join(', ') + (entries.length > 15 ? `, … (${entries.length} total)` : '');
      return `"${dir}" contains: ${listed}`;
    } catch {
      return '';
    }
  }

  setPinned(pinned: boolean): void {
    this.config = { ...this.config, pinned };
    this.broadcast({ type: 'pinned_changed', sessionId: this.id, pinned });
  }

  /** Pin/unpin a single chat message so it stays visible in a sticky section above the
   *  scrollable chat, and is exempt from history trimming. No-op if the message isn't found
   *  (e.g. it was already trimmed before pinning was possible on an old session). */
  setMessagePinned(messageId: string, pinned: boolean): void {
    const msg = this.messages.find(m => m.id === messageId);
    if (!msg) return;
    msg.pinned = pinned;
    this.broadcast({ type: 'message_pinned', sessionId: this.id, messageId, pinned });
  }

  rename(newName: string): void {
    this.config = { ...this.config, name: newName };
    this.broadcast({
      type: 'session_renamed',
      sessionId: this.id,
      newName,
    });
  }

  setTags(tags: string[]): void {
    // Dedupe + drop empties defensively; ids are validated against the registry by the caller.
    const clean = [...new Set(tags.filter(t => typeof t === 'string' && t))];
    this.config = { ...this.config, tags: clean };
    this.broadcast({ type: 'tags_changed', sessionId: this.id, tags: clean });
  }

  setCwd(cwd: string): void {
    this.config = { ...this.config, cwd };
    // Clear SDK session ID — the old session was tied to the old project path
    // and can't be resumed in a different directory
    this.costBaseline = this.totalCostUsd; // fresh conversation next spawn — see field doc
    this.sdkSessionId = null;
    this.broadcast({
      type: 'cwd_changed',
      sessionId: this.id,
      cwd,
    });
    this.broadcastSkills();
  }

  /** Broadcast the current skill list for this session's cwd. Called on create + cwd change. */
  broadcastSkills(): void {
    try {
      const skills = getSkillsForCwd(this.config.cwd);
      this.broadcast({ type: 'skills_list', sessionId: this.id, skills });
    } catch {
      // discovery failures are non-fatal — client falls back to empty list
    }
  }

  /** Emit a debug log entry to both the in-memory array and WebSocket */
  private emitDebugLog(type: DebugLogEntryType, label: string, content: string, toolUseId?: string): void {
    const entry: DebugLogEntry = {
      id: uuid(),
      timestamp: new Date().toISOString(),
      type,
      label,
      content: content.slice(0, MAX_DEBUG_CONTENT_LENGTH),
      originalLength: content.length > MAX_DEBUG_CONTENT_LENGTH ? content.length : undefined,
      toolUseId,
    };
    this.debugLog.push(entry);
    if (this.debugLog.length > 500) {
      this.debugLog = this.debugLog.slice(-200);
    }
    this.broadcast({ type: 'debug_log', sessionId: this.id, entry });
  }

  /** Attach a tool result to the matching ToolUseInfo in messages */
  private attachToolResult(toolUseId: string, result: ToolResultInfo): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.toolUses) {
        const tu = msg.toolUses.find(t => t.id === toolUseId);
        if (tu) {
          tu.result = result;
          return;
        }
      }
    }
  }

  /** Look up the tool name for a given tool use ID */
  private findToolName(toolUseId: string): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.toolUses) {
        const tu = msg.toolUses.find(t => t.id === toolUseId);
        if (tu) return tu.name;
      }
    }
    return null;
  }

  private spawnClaudeProcess(extraArgs: string[], stdinPayload: string, keepStdinOpen = false): ChildProcess {
    // Validate cwd exists before spawning — missing cwd causes a misleading ENOENT on the binary
    if (!existsSync(this.config.cwd)) {
      throw new Error(`Working directory does not exist: ${this.config.cwd}`);
    }
    const cliArgs = [
      '--print',
      '--output-format=stream-json',
      '--input-format=stream-json',
      '--include-partial-messages',
      '--verbose',
      ...extraArgs,
    ];
    // Native binary (v2.1.120+): run directly. Legacy cli.js: run via node.
    const command = CLI_IS_NATIVE ? CLAUDE_CLI_PATH : process.execPath;
    const args = CLI_IS_NATIVE ? cliArgs : [CLAUDE_CLI_PATH, ...cliArgs];
    console.log(`[Session ${this.id}] Spawning: ${command} ${args.slice(0, 5).join(' ')} ...`);
    const proc = spawn(command, args, {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Credit guardrail: sub-agents inherit the parent's model by default — so a Fable session
      // fans out Fable contexts for grep-grade work. A sub-agent starts with a cold context
      // anyway (there's no warm cache to lose), so a cheaper default is pure savings. It only
      // reaches sub-agents launched without a model, though: a Task call that names one
      // (`sonnet`, `haiku`) or an agent definition that pins one still wins (CLI ≥2.1.251), and
      // the built-in Explore agent pins "inherit", so it runs on the parent's model, capped at
      // Opus (CLI 2.1.284). CLAUDE_CODE_SUBAGENT_MODEL_FORCE would override all of those, Haiku
      // picks included. Honors an operator override from the environment.
      env: { ...process.env, CLAUDE_CODE_SUBAGENT_MODEL: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? 'claude-sonnet-5-5' },
    });
    // Catch spawn errors (e.g. ENOENT) so they don't crash the process
    proc.on('error', (err) => {
      console.error(`[Session ${this.id}] Spawn error: ${err.message}`);
    });
    proc.stdin!.write(stdinPayload + '\n');
    if (!keepStdinOpen) proc.stdin!.end();
    return proc;
  }

  /** Deliver the user's answer to an AskUserQuestion.
   *
   *  AskUserQuestion auto-fails in headless (--print) mode, so the turn that asked has
   *  already ended by the time a human answers — the old stdin tool_result path can't apply
   *  (the process is gone), and writing a stale tool_result to a process now doing OTHER work
   *  is unsafe. So we deliver the answer as the next *input* instead:
   *    - busy  → jump to the FRONT of the queue, so it's processed next and never buried
   *              behind other queued messages (the previous code pushed to the back, which is
   *              exactly how answers got lost when the session was working);
   *    - idle  → send immediately.
   */
  respondToQuestion(toolUseId: string, answer: string): void {
    console.log(`[Session ${this.id}] Question answer for ${toolUseId}: ${answer.slice(0, 80)}`);
    // The human answered — cancel the proceed-on-its-own timeout and clear the waiting indicator.
    this.clearQuestionTimer();
    this.pendingQuestion = null;
    this.waitingFor = null;
    this.broadcast({ type: 'state_change', sessionId: this.id, status: this.status, waitingFor: null });
    if (this.status === 'working' || this.pendingTaskSwitch) {
      this.queuedMessages.unshift({ text: answer, internal: false });
      this.broadcast({ type: 'queue_update', sessionId: this.id, queue: [...this.queuedMessages] });
    } else {
      this.sendMessage(answer, undefined, { internal: false }).catch(err => {
        console.error(`[Session ${this.id}] Failed to deliver question answer:`, err);
      });
    }
  }

  private async *readNdjson(proc: ChildProcess): AsyncGenerator<unknown> {
    const queue: unknown[] = [];
    let done = false;
    let resolveNext: (() => void) | null = null;

    const enqueue = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        queue.push(JSON.parse(trimmed));
        if (resolveNext) { resolveNext(); resolveNext = null; }
      } catch {
        // skip non-JSON lines (e.g. npm warnings)
      }
    };

    // Handle spawn errors (e.g. ENOENT) — mark stream as done so the generator exits
    proc.on('error', () => {
      done = true;
      if (resolveNext) { resolveNext(); resolveNext = null; }
    });

    let partial = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      const text = partial + chunk.toString();
      const lines = text.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) enqueue(line);
    });

    proc.stdout!.on('end', () => {
      if (partial.trim()) enqueue(partial);
      done = true;
      if (resolveNext) { resolveNext(); resolveNext = null; }
    });

    // Keep a small rolling tail of stderr for the exit error below. Without it, a nonzero
    // exit logged only "Claude process exited with code 1" (91 occurrences in prod with zero
    // clue each time — the OAuth breakage hid behind exactly this for weeks). Folding the tail
    // into the thrown message also lets the catch-block's error classifiers (auth / 413 /
    // rate-limit / plan-model regexes) see what the process actually said.
    const stderrTail: string[] = [];
    proc.stderr!.on('data', (chunk: Buffer) => {
      const trimmed = chunk.toString().trim();
      if (trimmed) {
        this.emitDebugLog('stderr', 'stderr', trimmed);
        stderrTail.push(trimmed);
        while (stderrTail.length > 1 && stderrTail.join(' ').length > 500) stderrTail.shift();
      }
    });

    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else if (done) {
        break;
      } else {
        await new Promise<void>(resolve => { resolveNext = resolve; });
      }
    }

    // Wait for exit and check code
    const exitCode = await new Promise<number | null>(resolve => {
      if (proc.exitCode !== null) {
        resolve(proc.exitCode);
      } else {
        proc.once('close', (code) => resolve(code));
      }
    });

    // Non-zero exit that isn't from a signal (SIGINT=130, SIGTERM=143 on unix)
    // is a real error. Signal-killed processes are expected during interrupt/stall.
    if (exitCode !== null && exitCode !== 0 && exitCode !== 130 && exitCode !== 143) {
      const tail = stderrTail.join(' ⏎ ').slice(-300);
      throw new Error(`Claude process exited with code ${exitCode}${tail ? ` — stderr: ${tail}` : ''}`);
    }
  }

  async generateSummary(): Promise<string> {
    const conversationMsgs = this.messages
      .filter(m => m.role !== 'system')
      .slice(-20);

    if (conversationMsgs.length === 0) {
      return 'No messages yet.';
    }

    const transcript = conversationMsgs
      .map(m => `${m.role}: ${m.content.slice(0, 500)}`)
      .join('\n\n');

    const prompt = `Give a brief overview of this coding session as 2-4 short bullet points. Each bullet should be a few words, not full sentences. Focus on what was built/changed/fixed. Do NOT start with "This conversation..." or any preamble — just the bullets. Do NOT use any tools.\n\nExample format:\n• Added user auth endpoint\n• Fixed cart total calculation\n• Refactored DB queries\n\nConversation:\n${transcript}`;

    const flags = [
      '--permission-mode', 'plan',
      '--no-session-persistence',
      '--disallowed-tools', 'Read,Write,Edit,Bash,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit',
    ];
    const stdinPayload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
    });

    const proc = this.spawnClaudeProcess(flags, stdinPayload);
    const killTimeout = setTimeout(() => {
      console.warn(`[Session ${this.id}] Summary generation timed out after 2 minutes, killing`);
      proc.kill('SIGTERM');
    }, 120_000);

    console.log(`[Session ${this.id}] Starting summary generation...`);
    let summaryText = '';
    try {
      for await (const msg of this.readNdjson(proc)) {
        const m = msg as any;
        if (m.type === 'assistant') {
          const content = m.message?.content;
          if (content) {
            summaryText += content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
          }
        }
      }
      console.log(`[Session ${this.id}] Summary generation complete (${summaryText.length} chars)`);
      return summaryText || 'Unable to generate summary.';
    } catch (err: any) {
      console.error(`[Session ${this.id}] Summary generation failed:`, err.message);
      return 'Error generating summary.';
    } finally {
      clearTimeout(killTimeout);
    }
  }

  /** Project wrap-up for the "Archive Project" feature (see archive.ts). Modeled exactly on
   *  generateSummary() — same subprocess flags, same NDJSON drain, same 2-minute kill timeout —
   *  just a different prompt geared at "what was accomplished and how to pick this back up"
   *  rather than a short bullet-point recap. Runs on the subscription (no ANTHROPIC_API_KEY),
   *  same as generateSummary/reviewGoalMet. Never throws — archiving must not be blocked by a
   *  failed wrap-up; the caller (archive.ts) falls back to a fixed string on empty/'' return. */
  async generateArchiveSummary(): Promise<string> {
    const conversationMsgs = this.messages
      .filter(m => m.role !== 'system')
      .slice(-20);

    if (conversationMsgs.length === 0) {
      return '';
    }

    const transcript = conversationMsgs
      .map(m => `${m.role}: ${m.content.slice(0, 500)}`)
      .join('\n\n');

    const prompt = `Write a project wrap-up in markdown for this coding session. Cover: what was accomplished, key decisions made, current state, and how someone would pick this project back up later. Be concrete. Do NOT use any tools.\n\nConversation:\n${transcript}`;

    const flags = [
      '--permission-mode', 'plan',
      '--no-session-persistence',
      '--disallowed-tools', 'Read,Write,Edit,Bash,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit',
    ];
    const stdinPayload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
    });

    const proc = this.spawnClaudeProcess(flags, stdinPayload);
    const killTimeout = setTimeout(() => {
      console.warn(`[Session ${this.id}] Archive wrap-up timed out after 2 minutes, killing`);
      proc.kill('SIGTERM');
    }, 120_000);

    console.log(`[Session ${this.id}] Starting archive wrap-up generation...`);
    let wrapupText = '';
    try {
      for await (const msg of this.readNdjson(proc)) {
        const m = msg as any;
        if (m.type === 'assistant') {
          const content = m.message?.content;
          if (content) {
            wrapupText += content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
          }
        }
      }
      console.log(`[Session ${this.id}] Archive wrap-up complete (${wrapupText.length} chars)`);
      return wrapupText;
    } catch (err: any) {
      console.error(`[Session ${this.id}] Archive wrap-up generation failed:`, err.message);
      return '';
    } finally {
      clearTimeout(killTimeout);
    }
  }

  /** Out-of-band "is the goal met?" check for Goal Mode. Runs a cheap one-shot Haiku query
   *  through the CLI — same subscription (OAuth) auth as every session, so NO ANTHROPIC_API_KEY
   *  and NO pay-as-you-go cost, just a little subscription quota. Fails CLOSED (returns false)
   *  on any error: a false negative just costs one more nudge, whereas a false positive would
   *  kill goal mode early. Mirrors generateSummary()'s subprocess pattern. */
  async reviewGoalMet(goalText: string): Promise<boolean> {
    const conversationMsgs = this.messages.filter(m => m.role !== 'system').slice(-12);
    if (conversationMsgs.length === 0) return false;
    const transcript = conversationMsgs
      .map(m => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 400) : ''}`)
      .join('\n\n');
    const prompt =
      `A coding session is working toward this GOAL:\n"${goalText}"\n\n` +
      `Recent transcript:\n${transcript}\n\n` +
      `Has the goal been FULLY and verifiably accomplished — not merely planned, attempted, or ` +
      `in progress? If a long-running process was started but not yet confirmed finished, the ` +
      `answer is no. Reply with exactly one word: "yes" or "no". Do NOT use any tools.`;

    const flags = [
      '--model', 'claude-haiku-4-5-20251001',
      '--permission-mode', 'plan',
      '--no-session-persistence',
      '--disallowed-tools', 'Read,Write,Edit,Bash,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit',
    ];
    const stdinPayload = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } });

    let proc: ChildProcess;
    try {
      proc = this.spawnClaudeProcess(flags, stdinPayload);
    } catch {
      return false;
    }
    const killTimeout = setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }, 60_000);
    let out = '';
    try {
      for await (const msg of this.readNdjson(proc)) {
        const m = msg as any;
        if (m.type === 'assistant') {
          const content = m.message?.content;
          if (content) out += content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        }
      }
    } catch {
      return false;
    } finally {
      clearTimeout(killTimeout);
    }
    return out.trim().toLowerCase().startsWith('yes');
  }

  async sendMessage(message: string, images?: ImageAttachment[], opts?: { internal?: boolean; planMode?: boolean; files?: FileAttachment[]; model?: string; effort?: EffortLevel }): Promise<void> {
    // If busy OR a task-switch classification is in flight, queue and bail.
    // Queueing while classifying preserves order: messages arriving during the
    // ~500ms Haiku call wait their turn instead of racing.
    if (this.status === 'working' || this.pendingTaskSwitch) {
      this.queueMessage(message, images, { internal: opts?.internal, files: opts?.files, model: opts?.model, effort: opts?.effort });
      return;
    }

    // Any new user input cancels a pending wakeup — Claude has fresh input now.
    // Skip for internal messages: a wakeup-fired message shouldn't cancel itself.
    if (this.pendingWakeup && !opts?.internal) {
      this.cancelWakeup();
    }

    // A genuine user message interrupts a running model plan (they want to intervene).
    // Internal messages (the plan's own step tasks) don't — that's how the plan advances.
    if (this.config.modelPlan && !opts?.internal) {
      this.stopModelPlan();
    }

    // Fresh user input also resolves the answer gate — the human responded (even if not via
    // the answer UI), so the proceed-on-its-own timeout should no longer fire. (respondToQuestion
    // already clears it before queuing the answer, so this only fires for unrelated new input.)
    if (this.pendingQuestion && !opts?.internal) {
      this.clearQuestionTimer();
      this.pendingQuestion = null;
    }

    // Auto-compact when the user starts a new task after a pause.
    // Internal messages (triggers, wakeups, queue-drains of programmatic sends) skip this.
    if (!opts?.internal && this.shouldCheckForTaskSwitch(message)) {
      this.pendingTaskSwitch = true;
      let isSwitch = false;
      try {
        isSwitch = await classifyTaskSwitch(this.messages, message);
      } catch {
        // classifier errors never block the message
      } finally {
        // Always clear, even if the await is interrupted — a stuck flag silently
        // queues every future message on this session forever.
        this.pendingTaskSwitch = false;
      }

      if (isSwitch) {
        this.lastAutoCompactAt = Date.now();
        const sysMsg: UIMessage = {
          id: uuid(),
          role: 'system',
          content: '↩ New task detected — compacting context before continuing.',
          timestamp: new Date().toISOString(),
        };
        this.messages.push(sysMsg);
        this.broadcast({ type: 'assistant_message', sessionId: this.id, messageId: sysMsg.id, text: sysMsg.content });
        // Put the real message at the FRONT of the queue so it runs before any messages
        // that arrived during the classifier await. /compact runs first via recursion below.
        this.queuedMessages.unshift({ text: message, images: images?.length ? images : undefined, internal: false });
        this.broadcast({ type: 'queue_update', sessionId: this.id, queue: [...this.queuedMessages] });
        await this.sendMessage('/compact', undefined, { internal: true });
        return;
      }
    }

    // Add user message to history
    const userMsgId = uuid();
    const files = opts?.files;
    const userMsg: UIMessage = {
      id: userMsgId,
      role: 'user',
      content: message,
      images: images?.length ? images : undefined,
      files: files?.length ? files : undefined,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(userMsg);
    this.broadcast({ type: 'user_message_echo', sessionId: this.id, messageId: userMsgId, text: message, images: images?.length ? images : undefined, files: files?.length ? files : undefined });

    // Update status
    this.status = 'working';
    this.error = null;
    this.waitingFor = null;
    this.lastActiveAt = new Date().toISOString();
    this.broadcast({ type: 'state_change', sessionId: this.id, status: 'working', waitingFor: null });
    console.log(`[Session ${this.id}] Starting query (resume=${!!this.sdkSessionId})`);

    // Stall detection: abort if no SDK messages for 13 minutes.
    // The Claude Code CLI hard-caps the Bash tool's own `timeout` param at 600,000ms (10 min,
    // confirmed in the CLI binary's tool schema — not something Clauder can override). This
    // MUST stay longer than that ceiling plus buffer for API round-trip, so a single long-running
    // Bash command (a build, an install) always gets to return its own graceful timeout result
    // first, instead of Clauder's stall monitor killing the whole query out from under it.
    // (Previously 8 min — shorter than the CLI's own 10-min ceiling, which was the actual bug:
    // any Bash call run near its max legitimately looked "stalled" and got killed early.)
    const STALL_TIMEOUT_MS = 13 * 60 * 1000;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let stallAborted = false;
    // Per-turn summary metrics — logged as one "Turn done" line at query completion, which
    // makes the log an operational record (duration/model/cost per turn across 18 sessions).
    const turnStartMs = Date.now();
    const costBefore = this.totalCostUsd;
    const quotaBefore = getRateLimitInfo().session?.usedPercent ?? null;
    let turnToolCount = 0;
    let effectiveModel = '';
    let effectiveEffort = '';
    let turnStopReason = '';
    let turnUsage: { input: number; cacheRead: number; cacheWrite: number; output: number; thinking: number } | null = null;
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        console.log(`[Session ${this.id}] Query stalled (no messages for 13 min), aborting`);
        stallAborted = true;
        this.activeProcess?.kill('SIGTERM');
      }, STALL_TIMEOUT_MS);
    };
    resetStallTimer();

    try {
      // Build CLI flags
      // One-shot plan mode overrides the session's permission mode for this CLI invocation only.
      // The session's persistent permissionMode is unchanged.
      const effectiveMode = opts?.planMode ? 'plan' : this.permissionMode;
      const flags: string[] = ['--permission-mode', effectiveMode];

      if (this.sdkSessionId) {
        flags.push('--resume', this.sdkSessionId);
        if (this.needsFork) {
          flags.push('--fork-session');
        }
      }

      // Custom Plan: a plan turn always runs on Fable (or Opus if Fable isn't available on
      // this subscription), at high effort — regardless of the session's configured model.
      // This is a per-turn override ONLY; this.config.model is left untouched.
      if (opts?.planMode) {
        effectiveModel = this.planFallbackToOpus ? 'claude-opus-5-5' : 'claude-fable-5-1';
        flags.push('--model', effectiveModel);
        flags.push('--effort', 'high'); // planning quality drives the cheap execution that follows — exempt from the cap
        effectiveEffort = 'high';
      } else {
        // Per-turn override (the "Send with" chip): use opts.model/opts.effort for THIS turn
        // only — never mutate this.config. Mirrors the planMode override above. The chosen
        // effort still feeds the quota guardrail below, so an override can't dodge the cap.
        const turnModel = (typeof opts?.model === 'string' && opts.model.startsWith('claude-')) ? opts.model : this.config.model;
        const turnEffort = opts?.effort ?? (this.config.effort as EffortLevel | undefined);
        effectiveModel = turnModel || '(default)';
        if (turnModel) {
          flags.push('--model', turnModel);
        }
        // Credit guardrail: cap effort as the five_hour window fills (see rate-limits.ts).
        // Cache-safe — same model, fewer thinking tokens. Internal turns (wakeups, plan
        // steps, monitors) are capped too: they're exactly the routine work that shouldn't
        // burn the window. Announce engage/disengage once, not every turn.
        const cap = effortCapForQuota(getRateLimitInfo().session?.usedPercent);
        const { effort: cappedEffort, capped } = capEffort(turnEffort, cap);
        effectiveEffort = cappedEffort ?? '(default)';
        if (capped !== this.quotaCapActive) {
          this.quotaCapActive = capped;
          this.emitSystemMessage(capped
            ? `🪫 Credit guardrail: 5-hour window at ${getRateLimitInfo().session?.usedPercent}% — effort capped at "${cap}" until it drops below ${cap === 'low' ? 90 : 75}%. Plans are exempt; lower the cap by resting or raise it in Settings.`
            : '🔋 Credit guardrail released — effort back to your configured level.');
        }
        if (cappedEffort) {
          flags.push('--effort', cappedEffort);
        }
      }

      // Controller mode: load the Clauder MCP server so this session can orchestrate others
      if (this.config.controllerMode && CLAUDER_MCP_PATH) {
        const mcpConfigPath = join(MCP_CONFIG_DIR, `${this.id}.json`);
        const mcpConfig = {
          mcpServers: {
            clauder: {
              command: process.execPath,
              args: [CLAUDER_MCP_PATH],
              env: {
                CLAUDER_URL: `http://localhost:${CLAUDER_PORT}`,
                CLAUDER_CONTROLLER_ID: this.id,
              },
            },
          },
        };
        writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
        flags.push('--mcp-config', mcpConfigPath);
      }

      this.ensureTaskRoster();
      const systemParts: string[] = [
        'When running Bash commands that involve SSH, SCP, network requests, package installs (apt-get, pip, npm), or builds, always set the timeout parameter to at least 300000 (5 minutes). The default 2-minute timeout is too short for these operations. The timeout parameter has a hard maximum of 600000 (10 minutes) — if a command may legitimately run longer than that, run it in the background (e.g. nohup ... & or a detached process) and poll/check on it in a follow-up turn instead of blocking on a single Bash call.',
        'For any task that involves a process taking longer than a few minutes (a build, a long install, training/indexing, a slow migration, waiting on an external service): do NOT sit in one Bash call hoping it finishes within the tool\'s 10-minute ceiling. Instead, kick it off in the background so it runs independent of this turn — `nohup <cmd> > /tmp/task.log 2>&1 &` (or `disown`, or a detached process), capture its PID/log path, then call the ScheduleWakeup tool to have Clauder check back in later (delaySeconds accepts up to 3600 = 1 hour) instead of blocking. When the wakeup fires you\'ll be prompted to check the log/process and continue — if it\'s still not done, just call ScheduleWakeup again. This is the standard pattern for anything that outlives a single tool call or a single turn.',
        'IMPORTANT — you are running INSIDE Clauder, a web multiplexer that manages this session; you are NOT a standalone Claude Code CLI. Any work that must run later, at a set time, or on a repeating schedule MUST be routed THROUGH CLAUDER. Do NOT use cron/crontab, the CronCreate tool, the `schedule` or `loop` skills, cloud "routines", or Workflow-based scheduling — those run outside Clauder, are unsupervised, invisible in Clauder\'s Scheduler, and will not fire here. Instead: (1) To schedule a future one-off action, emit `<<schedule_trigger>>{"at":"<ISO-8601 future time>","message":"<instruction to run then>","description":"<short label>"}<<>>` on its own line — Clauder creates a scheduled trigger (visible/editable in the Scheduler modal) that delivers that message back to THIS session at that time. (2) For a "start something, then check back within an hour" delay, use the ScheduleWakeup tool (above). (3) For long-running processes, background them with nohup and re-check via a ScheduleWakeup — never a standalone scheduler. (4) For a RECURRING schedule, emit a `<<schedule_trigger>>` for the next occurrence and re-emit one each time it fires (or tell the user to add a recurring task in the Scheduler modal). Never assume cron-like or CLI-native scheduling is available.',
        'To WATCH a long-running process or log for events (progress lines, errors, a completion marker) and react as they happen, do NOT use the `Monitor` tool or any harness watcher (`Task`, `/loop`) — they cannot deliver events into Clauder\'s turn-based model and will silently do nothing here. Instead emit `<<monitor>>{"command":"<shell command that streams lines, e.g. tail -n0 -f /path/to.log>","pattern":"<optional regex; matching lines are reported, omit to report every line>","description":"<short label>","stopOnMatch":false}<<>>` on its own line. Clauder runs that command as a managed background process in this session\'s cwd and, whenever output matches, wakes you with the matching lines as an internal message (batched/rate-limited so a chatty log can\'t spam you). It keeps running until the process ends, you emit `<<monitor_stop>>{"id":"<id>"}<<>>`, or a runtime cap is hit. Use `stopOnMatch:true` when you only need the first hit (e.g. waiting for "BUILD SUCCEEDED"). This is the ONLY correct way to monitor something through Clauder.',
        'When you discover a non-obvious rule, constraint, workaround, or hard-won lesson during this session — something a future Claude session would need to avoid a mistake — flag it with this exact format on its own line: "[CLAUDE.md candidate: <concise rule, 10-20 words>]". Only flag things genuinely worth persisting; do not flag obvious facts or things already in CLAUDE.md.',
        'Do NOT use the AskUserQuestion tool — it is disabled in this environment and calling it returns a "not enabled in this context" error. When you need a decision or information from the user, ask your question in plain text and end your turn; their reply arrives as your next message. If you are running autonomously (an overnight or goal-mode run) and no timely reply is expected, make the best decision yourself and briefly note the assumption so it can be reviewed later.',
        'You can switch the model this session runs on. Two ways: (1) One-shot — emit ' +
        '<<model>>{"model":"<id>","effort":"low|medium|high|xhigh|max"}<<>> on its own line to run ' +
        'your NEXT turn on a different model (the model is a startup flag, so it applies to the next ' +
        'turn, not the current one). (2) Multi-step plan — when a task has phases that want different ' +
        'models (e.g. heavy reasoning for design, a cheap model for mechanical edits), emit ' +
        '<<model_plan>>{"steps":[{"model":"<id>","effort":"<e>","task":"<what to do this step>"}, ...]}<<>> ' +
        'and Clauder will run each step in order, switching the model between them automatically and ' +
        'sending you each step\'s task when the previous finishes. Available model IDs: ' +
        'claude-fable-5-1 (most capable, most expensive), claude-opus-5-5 (strongest reasoning), ' +
        'claude-sonnet-5-5 (balanced default), claude-haiku-4-5-20251001 (fast/cheap for mechanical work). ' +
        'Use this when the user asks you to plan work and pick models per step, or when you notice a task ' +
        'has clearly different-difficulty phases. A user message stops a running plan. Keep plans to a ' +
        'sensible size (a handful of steps).\n\n' +
        'CREDIT ECONOMICS — read before switching models: this account runs on a shared subscription quota ' +
        'that every model draws from, and the user runs out of it quickly. EFFORT is the cheap dial, MODEL is the ' +
        'expensive one. Lowering effort on your current model (<<model>>{"effort":"low"}<<>>) keeps the prompt ' +
        'cache warm and just spends fewer thinking tokens — ideal for mechanical/grunt turns. Switching models ' +
        'cold-starts the prompt cache: the whole context is re-written at 2× the input price (on a large context ' +
        'that one switch can cost more than several low-effort turns on the current model). So: for routine work ' +
        'stay on your model and drop effort; raise effort (not model) for a genuinely hard step; switch models ' +
        'only for a sustained BATCH of cheap work, and batch it so you switch once, not per message. Sub-agents ' +
        'are the exception — they start cold anyway, so they always run on a cheap model.',
        'To show the user an image inline in the chat — a rendered file, a screenshot, a generated ' +
        'asset, a diagram, chart output — emit <<show_image>>{"path":"<file path>","caption":"<label>"}<<>> ' +
        'on its own line. The path may be absolute or relative to the working directory; emit one ' +
        'sentinel per image to show several labeled images side by side. This is the ONLY way to display ' +
        'an image to the user — writing a file to disk does NOT make it visible, and the user cannot see ' +
        'a file\'s visual contents unless you show_image it (or they open it from the Files tab). Never ' +
        'claim the user can see an image ("in front of you", "above") unless you have actually emitted a ' +
        'show_image sentinel for it this turn.',
        'This session has a "Notes" tab in the UI for practical, user-facing reference info — ' +
        'NOT project documentation (that belongs in CLAUDE.md) and NOT a progress summary (that\'s the Summary tab). ' +
        'Put things the user will actually need to reference to use what you built: how to start/restart a dev server, ' +
        'the URL to view something in a browser, a port number, test credentials, a CLI command they\'ll want to re-run. ' +
        'Maintain it by emitting the FULL current note body (it replaces what\'s there, it does not append) on its own line: ' +
        '<<notes>>{"content":"<markdown>"}<<>>. Update it whenever this info changes; leave it out of your turn entirely ' +
        'when there\'s nothing worth noting yet. Keep it short and practical, not a running log.',
        'SUB-AGENTS (the Task/Agent tool) run OUTSIDE Clauder\'s control. A sub-agent you spawn does NOT inherit this guidance and CANNOT use Clauder\'s sentinels (<<monitor>>, <<schedule_trigger>>) or ScheduleWakeup — its output is not bridged back to Clauder, and it cannot wake this session; any Monitor/cron/loop/scheduler tool it calls silently does nothing. Therefore YOU, the top-level session, own ALL monitoring and scheduling. Do not delegate a "watch this" or "check back later" job to a sub-agent. Instead: set up the <<monitor>> or <<schedule_trigger>> YOURSELF (the monitor runs server-side and will wake you even while a sub-agent is running), and when you spawn a sub-agent, put an explicit line in its task prompt telling it NOT to use the Monitor tool or any scheduler/watcher — it should do its bounded task and return its result to you, and you handle any watching or follow-up.',
        // Fixed text: the roster path depends only on the session id, so this sentence never
        // changes and never invalidates the prompt cache — even when the user switches tasks.
        'This Clauder session can hold several tasks: separate conversations about the same project that the user switches between. You only see the current one. A roster of the session\'s tasks (names, when each was last active, how each started) is kept at `' + taskRosterPath(this.id) + '`. Read it only if the user refers to another task or it would clearly help to know what else is going on in this session; otherwise ignore it.',
      ];

      // Custom Plan: on a plan turn ONLY, instruct the planner to produce per-step model
      // assignments and embed a machine-readable steps block that the accept handler parses
      // into an auto-driven model plan. Guarded by opts?.planMode so it never leaks into
      // normal turns.
      if (opts?.planMode) {
        systemParts.push(
          'You are PLANNING, not executing. Produce a concrete, ordered step-by-step plan for the request — do not make code changes now.\n\n' +
          'CREDIT RULES — this account runs on a shared subscription quota that runs out fast, so the plan must ' +
          'minimize credit use, not just pick "a cheap model per step":\n' +
          '1. EFFORT is the primary dial. Lowering effort keeps the prompt cache warm; switching models cold-starts ' +
          'it (the whole context is re-written at 2× input price — on a big context one switch costs more than ' +
          'several low-effort turns). Assign LOW effort to mechanical steps and HIGH only where reasoning is the work.\n' +
          '2. BATCH BY MODEL. Group consecutive steps on the same model and order the plan to switch models as few ' +
          'times as possible (ideally: one block on a cheap model, one block on a strong model). Never alternate ' +
          'models step-by-step. A single short step is never worth a model switch — fold it into the neighboring ' +
          'block at low effort instead.\n' +
          '3. Model tiers (cheapest first): claude-haiku-4-5-20251001 — mechanical edits, renames, boilerplate, config ' +
          'churn, simple wiring; claude-sonnet-5-5 — standard implementation; claude-opus-5-5 — hard debugging, ' +
          'safety-critical or architectural work; claude-fable-5-1 — only exceptionally hard reasoning (≈2× Opus).\n' +
          '4. Verification steps (build/tests) belong at the END of the block they verify, on that block\'s model at ' +
          'low effort — not as separate model switches.\n\n' +
          'Design steps to run WITHOUT human interaction wherever possible: no questions mid-step, no "ask the user"; ' +
          'each step should verify its own work (build/tests) instead. Each step\'s task must be self-contained enough to execute cold.\n\n' +
          'Present your plan directly as your final assistant message: the human-readable plan prose, ' +
          'followed by exactly one fenced block in this format (≤20 steps):\n' +
          '```clauder-steps\n{"steps":[{"model":"<model-id>","effort":"low|medium|high|xhigh|max","task":"<what to do this step>"}]}\n```\n\n' +
          'Do NOT call the ExitPlanMode tool — it is unavailable in this environment. Do not apologize about tools ' +
          'or narrate their absence; just present the plan and the block. Clauder detects the block, shows the plan ' +
          'for the user to approve, then executes the steps with automatic model switching once approved.'
        );
      }

      if (this.config.controllerMode) {
        systemParts.push(
          'You are the **controller** in a multi-session Clauder setup. Other Claude sessions ("workers") run in parallel; you orchestrate them via the `clauder` MCP tools.\n\n' +
          '**Worker control:**\n' +
          '- `list_sessions()` — see all available workers and status\n' +
          '- `send_message(sessionId, message)` — dispatch (returns immediately)\n' +
          '- `wait_until_idle(sessionId, timeoutSec)` — block until worker finishes its turn\n' +
          '- `get_recent_messages(sessionId, count)` — read what a worker did\n' +
          '- `get_session_status(sessionId)` — quick status check\n\n' +
          '**Self-managed watches (for long-running monitoring):**\n' +
          '- `add_watch(description, intervalSeconds, message)` — set up a recurring self-check-in. Every interval, the Clauder server will send the given message to you as if the user typed it.\n' +
          '- `list_watches()` — see your active watches\n' +
          '- `remove_watch(watchId)` — stop a watch (do this when monitoring is no longer needed)\n' +
          '- `update_watch(watchId, ...)` — adjust interval/message\n\n' +
          '**Overnight workflow:** dispatch tasks to workers with `send_message`, then add a watch like `add_watch("Check on project X", 1200, "Check on the project X worker. If idle, review its recent messages and decide next steps.")`. When that fires, investigate, possibly dispatch more work or remove the watch when done.\n\n' +
          '**Cost discipline:** Be focused. Don\'t add redundant watches. Remove watches the moment work completes. If a worker errors, read its messages before retrying.'
        );
      }

      if (this.config.systemPrompt) {
        systemParts.push(this.config.systemPrompt);
      }

      // Prime new session with context from prior conversation after a reset
      if (this.wasReset && !this.sdkSessionId) {
        let contextPayload: string | null = null;
        if (this.compactedContext) {
          contextPayload = this.compactedContext;
          console.log(`[Session ${this.id}] Priming with SDK compacted context (${contextPayload.length} chars)`);
        } else {
          const contextParts: string[] = [];
          if (this.summary) {
            contextParts.push(`## Prior conversation summary\n${this.summary}`);
          }
          const recentMessages = this.messages.slice(-20);
          if (recentMessages.length > 0) {
            const transcript = recentMessages
              .filter(m => m.role === 'user' || m.role === 'assistant')
              .map(m => {
                const content = typeof m.content === 'string' ? m.content : '[complex content]';
                const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content;
                return `${m.role === 'user' ? 'User' : 'Assistant'}: ${truncated}`;
              })
              .join('\n\n');
            contextParts.push(`## Recent conversation history\n${transcript}`);
          }
          if (contextParts.length > 0) {
            contextPayload = contextParts.join('\n\n');
            console.log(`[Session ${this.id}] Priming with fallback context (${contextPayload.length} chars)`);
          }
        }

        if (contextPayload) {
          systemParts.push(
            'IMPORTANT: This session was reset because the previous conversation exceeded the API size limit. ' +
            'Below is context from the prior conversation to help you continue seamlessly. ' +
            'Do NOT mention this reset to the user — just pick up where things left off.\n\n' +
            contextPayload
          );
        }
        this.wasReset = false;
      }

      // Goal Mode: re-inject the goal + persistence rules on every turn so they survive
      // compaction (same rationale as the reset-priming above). The server-side supervisor
      // is the backstop; this language is what makes Claude reach for ScheduleWakeup itself.
      if (this.config.goal && (this.config.goal.status === 'active' || this.config.goal.status === 'sleeping')) {
        const g = this.config.goal;
        systemParts.push(
          `**GOAL MODE is ON.** You are to keep working until this goal is met:\n"${g.text}"\n\n` +
          `Rules while goal mode is on:\n` +
          `- Do NOT end your turn with the goal incomplete just because you started a long-running process. ` +
          `If something will take a while (a build, test run, deploy, training/index job), call the ScheduleWakeup tool to check back in about ${g.checkEveryMin} minutes, then end the turn. ` +
          `Clauder re-prompts you when the timer fires so you can check the process and continue. If it's still not done, schedule another check.\n` +
          `- When the goal is genuinely and fully complete, emit this on its own line to turn goal mode off: <<goal_complete>>{"summary":"<what was accomplished>"}<<>>\n` +
          `- To adjust the check-in cadence, deadline, or patience, re-emit: <<goal>>{"text":"<goal>","checkEveryMin":${g.checkEveryMin},"deadlineHours":8,"maxNudges":${g.maxNudges}}<<>>\n` +
          `- If you hit a hard blocker that truly needs the user (credentials, an irreversible decision), state it plainly and stop — don't spin.\n` +
          `- Hard deadline for this goal: ${g.deadlineAt}. A Clauder supervisor also checks on you whenever you go idle.`
        );
      }

      flags.push('--append-system-prompt', systemParts.join('\n\n'));

      if (this.config.maxBudgetUsd) {
        flags.push('--max-budget-usd', String(this.config.maxBudgetUsd));
      }

      if (this.config.maxTurns) {
        flags.push('--max-turns', String(this.config.maxTurns));
      }

      // Build stdin message
      const files = opts?.files;
      let stdinPayload: string;
      if (images?.length || files?.length) {
        // Save images to ~/.clauder/uploads/ and collect their paths
        const savedImagePaths: string[] = [];
        for (const img of (images ?? [])) {
          try {
            savedImagePaths.push(await saveUpload(img));
          } catch (err) {
            console.error('[session] Failed to save uploaded image:', err);
          }
        }

        // Build per-file content blocks. Text → inline text block; PDF → native document
        // block. 'binary' files (XLS, docx, zip, …) have no API content block, so save them
        // to disk and hand Claude the path to read with its own tools. Blank the persisted
        // base64 afterward so a large blob doesn't churn through sessions.json + backups.
        const fileBlocks: any[] = [];
        const savedFilePaths: string[] = [];
        for (const f of (files ?? [])) {
          if (f.kind === 'document') {
            fileBlocks.push({ type: 'document' as const, source: { type: 'base64' as const, media_type: f.mimeType, data: f.content } });
          } else if (f.kind === 'text') {
            fileBlocks.push({ type: 'text' as const, text: `=== ${f.name} ===\n${f.content}` });
          } else {
            try {
              savedFilePaths.push(await saveFileUpload(f.name, f.content));
            } catch (err) {
              console.error('[session] Failed to save uploaded file:', err);
            }
          }
        }
        // Drop persisted binary blobs now that they live on disk (source of truth).
        const stored = this.messages.find(m => m.id === userMsgId);
        if (stored?.files) {
          for (const f of stored.files) if (f.kind === 'binary') f.content = '';
        }

        const noteLines: string[] = [];
        if (savedImagePaths.length) noteLines.push(`Uploaded image${savedImagePaths.length > 1 ? 's' : ''} saved to disk: ${savedImagePaths.join(', ')}`);
        if (savedFilePaths.length) noteLines.push(`Uploaded file${savedFilePaths.length > 1 ? 's' : ''} saved to disk — read ${savedFilePaths.length > 1 ? 'them' : 'it'} with your tools (e.g. Bash): ${savedFilePaths.join(', ')}`);
        const pathNote = noteLines.length ? '\n\n[' + noteLines.join('\n') + ']' : '';

        const defaultPrompt = images?.length ? 'What is in this image?' : 'Examine the attached file(s).';
        const textContent = (message || defaultPrompt) + pathNote;

        const contentBlocks: any[] = [
          ...(images ?? []).map(img => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: img.mimeType, data: img.data },
          })),
          ...fileBlocks,
          { type: 'text' as const, text: textContent },
        ];
        stdinPayload = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: contentBlocks },
        });
      } else {
        stdinPayload = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: message },
        });
      }

      this.activeProcess = this.spawnClaudeProcess(flags, stdinPayload, true); // keep stdin open for AskUserQuestion

      let currentAssistantMsgId: string | null = null;
      // Stale-wait safety net (see STALE_WAIT_INTENT_RE below): track whether THIS turn used
      // any real scheduling mechanism, and what the last non-empty assistant text was.
      let usedSchedulingThisTurn = false;
      let lastAssistantText = '';

      for await (const msg of this.readNdjson(this.activeProcess)) {
        resetStallTimer(); // Got a message — reset stall detection

        // Capture session_id for resume. When forking, the CLI returns a new
        // session ID - grab it so subsequent messages use the fork, not the original.
        const anyMsg = msg as any;
        if (anyMsg.session_id) {
          if (!this.sdkSessionId || this.needsFork) {
            this.sdkSessionId = anyMsg.session_id;
            this.needsFork = false;
          }
        }

        switch ((msg as any).type) {
          case 'system': {
            const subtype = 'subtype' in (msg as any) ? (msg as any).subtype : null;
            if (subtype === 'init') {
              const sysMsg: UIMessage = {
                id: uuid(),
                role: 'system',
                content: `Session initialized (model: ${((msg as any).model ?? '').replace(/\[.*?\]$/, '')})`,
                timestamp: new Date().toISOString(),
              };
              this.messages.push(sysMsg);
            } else if (subtype === 'compact_boundary') {
              const meta = (msg as any).compact_metadata;
              const preTokens = meta?.pre_tokens;
              const postTokens = meta?.post_tokens;
              const trigger = meta?.trigger || 'auto';
              const sysMsg: UIMessage = {
                id: uuid(),
                role: 'system',
                content: `Context compacted (${trigger}) — was ${preTokens ? Math.round(preTokens / 1000) + 'k tokens' : 'unknown size'} before compaction`,
                timestamp: new Date().toISOString(),
              };
              this.messages.push(sysMsg);
              this.broadcast({
                type: 'assistant_message',
                sessionId: this.id,
                messageId: sysMsg.id,
                text: sysMsg.content,
              });
              // Update context usage with actual conversation token count from compact
              const contextWindow = this.contextUsage?.contextWindow || 200000;
              this.contextUsage = {
                inputTokens: postTokens || 0,
                outputTokens: 0,
                contextWindow,
              };
              this.broadcast({
                type: 'context_update',
                sessionId: this.id,
                contextUsage: this.contextUsage,
              });
              // The SDK injects a user message with the compacted summary right after this
              this.awaitingCompactSummary = true;
            }
            this.emitDebugLog('sdk_event', subtype || 'system', JSON.stringify(msg, null, 2));
            break;
          }

          case 'assistant': {
            this.lastActiveAt = new Date().toISOString();
            const assistantMsg = msg as any;
            const content = assistantMsg.message?.content;
            if (!content) break;

            // Reuse the streaming message ID if we have one, so the client
            // replaces the streaming message rather than adding a duplicate.
            // Fall back to the SDK's uuid, then generate one.
            const msgId: string = currentAssistantMsgId || (msg as any).uuid || uuid();

            // Extract text blocks
            const textBlocks = content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text);

            // Extract tool uses
            const toolUses: ToolUseInfo[] = content
              .filter((b: any) => b.type === 'tool_use')
              .map((b: any) => ({ id: b.id, name: b.name, input: b.input }));

            const text = textBlocks.join('');
            if (text) lastAssistantText = text;
            turnToolCount += toolUses.length;

            // Progress notes. Opus 5.5 and Sonnet 5.5 write their between-tool updates as thinking
            // blocks rather than text, so show any thinking block that carries text. Kept out of
            // `text` on purpose: the sentinel, CLAUDE.md-candidate, and error sniffs below must
            // only ever read what Claude actually said.
            const thinkingText = content
              .filter((b: any) => b.type === 'thinking' && typeof b.thinking === 'string')
              .map((b: any) => b.thinking.trim())
              .filter(Boolean)
              .join('\n\n');
            const thinking = thinkingText.length > MAX_THINKING_LENGTH
              ? thinkingText.slice(0, MAX_THINKING_LENGTH) + '…'
              : thinkingText;
            if (toolUses.some(tu => tu.name === 'add_watch')) usedSchedulingThisTurn = true;

            if (toolUses.length > 0) {
              const lastTool = toolUses[toolUses.length - 1];
              this.currentToolActivity = {
                toolName: lastTool.name,
                description: summarizeToolInput(lastTool.name, lastTool.input),
              };
              this.broadcast({
                type: 'tool_activity',
                sessionId: this.id,
                activity: this.currentToolActivity,
              });
              for (const tu of toolUses) {
                this.emitDebugLog('tool_start', tu.name, JSON.stringify(tu.input, null, 2), tu.id);
              }
            }

            const uiMsg: UIMessage = {
              id: msgId,
              role: 'assistant',
              content: text,
              thinking: thinking || undefined,
              toolUses: toolUses.length > 0 ? toolUses : undefined,
              timestamp: new Date().toISOString(),
            };

            // Update existing message in-place (from streaming or prior partial),
            // or append if this is the first time we see this ID.
            const existingIdx = this.messages.findIndex(m => m.id === msgId);
            if (existingIdx >= 0) {
              this.messages[existingIdx] = uiMsg;
            } else {
              this.messages.push(uiMsg);
            }

            if (text || toolUses.length > 0 || thinking) {
              this.broadcast({
                type: 'assistant_message',
                sessionId: this.id,
                messageId: msgId,
                text,
                thinking: thinking || undefined,
                toolUses: toolUses.length > 0 ? toolUses : undefined,
              });
            }

            // Detect auth failures emitted as assistant text — the CLI reports
            // "Failed to authenticate: OAuth session expired and could not be refreshed"
            // as a chat message, so the result/catch AUTH_ERROR_RE branches never fire and
            // the user gets no re-authenticate button. Anchored at message start AND
            // length-capped AND requiring an auth-error phrase, so ordinary conversation
            // that merely quotes an auth error can't trip it (the transcript-prose caveat
            // on the catch-block check).
            if (text && text.length < 300 && /^\s*Failed to authenticate\b/i.test(text) && AUTH_ERROR_RE.test(text)) {
              console.log(`[Session ${this.id}] Auth failure in assistant text — surfacing AUTH_EXPIRED after query`);
              this.pendingAuthExpired = true;
            }

            // Detect API errors emitted as assistant text (e.g. compaction failures
            // surface here instead of as a result error). If we see the 1M-credit
            // wall or related context errors, schedule auto-recovery to fire after
            // this query finishes — we can't recover mid-stream. Only messages the CLI wrote
            // itself count (it flags them is_api_error_message, model "<synthetic>"): matching
            // Claude's own replies let any answer that merely discussed these errors reset the
            // conversation and re-send the prompt, whose answer then did it again — a loop.
            const isCliErrorMessage = assistantMsg.is_api_error_message === true || assistantMsg.message?.model === '<synthetic>';
            if (text && isCliErrorMessage && CONTEXT_ERROR_RE.test(text)) {
              if (this.sdkSessionId && !this.pendingPostQueryRecover) {
                console.log(`[Session ${this.id}] Detected context-credit error in assistant text — scheduling auto-recovery`);
                this.pendingPostQueryRecover = true;
              }
            }

            // Auto-apply any [CLAUDE.md candidate: ...] rules the model flagged. The helper
            // dedupes, so re-seeing the same message (streaming finalization) is a safe no-op.
            if (text) {
              for (const candidate of extractClaudeMdCandidates(text)) {
                try {
                  if (applyClaudeMdCandidate(this.config.cwd, candidate)) {
                    this.broadcast({ type: 'claude_md_applied', sessionId: this.id, candidate });
                    console.log(`[Session ${this.id}] Auto-applied CLAUDE.md candidate: ${candidate.slice(0, 80)}`);
                  }
                } catch (err) {
                  console.error(`[Session ${this.id}] Failed to auto-apply CLAUDE.md candidate:`, err);
                }
              }

              // Detect <<schedule_trigger>>JSON<<>> sentinels emitted by Claude.
              // Creates a TriggerManager entry (visible in Scheduler modal) and emits a
              // confirmation system message. Strips the sentinel from the final chat text.
              // NOTE (applies to EVERY sentinel body regex in this file): bodies use
              // ((?:(?!<<)[\s\S])*?) — no "<<" allowed inside — so a PROSE MENTION of a
              // sentinel tag earlier in the message can't anchor a match that swallows the
              // real sentinel behind it into one unparseable blob (observed in prod: a real
              // schedule_trigger was lost this way). Trade-off: a sentinel payload can't
              // itself contain "<<", which no legitimate payload needs.
              if (this.onScheduleTrigger) {
                const SCHED_RE = /<<schedule_trigger>>((?:(?!<<)[\s\S])*?)<<>>/g;
                let m: RegExpExecArray | null;
                while ((m = SCHED_RE.exec(text)) !== null) {
                  try {
                    const parsed = JSON.parse(m[1].trim());
                    const at = String(parsed.at || '');
                    const msg = String(parsed.message || '');
                    const desc = String(parsed.description || msg).slice(0, 120);
                    if (!at || !msg) continue;
                    const atMs = new Date(at).getTime();
                    if (isNaN(atMs) || atMs <= Date.now()) {
                      console.warn(`[Session ${this.id}] schedule_trigger has invalid/past 'at': ${at}`);
                      continue;
                    }
                    this.onScheduleTrigger({ sessionId: this.id, message: msg, description: desc, at: new Date(at).toISOString() });
                    usedSchedulingThisTurn = true;
                    const friendly = new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                    const sysMsg: UIMessage = {
                      id: uuid(), role: 'system', content: `📅 Scheduled: "${desc}" at ${friendly}`,
                      timestamp: new Date().toISOString(),
                    };
                    this.messages.push(sysMsg);
                    this.broadcast({ type: 'assistant_message', sessionId: this.id, messageId: sysMsg.id, text: sysMsg.content });
                    console.log(`[Session ${this.id}] schedule_trigger created: "${desc}" at ${at}`);
                  } catch (err) {
                    console.error(`[Session ${this.id}] Failed to parse schedule_trigger sentinel:`, err);
                  }
                }
              }

              // Detect <<goal>>JSON<<>> — turn Goal Mode on or adjust it (Claude self-declaring).
              {
                const GOAL_RE = /<<goal>>((?:(?!<<)[\s\S])*?)<<>>/g;
                let gm: RegExpExecArray | null;
                while ((gm = GOAL_RE.exec(text)) !== null) {
                  try {
                    const parsed = JSON.parse(gm[1].trim());
                    if (parsed && typeof parsed.text === 'string' && parsed.text.trim()) {
                      this.setGoal({
                        text: parsed.text,
                        checkEveryMin: typeof parsed.checkEveryMin === 'number' ? parsed.checkEveryMin : undefined,
                        deadlineHours: typeof parsed.deadlineHours === 'number' ? parsed.deadlineHours : undefined,
                        maxNudges: typeof parsed.maxNudges === 'number' ? parsed.maxNudges : undefined,
                      });
                    }
                  } catch (err) {
                    console.error(`[Session ${this.id}] Failed to parse goal sentinel:`, err);
                  }
                }
              }

              // Detect <<goal_complete>>JSON<<>> — Claude declaring the goal done; turn Goal Mode off.
              if (this.config.goal) {
                const done = /<<goal_complete>>((?:(?!<<)[\s\S])*?)<<>>/.exec(text);
                if (done) {
                  let summary = '';
                  try { summary = String(JSON.parse(done[1].trim())?.summary || ''); } catch { /* summary optional */ }
                  this.completeGoal(summary, 'complete');
                }
              }

              // Detect <<model>>JSON<<>> — one-shot: switch this session's model/effort for
              // subsequent turns (model is a startup flag, so it takes effect next turn).
              {
                const mm = /<<model>>((?:(?!<<)[\s\S])*?)<<>>/.exec(text);
                if (mm) {
                  try {
                    const p = JSON.parse(mm[1].trim());
                    if (typeof p.model === 'string' && /^claude-/.test(p.model)) this.setModel(p.model.trim());
                    if (typeof p.effort === 'string') this.setEffort(p.effort);
                  } catch (err) {
                    console.error(`[Session ${this.id}] Failed to parse model sentinel:`, err);
                  }
                }
              }

              // Detect <<model_plan>>JSON<<>> — start an auto-driven multi-step plan where
              // Clauder switches models between steps. Global + "last match that actually
              // parses" — not just the first match — because a single non-global .exec() with
              // a non-greedy body is a trap: if the assistant ever mentions the literal string
              // "<<model_plan>>" in ordinary prose BEFORE the real sentinel (e.g. explaining the
              // feature to the user), the regex anchors on that first mention and scans non-
              // greedily all the way to the NEXT "<<>>" — which may only be the real sentinel's
              // closing tag — swallowing all the intervening prose into one invalid JSON blob.
              // Trying every match and keeping the last one that parses sidesteps this exactly
              // the way the <<goal>>/<<notes>> sentinels already do.
              {
                const MP_RE = /<<model_plan>>((?:(?!<<)[\s\S])*?)<<>>/g;
                let mp: RegExpExecArray | null;
                let parsed: any = null;
                while ((mp = MP_RE.exec(text)) !== null) {
                  try {
                    const p = JSON.parse(mp[1].trim());
                    if (Array.isArray(p.steps)) parsed = p;
                  } catch {
                    // not this one — keep scanning; a later match (or an earlier prose mention) may still be valid
                  }
                }
                if (parsed) {
                  this.setModelPlan(parsed.steps);
                } else if (/<<model_plan>>/.test(text)) {
                  console.error(`[Session ${this.id}] Saw a model_plan sentinel but no occurrence parsed as valid JSON`);
                }
              }

              // Detect <<notes>>JSON<<>> — Claude maintaining the user-facing Notes tab.
              // Replaces the whole note body (not an append) so Claude just re-emits the
              // full current text each time it updates. Last match wins if it appears twice.
              {
                const NOTES_RE = /<<notes>>((?:(?!<<)[\s\S])*?)<<>>/g;
                let last: RegExpExecArray | null = null;
                let nm: RegExpExecArray | null;
                while ((nm = NOTES_RE.exec(text)) !== null) last = nm;
                if (last) {
                  try {
                    const parsed = JSON.parse(last[1].trim());
                    if (typeof parsed.content === 'string') {
                      this.setNotes(parsed.content);
                    }
                  } catch (err) {
                    console.error(`[Session ${this.id}] Failed to parse notes sentinel:`, err);
                  }
                }
              }

              // Detect <<show_image>>JSON<<>> — Claude displaying an on-disk image inline in the
              // chat. One per image; each renders a labeled thumbnail. Read is async + fire-and-
              // forget so it doesn't block stream processing (the image message appends shortly).
              {
                const IMG_RE = /<<show_image>>((?:(?!<<)[\s\S])*?)<<>>/g;
                let im: RegExpExecArray | null;
                while ((im = IMG_RE.exec(text)) !== null) {
                  try {
                    const parsed = JSON.parse(im[1].trim());
                    if (typeof parsed.path === 'string') {
                      this.showImageFromSentinel(parsed.path, String(parsed.caption ?? '')).catch(() => { /* handled inside */ });
                    }
                  } catch (err) {
                    console.error(`[Session ${this.id}] Failed to parse show_image sentinel:`, err);
                  }
                }
              }

              // Detect <<monitor>>JSON<<>> — start a Clauder-native event monitor (the headless-
              // safe replacement for the CLI's `Monitor` tool). Each occurrence starts one.
              {
                const MON_RE = /<<monitor>>((?:(?!<<)[\s\S])*?)<<>>/g;
                let mo: RegExpExecArray | null;
                while ((mo = MON_RE.exec(text)) !== null) {
                  try {
                    const spec = JSON.parse(mo[1].trim());
                    if (spec && typeof spec.command === 'string') {
                      const { id, error } = this.monitors.start(spec);
                      if (error) this.emitSystemMessage(`⚠️ ${error}`);
                      else {
                        usedSchedulingThisTurn = true;
                        this.emitSystemMessage(`👁 Monitoring: ${String(spec.description || spec.command).slice(0, 100)} (id ${id}).`);
                      }
                    }
                  } catch (err) {
                    console.error(`[Session ${this.id}] Failed to parse monitor sentinel:`, err);
                  }
                }
              }

              // Detect <<monitor_stop>>JSON<<>> — stop a monitor by id, or all if id omitted.
              {
                const STOP_RE = /<<monitor_stop>>((?:(?!<<)[\s\S])*?)<<>>/g;
                let sm: RegExpExecArray | null;
                while ((sm = STOP_RE.exec(text)) !== null) {
                  try {
                    const parsed = JSON.parse(sm[1].trim());
                    if (parsed && typeof parsed.id === 'string') {
                      this.monitors.stop(parsed.id, false);
                      this.emitSystemMessage(`⏹ Monitor ${parsed.id} stopped.`);
                    } else {
                      for (const m of this.monitors.list()) this.monitors.stop(m.id, false);
                      this.emitSystemMessage('⏹ All monitors stopped.');
                    }
                  } catch (err) {
                    console.error(`[Session ${this.id}] Failed to parse monitor_stop sentinel:`, err);
                  }
                }
              }
            }

            // Detect ScheduleWakeup tool uses — set up a server-side timer to auto-resume
            for (const tu of toolUses) {
              if (tu.name === 'ScheduleWakeup') {
                this.scheduleWakeup(tu.input, tu.id);
                usedSchedulingThisTurn = true;
              }
            }

            // Detect ExitPlanMode tool uses — surface plan to user for explicit accept/reject
            const sawExitPlanMode = toolUses.some(tu => tu.name === 'ExitPlanMode');
            for (const tu of toolUses) {
              if (tu.name === 'ExitPlanMode') {
                const plan = String((tu.input as any)?.plan ?? '').trim();
                if (plan) {
                  // Custom Plan: stash the full plan text (prose + clauder-steps block) so the
                  // accept handler can parse per-step models out of it and start a model plan.
                  // Also record it on pendingPlan so it rides the snapshot and survives reconnects.
                  this.lastPlanText = plan;
                  this.pendingPlan = { toolUseId: tu.id, plan, messageId: msgId };
                  this.broadcast({
                    type: 'pending_plan',
                    sessionId: this.id,
                    toolUseId: tu.id,
                    plan,
                    messageId: msgId,
                  });
                  console.log(`[Session ${this.id}] ExitPlanMode detected (${plan.length} chars)`);
                }
              }
            }

            // Custom Plan — HEADLESS FALLBACK. ExitPlanMode is NOT available in headless
            // (--print) mode, the mode Clauder always runs the CLI in — the model tries to
            // call it, finds it missing, and instead narrates the plan as ordinary assistant
            // text (containing the machine-readable ```clauder-steps block). Without this,
            // the plan never surfaces: no ExitPlanMode tool use → no pending_plan → no
            // PlanBanner, and the block sits inert in a chat bubble. So on a plan turn, when
            // no ExitPlanMode call was made but the text carries a clauder-steps block, treat
            // the whole assistant message as the plan and surface it the same way. (Mirrors
            // the AskUserQuestion headless limitation already noted in CLAUDE.md.) The
            // synthetic toolUseId is fine: the client keys pending plans by sessionId, and the
            // accept handler reads lastPlanText — neither needs a real tool_use id.
            if (opts?.planMode && !sawExitPlanMode && text && /```clauder-steps[\s\S]*?```/.test(text)) {
              const plan = text.trim();
              const toolUseId = `plan-${msgId}`;
              this.lastPlanText = plan;
              this.pendingPlan = { toolUseId, plan, messageId: msgId };
              this.broadcast({
                type: 'pending_plan',
                sessionId: this.id,
                toolUseId,
                plan,
                messageId: msgId,
              });
              console.log(`[Session ${this.id}] Plan surfaced from message text (headless fallback, ${plan.length} chars)`);
            }

            // Detect AskUserQuestion tool uses — broadcast interactive question to client
            for (const tu of toolUses) {
              if (tu.name === 'AskUserQuestion') {
                const questions = (tu.input as any)?.questions;
                if (Array.isArray(questions) && questions.length > 0) {
                  const q = questions[0]; // Show first question
                  this.broadcast({
                    type: 'pending_question',
                    sessionId: this.id,
                    toolUseId: tu.id,
                    question: {
                      question: q.question || '',
                      header: q.header,
                      options: q.options,
                    },
                  });
                  this.armQuestionTimeout(tu.id);
                  console.log(`[Session ${this.id}] AskUserQuestion detected: ${q.question?.slice(0, 80)}`);
                }
              }
            }

            // Reset for next turn so a new assistant message gets a fresh ID
            // rather than replacing this one.
            currentAssistantMsgId = null;
            break;
          }

          case 'stream_event': {
            const streamMsg = msg as any;
            const event = streamMsg.event;
            if (event?.type === 'content_block_delta' && event?.delta?.type === 'text_delta') {
              const delta = event.delta.text;
              if (!currentAssistantMsgId) {
                currentAssistantMsgId = uuid();
              }
              this.broadcast({
                type: 'assistant_message_stream',
                sessionId: this.id,
                messageId: currentAssistantMsgId,
                delta,
              });
            }
            break;
          }

          case 'user': {
            // After compaction, the SDK injects a user message with the compacted summary.
            // Capture it so we can use it to prime fresh sessions after a reset.
            if (this.awaitingCompactSummary) {
              this.awaitingCompactSummary = false;
              const content = (msg as any).message?.content;
              const summaryText = typeof content === 'string' ? content : '';
              if (summaryText && summaryText.includes('continued from a previous conversation')) {
                this.compactedContext = summaryText;
                console.log(`[Session ${this.id}] Captured compacted context (${summaryText.length} chars)`);
              }
            }
            // Capture tool results from user messages (tool_result content blocks)
            const userContent = (msg as any).message?.content;
            if (userContent && Array.isArray(userContent)) {
              for (const block of userContent) {
                if (block.type === 'tool_result') {
                  const toolUseId = block.tool_use_id;
                  let resultText = '';
                  if (typeof block.content === 'string') {
                    resultText = block.content;
                  } else if (Array.isArray(block.content)) {
                    resultText = block.content
                      .filter((c: any) => c.type === 'text')
                      .map((c: any) => c.text)
                      .join('\n');
                  }

                  const truncated = resultText.slice(0, MAX_TOOL_RESULT_LENGTH);
                  const result: ToolResultInfo = {
                    content: truncated,
                    isError: !!block.is_error,
                    originalLength: resultText.length > MAX_TOOL_RESULT_LENGTH ? resultText.length : undefined,
                  };

                  this.attachToolResult(toolUseId, result);
                  this.broadcast({ type: 'tool_result', sessionId: this.id, toolUseId, result });
                  this.emitDebugLog('tool_result', this.findToolName(toolUseId) || 'tool_result', truncated, toolUseId);
                }
              }
            }
            break;
          }

          case 'rate_limit_event': {
            const rle = msg as any;
            this.emitDebugLog('sdk_event', 'rate_limit', JSON.stringify(rle, null, 2));
            // Parsing lives in rate-limits.ts (parseRateLimitEvent) so it's unit-testable
            // against captured real events. See its doc comment for the confirmed live
            // shape — the percentages are under `unifiedWindows`, not top-level.
            try {
              const parsed = parseRateLimitEvent(rle.rate_limit_info);
              if (parsed.session || parsed.weekly || parsed.weeklyOverage) {
                recordSubscriptionLimits(parsed);
              }
            } catch (err) {
              console.error(`[Session ${this.id}] Failed to parse rate_limit_event:`, err);
            }
            break;
          }

          case 'result': {
            const resultMsg = msg as any;
            // resultMsg.total_cost_usd is cumulative WITHIN the current underlying SDK
            // conversation only — add the baseline captured when that conversation began
            // (0 for a normal, never-reset session) rather than assigning it directly, or a
            // post-reset turn's small conversation-local cost overwrites and discards
            // everything accumulated before the reset. See costBaseline's field doc.
            const rawTotal = typeof resultMsg.total_cost_usd === 'number'
              ? this.costBaseline + resultMsg.total_cost_usd
              : this.totalCostUsd;
            // Defense in depth beyond costBaseline: never let totalCostUsd decrease. Covers
            // cases the baseline doesn't (a server restart landing between a reset and its
            // next turn, or --fork-session, whose cost semantics aren't verified) — at worst
            // under-counting one turn's delta rather than visibly dropping the running total.
            const newTotal = Math.max(this.totalCostUsd, rawTotal);
            const costDelta = newTotal - this.totalCostUsd;
            this.totalCostUsd = newTotal;
            if (costDelta > 0) recordCostDelta(costDelta);
            this.lastActiveAt = new Date().toISOString();
            const success = resultMsg.subtype === 'success';
            turnStopReason = String(resultMsg.subtype || '');
            {
              const u = resultMsg.usage ?? {};
              turnUsage = {
                input: u.input_tokens ?? 0,
                cacheRead: u.cache_read_input_tokens ?? 0,
                cacheWrite: u.cache_creation_input_tokens ?? 0,
                output: u.output_tokens ?? 0,
                thinking: u.output_tokens_details?.thinking_tokens ?? 0,
              };
            }
            if (!success) {
              const errorText = resultMsg.result
                || (Array.isArray(resultMsg.errors) ? resultMsg.errors.join('; ') : '')
                || 'Unknown error';
              // Custom Plan: Fable unavailable, out of credits, or rate-limited on a plan turn →
              // retry on Opus (deferred to after this query finishes, mirroring
              // pendingPostQueryRecover). Don't set error, and don't fall into the
              // isRateLimited() sleep branch below — try Opus first.
              if (opts?.planMode && !this.planFallbackToOpus && this.planShouldFallbackToOpus(errorText)) {
                console.log(`[Session ${this.id}] Plan model (Fable) unavailable/exhausted — will retry on Opus`);
                this.pendingPlanFallbackRetry = true;
              } else if (CONTEXT_ERROR_RE.test(errorText) && this.sdkSessionId) {
                // Auto-recover on 413 request too large: reset SDK session and
                // re-send the last user message (it will be primed with compacted context)
                console.log(`[Session ${this.id}] Request too large (from result) — auto-recovering`);
                this.autoRecoverFrom413();
                // Don't set error — we're auto-recovering
              } else if (/No conversation found/.test(errorText) && this.sdkSessionId) {
                // Stale SDK session ID (e.g. from v1 migration) — clear it so next message starts fresh
                console.log(`[Session ${this.id}] SDK session not found — clearing stale ID ${this.sdkSessionId}`);
                this.costBaseline = this.totalCostUsd; // fresh conversation next spawn — see field doc
                this.sdkSessionId = null;
                this.needsFork = false;
                this.error = 'Session data not found (likely from migration). Send another message to start fresh.';
              } else if (AUTH_ERROR_RE.test(errorText)) {
                console.log(`[Session ${this.id}] Auth error — login expired: ${errorText.slice(0, 120)}`);
                this.error = 'AUTH_EXPIRED';
              } else if (this.isRateLimited(errorText)) {
                // Out of usage — sleep until the window resets and continue automatically.
                // Not set as an error: the session isn't broken, it's waiting.
                this.sleepUntilRateLimitReset();
              } else {
                this.error = errorText;
              }
            }

            // Extract context usage from modelUsage
            // NOTE: modelUsage aggregates across ALL API calls in a multi-turn query,
            // so cache tokens are cumulative and can't represent a single context snapshot.
            // We extract contextWindow here, but rely on compact_boundary events for
            // accurate conversation token counts.
            if (resultMsg.modelUsage) {
              const usages = Object.values(resultMsg.modelUsage) as any[];
              if (usages.length > 0) {
                let totalInput = 0;
                let totalOutput = 0;
                let contextWindow = 0;
                for (const u of usages) {
                  totalInput += (u.inputTokens || 0) + (u.cacheCreationInputTokens || 0) + (u.cacheReadInputTokens || 0);
                  totalOutput += u.outputTokens || 0;
                  contextWindow = Math.max(contextWindow, u.contextWindow || 0);
                }
                // Use conversationTokens from compact_boundary if available,
                // otherwise don't update (keep previous value)
                if (this.contextUsage) {
                  this.contextUsage.contextWindow = contextWindow;
                  this.contextUsage.outputTokens = totalOutput;
                } else {
                  // First query — no compact_boundary yet, so no reliable conversation size
                  this.contextUsage = { inputTokens: 0, outputTokens: totalOutput, contextWindow };
                }
                this.broadcast({
                  type: 'context_update',
                  sessionId: this.id,
                  contextUsage: this.contextUsage,
                });
              }
            }

            this.broadcast({
              type: 'result',
              sessionId: this.id,
              costUsd: this.totalCostUsd,
              success,
              error: !success ? this.error || undefined : undefined,
            });

            // Close stdin so the process exits (we kept it open for AskUserQuestion support)
            try { this.activeProcess?.stdin?.end(); } catch {}
            break;
          }

          default: {
            // Log unrecognised stream event types at startup so new CLI events (e.g. waitingFor
            // from v2.1.162+) are discoverable. Only log the type + top-level keys, not the full
            // payload, to keep the log readable.
            const anyMsg = msg as any;
            const type = anyMsg?.type;
            if (type && !['ignored', 'text'].includes(type)) {
              const keys = Object.keys(anyMsg).filter(k => k !== 'type').join(', ');
              console.log(`[Session ${this.id}] Unknown stream event type="${type}" keys=[${keys}]`);
            }
            break;
          }
        }
      }

      // Query completed
      this.retryCount = 0;
      this.consecutiveStalls = 0;
      this.status = 'idle';
      this.waitingFor = null;
      this.currentToolActivity = null;
      this.broadcast({ type: 'state_change', sessionId: this.id, status: 'idle', waitingFor: null });
      // The per-turn operational record: who, on what model, how long, what it cost.
      // The per-turn operational record, now with the token breakdown and the real quota
      // delta — this is what makes the switch-vs-stay and effort-vs-model economics
      // measurable per model/effort instead of estimated (cacheW at 2× input price is the
      // cold-start "switch tax"; think/out are what effort controls).
      const turnCost = this.totalCostUsd - costBefore;
      const quotaAfter = getRateLimitInfo().session?.usedPercent ?? null;
      const quotaStr = quotaBefore != null && quotaAfter != null ? ` quota5h=${quotaBefore}→${quotaAfter}%` : '';
      const usageStr = turnUsage
        ? ` in=${turnUsage.input} cacheR=${turnUsage.cacheRead} cacheW=${turnUsage.cacheWrite} out=${turnUsage.output} think=${turnUsage.thinking}`
        : '';
      console.log(
        `[Session ${this.id}] Turn done [${this.config.name}] model=${effectiveModel} effort=${effectiveEffort || '(default)'} ` +
        `${((Date.now() - turnStartMs) / 1000).toFixed(1)}s cost=$${turnCost.toFixed(2)} ` +
        `tools=${turnToolCount} stop=${turnStopReason || 'unknown'}${usageStr}${quotaStr}`
      );
      // Feed the cost ledger (the /cost popover's by-model 24h/7d rollup). Only real turns
      // with a usage payload — skip no-op/errored turns that never reached the result event.
      if (turnUsage && effectiveModel && effectiveModel !== '(default)') {
        recordTurnCost({
          ts: new Date().toISOString(),
          sessionId: this.id,
          model: effectiveModel,
          effort: effectiveEffort || '(default)',
          costUsd: turnCost,
          tokens: {
            input: turnUsage.input, cacheRead: turnUsage.cacheRead,
            cacheWrite: turnUsage.cacheWrite, output: turnUsage.output, thinking: turnUsage.thinking,
          },
        });
      }

      // If the assistant text included a context-credit error, fire auto-recovery now
      // that the query is done (we couldn't do it mid-stream).
      if (this.pendingPostQueryRecover && this.sdkSessionId) {
        this.pendingPostQueryRecover = false;
        console.log(`[Session ${this.id}] Firing deferred auto-recovery after context-credit error`);
        this.autoRecoverFrom413();
      } else {
        this.pendingPostQueryRecover = false;
      }

      // Custom Plan: Fable-unavailable on a plan turn — retry on Opus now the query is done.
      if (this.pendingPlanFallbackRetry) {
        this.pendingPlanFallbackRetry = false;
        this.firePlanFallbackRetry();
      }

      // Deferred auth-expired surfacing (see the assistant-text sniff): flip the session
      // into the AUTH_EXPIRED state now that the query is done, so the client shows the
      // re-authenticate banner instead of leaving the failure as ordinary chat text.
      // Done AFTER the idle broadcast above — a state_change without an error field
      // clears the client-side error, which would swallow this if set mid-stream.
      if (this.pendingAuthExpired) {
        this.pendingAuthExpired = false;
        console.log(`[Session ${this.id}] Auth error (from assistant text) — login expired`);
        this.status = 'error';
        this.error = 'AUTH_EXPIRED';
        this.broadcast({ type: 'state_change', sessionId: this.id, status: 'error', error: this.error });
      }

      // Stale-wait safety net: the turn ended saying it will wait/check back on something
      // (STALE_WAIT_INTENT_RE), but never called ScheduleWakeup, a <<schedule_trigger>>/
      // <<monitor>> sentinel, or add_watch — so nothing was actually going to bring it back.
      // Left alone this is a silent dead end: status goes idle and stays idle forever until a
      // human notices and re-prompts. Model plans and Goal Mode already have their own
      // self-driving follow-up (ModelPlanRunner advances on idle; GoalSupervisor nudges on its
      // own cadence) so skip there — this is only for turns with no other safety net.
      if (
        !usedSchedulingThisTurn
        && !this.pendingWakeup
        && this.config.modelPlan?.status !== 'running'
        && this.config.goal?.status !== 'active'
        && lastAssistantText
        && STALE_WAIT_INTENT_RE.test(lastAssistantText)
        && !HUMAN_WAIT_RE.test(lastAssistantText)
      ) {
        this.armStaleWaitNudge(lastAssistantText);
      }
    } catch (err: any) {
      const errMsg = err.message || 'Unknown error';
      console.log(`[Session ${this.id}] Query error: ${errMsg}`);

      // The CLI emits a context error as an assistant message before exiting, and the
      // assistant-text sniff arms pendingPostQueryRecover when it sees one. Consume the flag
      // here, since the completion path that normally does never runs when the process dies.
      // (This used to re-scan the last chat message, where a user's or Claude's own mention of
      // the error, or any "413" at all, was enough to reset the conversation.)
      const sawContextErrorMessage = this.pendingPostQueryRecover;
      this.pendingPostQueryRecover = false;

      // Check for auth errors in the thrown error + recent stderr/api-error debug entries.
      // (Not the chat transcript — conversation prose could incidentally contain auth-ish
      // words; the real signal is always in the process error or diagnostic output.)
      // pendingAuthExpired also counts: the assistant-text sniff armed it during THIS query
      // (its narrow anchored check is the one safe transcript signal), and if the process
      // then died the completion path that would consume it never runs.
      const lastDebugEntries = this.debugLog.slice(-5).map(e => e.content).join(' ');
      const hasAuthError = this.pendingAuthExpired || AUTH_ERROR_RE.test(lastDebugEntries) || AUTH_ERROR_RE.test(errMsg);
      this.pendingAuthExpired = false;
      if (hasAuthError) {
        console.log(`[Session ${this.id}] Auth error — login expired`);
        this.status = 'error';
        this.error = 'AUTH_EXPIRED';
        this.currentToolActivity = null;
        this.broadcast({ type: 'state_change', sessionId: this.id, status: 'error', error: this.error });
        return;
      }

      if ((sawContextErrorMessage || CONTEXT_ERROR_RE.test(errMsg)) && this.sdkSessionId) {
        console.log(`[Session ${this.id}] Request too large (from crash) — auto-recovering`);
        this.autoRecoverFrom413();
        return;
      }

      // Custom Plan: Fable unavailable, out of credits, or rate-limited on a plan turn
      // (surfaced as a process crash / stderr) → retry on Opus. Check both the thrown error
      // and recent stderr/api-error debug entries.
      if (opts?.planMode && !this.planFallbackToOpus && (this.planShouldFallbackToOpus(errMsg) || this.planShouldFallbackToOpus(lastDebugEntries))) {
        console.log(`[Session ${this.id}] Plan model (Fable) unavailable/exhausted (from crash) — retrying on Opus`);
        this.firePlanFallbackRetry();
        return;
      }
      this.emitDebugLog('api_error', 'error', errMsg);

      // Detect fatal session errors: stalls (dangling tool_use in session file)
      // and SIGKILL (SDK process killed, often from OOM or corrupted session).
      // Recovery strategy when resuming an SDK session:
      // - 1st failure: fork the session (new branch may escape the stuck state)
      // - 2nd+ failure: abandon the SDK session entirely (start fresh)
      // When no SDK session (fresh query), SIGKILL usually means OOM.
      const isProcessKilled = /SIGKILL|SIGABRT|SIGSEGV/.test(errMsg);
      const isFatalSessionError = stallAborted || isProcessKilled;

      // 413 request_too_large: SDK session file is too bloated to resume.
      // Auto-reset the SDK session so the next message starts fresh.
      const isRequestTooLarge = CONTEXT_ERROR_RE.test(errMsg);
      if (isRequestTooLarge && this.sdkSessionId) {
        console.log(`[Session ${this.id}] Request too large — abandoning SDK session ${this.sdkSessionId} to start fresh`);
        this.reset();
        this.status = 'error';
        const is1mCredits = /Usage credits required for 1M context/i.test(errMsg);
        this.error = is1mCredits
          ? 'Compaction hit the 1M-context credit wall. Session auto-reset — your next message will start a fresh CLI conversation with prior context summarized. (Or enable usage credits at claude.ai/settings/usage to allow compaction.)'
          : 'Session too large for API. It has been auto-reset — your next message will start a fresh conversation.';
        this.currentToolActivity = null;
        this.broadcast({
          type: 'state_change',
          sessionId: this.id,
          status: 'error',
          error: this.error,
        });
        return;
      }

      // Out of usage (process died on a rate-limit rejection): sleep until the window
      // resets and continue automatically instead of stranding the session in error.
      if (this.isRateLimited(errMsg)) {
        this.status = 'idle';
        this.error = null;
        this.currentToolActivity = null;
        this.sleepUntilRateLimitReset();
        this.broadcast({ type: 'state_change', sessionId: this.id, status: 'idle', waitingFor: null });
        return;
      }

      // Clean exits (exit code 1 = API error, spending cap, etc.) should NOT
      // escalate the fatal error counter. Only signal-based kills should.
      if (!isFatalSessionError) {
        this.consecutiveStalls = 0;
      }

      if (isFatalSessionError && this.sdkSessionId) {
        this.consecutiveStalls++;
        if (this.consecutiveStalls >= 2) {
          console.log(`[Session ${this.id}] ${this.consecutiveStalls} consecutive fatal errors — abandoning SDK session ${this.sdkSessionId} to break failure loop`);
          this.costBaseline = this.totalCostUsd; // fresh conversation next spawn — see field doc
          this.sdkSessionId = null;
          this.needsFork = false;
        } else {
          console.log(`[Session ${this.id}] Fatal error on resume — will fork session on next message to escape stuck state`);
          this.needsFork = true;
        }
      }

      const isTransient = /500|502|503|529|internal server error|overloaded/i.test(errMsg);

      if (isTransient && this.retryCount < 3) {
        this.retryCount++;
        const delay = Math.min(1000 * Math.pow(2, this.retryCount - 1), 8000);
        console.log(`[Session ${this.id}] Transient API error, retry ${this.retryCount}/3 in ${delay}ms: ${errMsg}`);
        this.currentToolActivity = { toolName: 'Retry', description: `Attempt ${this.retryCount}/3 in ${Math.round(delay / 1000)}s...` };
        this.broadcast({ type: 'tool_activity', sessionId: this.id, activity: this.currentToolActivity });
        this.activeProcess = null;
        if (stallTimer) clearTimeout(stallTimer);
        await new Promise(resolve => setTimeout(resolve, delay));
        // Re-send the same message (it was already pushed to this.messages)
        const lastUserMsg = [...this.messages].reverse().find(m => m.role === 'user');
        if (lastUserMsg) {
          // Remove the user message so sendMessage re-adds it
          this.messages = this.messages.filter(m => m.id !== lastUserMsg.id);
          this.status = 'idle';
          return this.sendMessage(lastUserMsg.content, lastUserMsg.images);
        }
      }

      this.retryCount = 0;
      this.status = 'error';
      // Craft a helpful error message based on the failure mode
      if (isProcessKilled && !this.sdkSessionId) {
        // Fresh query got killed — almost certainly OOM
        this.error = 'Process killed (likely out of memory). Close other apps to free RAM and try again.';
      } else if (isFatalSessionError && this.consecutiveStalls >= 2) {
        this.error = 'Repeated fatal errors. SDK session abandoned — next message starts fresh (conversation history lost).';
      } else if (isFatalSessionError) {
        this.error = `Fatal error (${stallAborted ? 'stall' : 'process killed'}). Session will fork on next message to recover.`;
      } else {
        this.error = errMsg;
      }
      this.currentToolActivity = null;
      this.broadcast({
        type: 'state_change',
        sessionId: this.id,
        status: 'error',
        error: this.error || undefined,
      });
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      // Close stdin if still open (from keepStdinOpen for AskUserQuestion support)
      try { this.activeProcess?.stdin?.end(); } catch {}
      this.activeProcess = null;
      // Bound in-memory history once per turn (cheap: runs here, not on every push).
      // Pinned messages are exempt — see trimMessages.
      this.messages = trimMessages(this.messages, MAX_MESSAGES_IN_MEMORY);
    }

    // NOTE: We don't auto-compact from Clauder's side. The SDK handles compaction
    // internally based on actual conversation token counts. Our modelUsage numbers
    // include system prompt + tool definitions which inflate the percentage.

    // Drain the queue: if there are queued messages, send the next one.
    // EXCEPT while a rate-limit sleep is armed — draining then would fire messages straight
    // into the closed window, fail each one, and re-arm repeatedly. The queue drains after
    // the auto-resume turn instead. (Claude-scheduled wakeups don't hold the queue: fresh
    // user input cancels those by design.)
    const sleepingOnRateLimit = this.pendingWakeup?.toolUseId === ManagedSession.RATE_LIMIT_WAKEUP_ID;
    if (this.queuedMessages.length > 0 && this.status === 'idle' && !sleepingOnRateLimit) {
      const next = this.queuedMessages.shift()!;
      this.broadcast({
        type: 'queue_update',
        sessionId: this.id,
        queue: [...this.queuedMessages],
      });
      // Fire and forget - the recursive call handles its own lifecycle.
      // Preserve the internal flag so programmatic messages (triggers/wakeups)
      // that were queued while busy still skip task-switch classification.
      this.sendMessage(next.text, next.images, { internal: next.internal, files: next.files, model: next.model, effort: next.effort as EffortLevel | undefined }).catch(err => {
        console.error(`Error processing queued message for session ${this.id}:`, err);
      });
    }
  }

  reset(): void {
    this.costBaseline = this.totalCostUsd; // fresh conversation next spawn — see field doc
    this.sdkSessionId = null;
    this.needsFork = false;
    this.wasReset = true;
    this.status = 'idle';
    this.error = null;
    this.contextUsage = null;
    this.broadcast({ type: 'state_change', sessionId: this.id, status: 'idle' });
  }

  /**
   * Wipe conversation state without preserving the session for resume.
   * Unlike reset(), this clears messages and does NOT prime the next message with context.
   * Used by the scratch session's Clear button.
   */
  clearMessages(): void {
    // Kill any in-flight CLI process so it doesn't try to broadcast against cleared state
    if (this.activeProcess) {
      try { this.activeProcess.kill('SIGTERM'); } catch { /* ignore */ }
      this.activeProcess = null;
    }
    this.messages = [];
    this.queuedMessages = [];
    this.costBaseline = this.totalCostUsd; // fresh conversation next spawn — see field doc
    this.sdkSessionId = null;
    this.needsFork = false;
    this.wasReset = false;
    this.summary = null;
    this.summaryGeneratedAt = null;
    this.compactedContext = null;
    this.contextUsage = null;
    this.status = 'idle';
    this.error = null;
    this.currentToolActivity = null;
    this.pendingPermission = null;
    this.clearQuestionTimer();
    this.pendingQuestion = null;
    this.debugLog = [];
    // Re-broadcast full session state so the client replaces local state wholesale
    this.broadcast({ type: 'session_created', session: toClientState(this.getState()) });
  }

  /** One-time fallback when Fable isn't available/affordable for a plan turn (unavailable on
   *  this subscription, out of Fable-specific credits, or rate-limited — see
   *  planShouldFallbackToOpus): switch to Opus and re-send the plan request. Mirrors the
   *  transient-retry resend idiom (remove the just-pushed user message from history so the
   *  re-send doesn't duplicate it). The planFallbackToOpus flag guarantees this happens at
   *  most once per session — no retry loop; a second failure falls through to normal
   *  (non-plan) error handling, including the usual rate-limit sleep-and-resume. */
  private firePlanFallbackRetry(): void {
    this.planFallbackToOpus = true;
    this.emitSystemMessage('Fable unavailable or out of credits — planning with Opus instead.');
    const lastUserMsg = [...this.messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return;
    this.messages = this.messages.filter(m => m.id !== lastUserMsg.id);
    this.status = 'idle';
    this.sendMessage(lastUserMsg.content, lastUserMsg.images, { planMode: true }).catch(err => {
      console.error(`[Session ${this.id}] Plan fallback retry failed: ${err.message}`);
    });
  }

  private autoRecoverFrom413(): void {
    const oldSdkId = this.sdkSessionId;
    this.reset();

    // Find the last user message to re-send
    const lastUserMsg = [...this.messages].reverse().find(m => m.role === 'user');
    const lastUserText = lastUserMsg?.content && typeof lastUserMsg.content === 'string'
      ? lastUserMsg.content.trim()
      : '';

    // If the failing command was /compact, don't re-send it — the fresh session
    // has nothing to compact yet. Just mark idle so the user can continue.
    const wasCompactCommand = lastUserText === '/compact' || lastUserText.startsWith('/compact ');

    // Remove the last user message so sendMessage doesn't duplicate it (unless we're skipping resend)
    if (lastUserMsg && !wasCompactCommand) {
      this.messages = this.messages.filter(m => m.id !== lastUserMsg.id);
    }

    // Add a system message so the user knows what happened
    const sysMsg: UIMessage = {
      id: uuid(),
      role: 'system',
      content: wasCompactCommand
        ? `Compaction hit the 1M-context credit wall. Session auto-reset — start a fresh conversation. Your prior history is summarized and will prime the next message you send. (Old SDK session: ${oldSdkId})`
        : `Session too large (413) — auto-recovering with context from prior conversation. (Old SDK session: ${oldSdkId})`,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(sysMsg);
    this.broadcast({ type: 'assistant_message', sessionId: this.id, messageId: sysMsg.id, text: sysMsg.content });

    if (wasCompactCommand) {
      // Don't re-send /compact. Mark idle; user can continue from here.
      this.status = 'idle';
      this.currentToolActivity = null;
      this.broadcast({ type: 'state_change', sessionId: this.id, status: 'idle' });
      console.log(`[Session ${this.id}] Auto-recovered from /compact failure — no resend needed`);
      return;
    }

    const resendText = lastUserText || 'Continue where you left off.';
    console.log(`[Session ${this.id}] Auto-recovering from 413 — resending: "${resendText.slice(0, 80)}..."`);

    // Re-send with primed context (wasReset is true, so sendMessage will inject compacted context)
    this.sendMessage(resendText).catch(err => {
      console.error(`[Session ${this.id}] Auto-recovery failed:`, err.message);
      this.status = 'error';
      this.error = 'Auto-recovery from 413 failed. Click "Start Fresh" to try manually.';
      this.broadcast({ type: 'state_change', sessionId: this.id, status: 'error', error: this.error });
    });
  }

  /** Decide whether to run the Haiku task-switch classifier on this message. */
  private shouldCheckForTaskSwitch(message: string): boolean {
    if (message.startsWith('/')) return false;           // commands aren't tasks
    if (message.trim().length < 20) return false;        // too short to classify reliably
    if (!process.env.ANTHROPIC_API_KEY) return false;
    if (Date.now() - this.lastAutoCompactAt < 120_000) return false; // 2-min cooldown after compact
    // Only check when the user has been away a while — avoids latency during active back-and-forth
    const lastUserMsg = [...this.messages].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) return false;
    const msSinceLastMsg = Date.now() - new Date(lastUserMsg.timestamp).getTime();
    if (msSinceLastMsg < 5 * 60 * 1000) return false;
    // Need enough context to warrant compaction
    return this.messages.filter(m => m.role !== 'system').length >= 6;
  }

  /** Clear stuck pendingTaskSwitch state — analog to clearWakeup. Defensive utility. */
  clearPendingTaskSwitch(): void {
    this.pendingTaskSwitch = false;
  }

  async compact(): Promise<void> {
    // Send /compact as an internal message — bypasses task-switch classification
    await this.sendMessage('/compact', undefined, { internal: true });
  }

  async interrupt(): Promise<void> {
    this.cancelWakeup();
    // User is taking control — don't let the question gate auto-proceed behind them.
    this.clearQuestionTimer();
    this.pendingQuestion = null;
    if (this.activeProcess) {
      this.activeProcess.kill('SIGINT');
    }
  }

  async destroy(): Promise<void> {
    this.pendingPermission = null;
    this.clearWakeupTimer();
    this.pendingWakeup = null;
    this.clearQuestionTimer();
    this.pendingQuestion = null;
    this.monitors.stopAll(); // kill any watched background processes so they don't outlive the session

    // Clean up this session's per-session MCP config (controller mode writes one).
    // Best-effort — a leftover file is harmless, but cleaning up keeps the dir tidy.
    try {
      rmSync(join(MCP_CONFIG_DIR, `${this.id}.json`), { force: true });
    } catch { /* ignore */ }
    removeTaskRoster(this.id);

    if (this.activeProcess) {
      this.activeProcess.kill('SIGINT');
    }
  }
}

/** Parse one window of a rate_limit_event into our shape. Tolerant of field variants:
 *  used_percentage (0–100) preferred, else utilization (0–1) × 100; resets_at is epoch
 *  seconds (occasionally ms), normalized to ISO. Returns null if the window is absent. */
function parseRateLimitWindow(win: any): RateLimitWindow | null {
  if (!win || typeof win !== 'object') return null;
  let pct: number | null = null;
  if (typeof win.used_percentage === 'number') pct = win.used_percentage;
  else if (typeof win.utilization === 'number') pct = win.utilization <= 1 ? win.utilization * 100 : win.utilization;
  if (pct === null) return null;

  const raw = win.resets_at ?? win.resetsAt;
  let resetsAt: string;
  if (typeof raw === 'number') {
    resetsAt = new Date(raw < 1e12 ? raw * 1000 : raw).toISOString(); // epoch seconds → ms
  } else if (typeof raw === 'string') {
    resetsAt = raw;
  } else {
    return null;
  }
  return { usedPercent: Math.max(0, Math.min(100, Math.round(pct))), resetsAt, status: '' };
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return String(input.command || '').slice(0, 100);
    case 'Read':
      return String(input.file_path || '');
    case 'Write':
      return String(input.file_path || '');
    case 'Edit':
      return String(input.file_path || '');
    case 'Glob':
      return String(input.pattern || '');
    case 'Grep':
      return String(input.pattern || '');
    default:
      return toolName;
  }
}
