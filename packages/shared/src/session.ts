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
}

/** A user-defined session tag: a colored label sessions can carry. The registry of all tags
 *  lives server-side in `~/.clauder/tags.json` (see TagManager); sessions reference tags by id
 *  in `SessionConfig.tags`. `color` is a hex string (e.g. "#3b82f6") rendered via inline style
 *  so it survives Tailwind's purge (dynamic class names wouldn't). */
export interface TagDef {
  id: string;
  label: string;
  color: string;
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
  source: 'builtin' | 'project';
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
}

export interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
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
