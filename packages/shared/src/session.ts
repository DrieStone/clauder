export type SessionStatus = 'idle' | 'working' | 'error' | 'resumable';

/** Where the session originated */
export type SessionOrigin = 'clauder' | 'vscode';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface SessionConfig {
  name: string;
  cwd: string;
  model?: string;
  /** Marks the singleton scratch session. Auto-created if missing; can be cleared but not deleted; hidden from main session list. */
  isScratch?: boolean;
  allowedTools?: string[];
  systemPrompt?: string;
  effort?: EffortLevel;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** SDK session ID to resume (e.g. from a VS Code session) */
  resumeSessionId?: string;
  permissionMode?: PermissionMode;
  /** When true, this session is loaded with the Clauder MCP server,
   * giving it tools to orchestrate other sessions. */
  controllerMode?: boolean;
  /** How long to wait for a human to answer an AskUserQuestion before the session
   *  proceeds on its own (making the best decision and noting the assumption).
   *  Defaults to 300 (5 min) for interactive sessions; an overnight/autonomous runner
   *  sets this low so it decides quickly instead of stalling. */
  questionTimeoutSeconds?: number;
  /** Persistent-goal ("Goal Mode") state. Null/absent = off. Lives on config so it
   *  round-trips through persistence with no schema change. See GoalState. */
  goal?: GoalState | null;
  /** When true, this session always appears in the session-switcher tab bar regardless of
   *  activity/recency/unread state — the same visibility Scratch gets, opt-in per session. */
  pinned?: boolean;
  /** IDs of the tags applied to this session (see TagDef / the tag registry). Optional additive
   *  field — round-trips through persistence with no migration, like `pinned`/`goal`. */
  tags?: string[];
  /** An in-progress multi-step "model plan": an ordered list of steps, each pinned to its own
   *  model/effort, that Clauder drives automatically — switching the session's model between
   *  steps. Null/absent = no plan running. See ModelPlan; declared by Claude's `<<model_plan>>`
   *  sentinel and executed by model-plan-runner.ts. */
  modelPlan?: ModelPlan | null;
  /** Set on a task: the id of its project's main session. A task is a full session of its own
   *  (its own conversation, model and status, able to run alongside the others) in the main
   *  session's folder; the dashboard shows the project as one card. Absent on a main or a
   *  standalone session. Only the main session commits (see project.ts). */
  mainSessionId?: string;
  /** A conversation in Scratch (its mainSessionId is the Scratch session): a quick conversation
   *  of its own in the scratch folder, without project rules (Scratch has nothing to commit).
   *  Deleted after SCRATCH_EXPIRY_DAYS untouched, unless `keep`. See server/src/scratch.ts. */
  scratchConversation?: boolean;
  /** A Scratch conversation the owner kept: it never expires. */
  keep?: boolean;
  /** On the Scratch session: when its own conversation moved out into the first Scratch
   *  conversation (a one-time step; later messages to it are scheduled jobs). */
  scratchSplitAt?: string;
  /** Sessions (main session ids) this one may message with <<to_session>> when the owner asks it to.
   *  A session a message came from may always be answered, whitelisted or not. */
  canMessage?: string[];
  /** The owner lets this session run on API credits when the subscription is out of usage
   *  (server/src/api-credits.ts). Off unless set: API credits are for important work only. */
  apiCredits?: boolean;
}

/** What API credits may be spent on, and how much (server/src/api-credits.ts). The key itself
 *  lives in ~/.clauder/api-key, never here. */
export interface ApiCreditsSettings {
  /** Master switch. Off, nothing ever runs on API credits. */
  enabled: boolean;
  /** Stop for the calendar month at this much estimated spend. */
  monthlyBudgetUsd: number;
  dailyBudgetUsd: number;
  /** One turn is cut off at this much (the CLI's --max-budget-usd). */
  perTurnBudgetUsd: number;
  /** 'session' = the model the session is on (Fable becomes Opus 5.5); or a model ID. */
  model: string;
  /** For a key that isn't tied to one workspace: the workspace to bill ("wrkspc_..."), sent as the
   *  anthropic-workspace-id header. Not a secret. Empty for a workspace key. */
  workspaceId: string;
}

export const DEFAULT_API_CREDITS_SETTINGS: ApiCreditsSettings = {
  enabled: false,
  // The credit is $200 a month; spend is estimated from the CLI's own cost figure, so keep a margin.
  monthlyBudgetUsd: 170,
  dailyBudgetUsd: 40,
  perTurnBudgetUsd: 15,
  model: 'session',
  workspaceId: '',
};

/** API credits as the owner's browser sees them. */
export interface ApiCreditsStatus {
  settings: ApiCreditsSettings;
  /** ~/.clauder/api-key: not there, not an Anthropic key, or usable. */
  keyState: 'missing' | 'invalid' | 'ok';
  /** The key's last four characters, to tell keys apart. */
  keyHint: string | null;
  /** Local calendar month ("2026-10") and day ("2026-10-09") the figures below are for. */
  month: string;
  day: string;
  monthSpentUsd: number;
  daySpentUsd: number;
  /** API credits are paused (out of credits, or the key was refused) until this time. */
  blockedUntil: string | null;
  blockedReason: string | null;
  /** True while the subscription is out of usage, i.e. API credits would be used right now. */
  subscriptionBlockedUntil: string | null;
  /** Sessions running a turn on API credits right now. */
  activeSessionIds: string[];
  /** This month's biggest spenders. */
  topSessions: { sessionId: string; name: string; usd: number }[];
  /** The latest API turns, newest first. */
  recent: { at: string; sessionId: string; name: string; usd: number; model: string }[];
}

/** Scratch (server/src/scratch.ts): conversations untouched this long are deleted unless kept. */
export const SCRATCH_EXPIRY_DAYS = 30;
/** Opening Scratch after this long away starts a fresh conversation. */
export const SCRATCH_STALE_HOURS = 6;
/** What a new Scratch conversation runs on. */
export const SCRATCH_CONVERSATION_MODEL = 'claude-opus-5-5';
export const SCRATCH_CONVERSATION_EFFORT: EffortLevel = 'medium';
/** A new Scratch conversation's name until its first message names it. */
export const SCRATCH_NEW_NAME = 'New conversation';

/** A user-defined session tag: a colored label sessions can carry. The registry of all tags
 *  lives server-side in `~/.clauder/tags.json` (see TagManager); sessions reference tags by id
 *  in `SessionConfig.tags`. `color` is a hex string (e.g. "#3b82f6") rendered via inline style
 *  so it survives Tailwind's purge (dynamic class names wouldn't). */
export interface TagDef {
  id: string;
  label: string;
  color: string;
}

/** A status note for a project that's gone quiet (server/src/status-reports.ts): where it stands,
 *  what was last worked on and what's left, so it can be picked up weeks or months later. Written
 *  automatically once a session has been idle STATUS_IDLE_DAYS, or on request; one per session (the
 *  latest), kept in `~/.clauder/status-reports.json` rather than on the session. */
export interface StatusReport {
  sessionId: string;
  /** Markdown, under three headings: Where it stands, Last worked on, Open threads. */
  text: string;
  generatedAt: string;
  /** The session's lastActiveAt when it was written. Later activity means the project moved on. */
  coversActivityAt: string;
  /** The task (thread) whose conversation it describes. */
  threadId: string;
  trigger: 'idle' | 'manual';
}

/** Days without activity before Clauder writes a session's status note on its own. */
export const STATUS_IDLE_DAYS = 15;

/** A dashboard folder: a named group of sessions, only for tidying the dashboard. The list lives
 *  server-side in `~/.clauder/folders.json` (see FolderManager), not on the sessions; a session is
 *  in at most one folder. */
export interface SessionFolder {
  id: string;
  name: string;
  sessionIds: string[];
}

/** One step of a ModelPlan: run `task` on the given `model`/`effort`. */
export interface ModelPlanStep {
  model: string;   // full model ID, e.g. "claude-opus-5-5"
  effort: EffortLevel;
  task: string;    // the instruction Clauder sends back to the session for this step
}

/** A running model plan. Clauder advances one step per idle: it sets the session's model+effort
 *  to the step's, then sends the step's task as an internal message (so that turn runs on the
 *  chosen model). Lives on SessionConfig so it round-trips through persistence. `cursor` is the
 *  index of the NEXT step to run; when it reaches steps.length the plan finishes and clears. */
export interface ModelPlan {
  steps: ModelPlanStep[];
  cursor: number;
  status: 'running';
  startedAt: string;
  /** Model/effort the session had before the plan started; restored when the plan
   *  finishes or is stopped. Absent on plans started before this field existed. */
  restoreModel?: string;
  restoreEffort?: EffortLevel;
}

/** "Goal Mode" — keeps a session working toward `text` until it's met. A server-side
 *  supervisor (goal-supervisor.ts) runs on every idle: it lets a self-scheduled check-in
 *  stand, nudges the session to continue or schedule one, sleeps through a rate-limit
 *  window (without burning a nudge), or escalates to the user. Turned on/off via the UI
 *  or Claude's own `<<goal>>` / `<<goal_complete>>` sentinels. */
export interface GoalState {
  /** What the session is working toward. */
  text: string;
  /** ISO — when goal mode was first turned on (preserved across adjustments). */
  createdAt: string;
  /** ISO — hard stop; the supervisor turns goal mode off at this time. */
  deadlineAt: string;
  /** Suggested check-in cadence in minutes (what the session is told to schedule). */
  checkEveryMin: number;
  /** Max consecutive no-progress nudges before escalating to the user. */
  maxNudges: number;
  /** Consecutive nudges since progress was last observed (resets when real work happens). */
  nudgeCount: number;
  /** ISO of the last nudge, or null. */
  lastNudgeAt: string | null;
  /** Tool-use count at the last supervise check — used to detect progress between nudges. */
  progressMark: number;
  /** active = being supervised; sleeping = waiting out a rate-limit window;
   *  complete/expired/stuck = terminal or paused (supervisor takes no further action). */
  status: 'active' | 'sleeping' | 'complete' | 'expired' | 'stuck';
}

export interface DiscoveredSession {
  sessionId: string;
  projectPath: string;
  projectDir: string;
  fileSize: number;
  lastModified: string;
  firstUserMessage: string | null;
  lastTimestamp: string | null;
  messageCount: { user: number; assistant: number; total: number };
}

export interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
}

export interface SessionState {
  id: string;
  config: SessionConfig;
  status: SessionStatus;
  origin: SessionOrigin;
  sdkSessionId: string | null;
  totalCostUsd: number;
  error: string | null;
  /** What the session is currently waiting for, if anything. Set when a question/permission
   *  is pending; cleared when resolved. Drives the "Needs you" UI indicator. */
  waitingFor: string | null;
  currentToolActivity: ToolActivity | null;
  contextUsage: ContextUsage | null;
  queuedMessages: QueuedMessage[];
  messages: UIMessage[];
  /** Total messages the server holds. The bulk session list carries only the most recent ones
   *  (see client-view.ts), so a client compares this with what it has to know to ask for more. */
  messageCount?: number;
  permissionMode: PermissionMode;
  pendingPermission: PendingPermission | null;
  pendingWakeup: PendingWakeup | null;
  /** A plan awaiting accept/reject, if any. Null when none is pending. Included in the snapshot
   *  so the plan banner survives reconnects (mobile especially). See PendingPlan. */
  pendingPlan: PendingPlan | null;
  /** Active event-monitors for this session. Rides the snapshot so the UI's monitor chips survive
   *  reconnects. Empty when none are running. See MonitorInfo. */
  monitors: MonitorInfo[];
  summary: string | null;
  summaryGeneratedAt: string | null;
  compactedContext: string | null;
  /** User-facing reference notes maintained by Claude via the `<<notes>>` sentinel — things
   *  like "run `npm run dev` to start the server" or "view it at http://localhost:5173".
   *  Distinct from `summary` (a compaction aid) and CLAUDE.md (project-wide conventions):
   *  this is per-session, practical, "how do I use what we just built" reference material.
   *  Markdown. Null/empty means the Notes tab shows its empty state. */
  notes: string | null;
  notesUpdatedAt: string | null;
  debugLog: DebugLogEntry[];
  createdAt: string;
  lastActiveAt: string;
  /** Id of the currently-live conversation thread within this session panel. See ParkedThread
   *  for what "thread" means and why parking/resuming is essentially free. */
  activeThreadId: string;
  /** Human name for the live thread, or null when unnamed (UI shows "Current thread"). */
  activeThreadName: string | null;
  /** Parked (tabled) threads, newest-first. Lightweight summaries only — the full snapshot
   *  (messages, sdkSessionId, etc.) lives server-side in ParkedThread and never round-trips to
   *  the client except via resume, which swaps it in as the new live thread. */
  threads: ThreadSummary[];
}

/** A snapshot of one conversation "thread" tabled via Park & start fresh — everything needed to
 *  resume it later exactly where it left off. Threads are cold-start by design (option A): a
 *  freshly-started thread knows nothing about a parked one; only the human sees the parked list
 *  and chooses to swap back. Server-side only — never sent to the client as-is (see
 *  ThreadSummary); persisted in sessions.json alongside the live session fields. */
export interface ParkedThread {
  id: string;
  /** Editable; auto-derived at park time from the first user message / summary / "Thread N". */
  name: string;
  /** The session's cwd at park time — a thread can only be resumed while the panel's cwd still
   *  matches, since the CLI stores conversations per working directory. */
  cwd: string;
  sdkSessionId: string | null;
  messages: UIMessage[];
  contextUsage: ContextUsage | null;
  summary: string | null;
  summaryGeneratedAt: string | null;
  compactedContext: string | null;
  pendingPlan: PendingPlan | null;
  pendingWakeup: PendingWakeup | null;
  queuedMessages: QueuedMessage[];
  /** This thread's own cumulative CLI conversation cost at park time (totalCostUsd - costBaseline
   *  on ManagedSession) — added back into costBaseline on resume so the session's lifetime
   *  totalCostUsd stays monotonic across a park/resume cycle. */
  sdkCostSoFar: number;
  wasReset: boolean;
  needsFork: boolean;
  /** The task's own model/effort at park time, restored when it's switched back to (null = the
   *  session default). Absent on threads parked before tasks existed. */
  model?: string | null;
  effort?: EffortLevel | null;
  parkedAt: string;
  lastActiveAt: string;
}

/** What the client sees for a parked thread — no message bodies, so the sessions_list snapshot
 *  stays light (mobile especially). Full content only arrives via a resume, which replaces the
 *  session's live messages wholesale (same session_created broadcast Clear already uses). */
export interface ThreadSummary {
  id: string;
  name: string;
  messageCount: number;
  /** First user message, trimmed to ~80 chars, for a one-line hint in the parked list. */
  preview: string;
  parkedAt: string;
  lastActiveAt: string;
  /** The task's own model (see ParkedThread.model). */
  model?: string | null;
}

export interface ImageAttachment {
  /** base64-encoded. Emptied on the wire for stored history — see `src`. */
  data: string;
  mimeType: string;   // image/png, image/jpeg, image/gif, image/webp
  /** Set instead of `data` when the browser should fetch the bytes from the server and cache
   *  them, rather than receive them inline (base64 images were ~80% of the connect payload). */
  src?: string;
}

export interface FileAttachment {
  name: string;
  mimeType: string;
  /** Raw text for text files; base64 for binary files (PDFs and 'binary'). Emptied after the
   *  server saves a 'binary' file to disk, so the on-disk copy is the source of truth and a
   *  large blob (an XLS, a zip) doesn't get persisted into sessions.json. */
  content: string;
  /** Set instead of `content` for stored history — the browser fetches the bytes on demand. */
  src?: string;
  /** How the file is delivered to Claude:
   *  - 'text'     — source/text file injected inline as a text content block.
   *  - 'document' — PDF sent as a native API document block (Claude reads it directly).
   *  - 'binary'   — any other type (XLS, docx, zip, …): saved to disk, path given to Claude,
   *                 which reads it with its own tools (Bash/Read). The API has no content
   *                 block for these formats, so disk + path is the only way they work. */
  kind: 'text' | 'document' | 'binary';
}

export interface Skill {
  /** Command name without leading slash, e.g. "simplify" */
  name: string;
  /** Short human-readable description (first line of .md for project skills) */
  description: string;
  /** 'clauder': a Clauder command handled by Clauder itself (e.g. /task), never sent to Claude. */
  source: 'builtin' | 'project' | 'clauder';
}

export interface QueuedMessage {
  text: string;
  images?: ImageAttachment[];
  files?: FileAttachment[];
  /** True if this message was injected programmatically (trigger, wakeup, etc.) rather than typed by the user. */
  internal?: boolean;
  /** Per-turn model/effort override (from the "Send with" chip). Applies to THIS turn only;
   *  never mutates the session's configured model/effort. Carried through the queue so a
   *  message queued while busy still runs on the chosen model when it drains. */
  model?: string;
  effort?: string;
  /** A guest's message waiting its turn keeps its attribution. */
  author?: MessageAuthor;
}

/** Who wrote a user message that didn't come from the session's owner: a guest on a share link. */
/** Who sent a message, when it wasn't the owner: a guest on a share link (`shareId`), or another
 *  session of the same project (`sessionId`), e.g. a task checking in with the main session. */
export interface MessageAuthor {
  name: string;
  shareId?: string;
  sessionId?: string;
  /** A message from a session of another project (<<to_session>>), not one of this project's. */
  crossProject?: boolean;
}

/** A link that shares one session with one named guest on the local network (shares.ts). The
 *  token is the link's secret; the owner sees it, guests never see anyone's. */
export interface ShareLink {
  id: string;
  token: string;
  sessionId: string;
  /** Who it's for. Claude is told this name with each of their messages. */
  guestName: string;
  /** The owner's limits for this guest, passed to Claude with each of their messages. */
  rules: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Set when a guest on a share link wrote it; absent for the owner (and for assistant/system). */
  author?: MessageAuthor;
  images?: ImageAttachment[];
  files?: FileAttachment[];
  toolUses?: ToolUseInfo[];
  /** A progress note: the text of the thinking block(s) in this message. Opus 5.5 and Sonnet 5.5
   *  write their between-tool updates there rather than as text. */
  thinking?: string;
  timestamp: string;
  isStreaming?: boolean;
  /** User-pinned so it stays visible in a sticky section above the scrollable chat,
   *  and is exempt from in-memory/persisted history trimming. */
  pinned?: boolean;
}

/** Version-control state of a session's folder (GET /api/sessions/:id/git), for the session header's
 *  repo indicator. Anything about the remote reflects the last fetch or push. */
export interface GitStatus {
  /** False when the folder isn't inside a git repository (or git couldn't run there). */
  isRepo: boolean;
  /** The checked-out branch; null when detached or not a repo. */
  branch: string | null;
  /** Where it's backed up, as "owner/repo" (host-prefixed off GitHub); null with no remote. */
  remoteLabel: string | null;
  /** Browser link to the remote, when one can be derived. */
  remoteWebUrl: string | null;
  /** The latest commit (ISO) and its subject; null in a repo with no commits yet. */
  lastCommitAt: string | null;
  lastCommitSubject: string | null;
  /** Files with uncommitted changes, untracked ones included. */
  changedFiles: number;
  /** Commits on this branch that no remote has yet; null with no remote. */
  unpushedCommits: number | null;
  /** When git was run. */
  checkedAt: string;
}

export interface ToolResultInfo {
  /** Tool output content, truncated to 10K chars on server */
  content: string;
  /** True if the tool returned an error */
  isError: boolean;
  /** Original length before truncation, if truncated */
  originalLength?: number;
}

export interface ToolUseInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: ToolResultInfo;
}

export type DebugLogEntryType = 'tool_start' | 'tool_result' | 'stderr' | 'sdk_event' | 'api_error';

export interface DebugLogEntry {
  id: string;
  timestamp: string;
  type: DebugLogEntryType;
  label: string;
  content: string;
  originalLength?: number;
  toolUseId?: string;
}

export interface ToolActivity {
  toolName: string;
  description: string;
}

export interface PendingPermission {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/** A live event-monitor: Clauder runs `command` as a managed background process in the session's
 *  cwd and watches its output. Each line matching `pattern` (all lines if no pattern) wakes the
 *  session with an internal message so it reacts to events in a real turn — the Clauder-native
 *  replacement for the interactive CLI's `Monitor` tool, which can't deliver events into Clauder's
 *  headless, turn-based model. Transient (not persisted across a server restart). */
export interface MonitorInfo {
  id: string;
  /** Human label shown in the UI and in the wake message. */
  description: string;
  /** The shell command being watched (streams lines to stdout, e.g. `tail -n0 -f file`). */
  command: string;
  /** Optional regex (source string); lines matching it are reported. Absent = report every line. */
  pattern?: string;
  /** When true, the monitor stops itself after its first batch of matches. */
  stopOnMatch: boolean;
  createdAt: string;
  /** ISO — when the monitor auto-stops (runtime cap) if not stopped sooner. */
  autoStopAt: string;
  /** How many matching lines have been seen so far. */
  matchCount: number;
  lastMatchAt?: string;
  status: 'running' | 'ended';
}

/** A plan awaiting the user's accept/reject (Custom Plan feature). Lives on SessionState so it
 *  rides along in the sessions_list snapshot and survives WS reconnects — otherwise the plan
 *  banner is driven only by the one-shot `pending_plan` event and a client that reconnected or
 *  connected late (the normal state of a phone) never sees it. `plan` is the full text incl. the
 *  clauder-steps block; the accept handler parses steps out of it server-side. */
export interface PendingPlan {
  toolUseId: string;
  plan: string;
  messageId: string;
}

export type TriggerSchedule =
  | { type: 'once'; at: string }
  | { type: 'recurring'; intervalSeconds: number; nextAt: string };

export interface Trigger {
  id: string;
  /** Which session to send the message to when this trigger fires */
  sessionId: string;
  /** The message to send */
  message: string;
  /** Human-readable description (e.g. "Check on project X") */
  description: string;
  schedule: TriggerSchedule;
  enabled: boolean;
  createdAt: string;
  lastFiredAt: string | null;
  /** 'watch' = controller-managed self-check-in; 'scheduled' = user-created one-shot or recurring */
  source: 'watch' | 'scheduled';
}

export interface PendingWakeup {
  /** ISO timestamp when the wakeup will fire */
  scheduledAt: string;
  /** Human-readable reason (from Claude's tool input) */
  reason: string;
  /** Total delay in seconds (for display) */
  delaySeconds: number;
  /** Continuation prompt to send when wakeup fires */
  prompt: string;
  /** The ScheduleWakeup tool use ID that created this */
  toolUseId: string;
}

/** One real Claude subscription usage window, parsed from the CLI's rate_limit_event. */
export interface RateLimitWindow {
  /** Percent of the window's limit used, 0–100. Null means the event fired but carried no
   *  utilization data (fresh window or rejected state) — distinct from "known to be 0%". */
  usedPercent: number | null;
  /** ISO timestamp when this window resets. */
  resetsAt: string;
  /** Raw status from the event: "allowed" | "allowed_warning" | "rejected" */
  status: string;
}

export interface RateLimitInfo {
  /** Budget ceiling for the rolling window (e.g. 5.00) */
  budgetLimit: number;
  /** Amount spent within the current rolling window */
  budgetUsed: number;
  /** ISO timestamp when the oldest cost entry expires (frees the most budget), or null */
  windowResetAt: string | null;
  /** ISO timestamp of when this was last computed */
  updatedAt: string;
  /** Real subscription usage from the CLI's rate_limit_event. Null until the first event
   *  arrives (only present for subscribers, after the first API response). When present,
   *  the UI shows these real numbers instead of the cost proxy so it matches the Claude app. */
  session?: RateLimitWindow | null;   // five_hour — the "Current session" limit
  weekly?: RateLimitWindow | null;    // seven_day — the weekly limit
  /** seven_day usage INCLUDING overage (the CLI's `seven_day_overage_included` window).
   *  Only meaningful when overage is enabled on the account; informational otherwise. */
  weeklyOverage?: RateLimitWindow | null;
  /** Rolling spend-by-model summary (last 24h / 7d) from the cost ledger, for the quota
   *  popover. Absent until the first turn is recorded. See CostSummary. */
  costSummary?: CostSummary | null;
}

/** Cost rolled up by model over a trailing window. Produced by cost-ledger.ts. */
export interface CostSummaryWindow {
  byModel: Record<string, { cost: number; turns: number }>;
  total: number;
}
export interface CostSummary {
  last24h: CostSummaryWindow;
  last7d: CostSummaryWindow;
}

/** View state that follows the user across devices (server/src/ui-state.ts): when each session was
 *  last read (server clock, ISO), which tabs were closed from the tab menu (ms), and the order of
 *  pinned tabs. */
export interface UiState {
  readAt: Record<string, string>;
  closedTabs: Record<string, number>;
  pinOrder: string[];
}

/** Keeping sessions' prompt caches warm (server/src/keep-warm.ts), as the owner's browser sees it. */
export interface KeepWarmStatus {
  /** Keep projects warm automatically while the owner is around. */
  auto: boolean;
  /** The owner has done something in Clauder in the last two hours. */
  around: boolean;
  /** The 🔥 button's default length, in hours. */
  defaultHours: number;
  /** Projects (main session ids) being kept warm now, and until when. */
  projects: Record<string, { until: string; mode: 'manual' | 'auto' }>;
  /** Sessions actually being kept warm now: in a warm project, with their cache still alive. */
  sessions: string[];
  /** Pings so far, and what they cost (API-equivalent), since `since`. */
  pings: number;
  costUsd: number;
  since: string;
}
