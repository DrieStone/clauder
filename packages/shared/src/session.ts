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
  currentToolActivity: ToolActivity | null;
  contextUsage: ContextUsage | null;
  queuedMessages: QueuedMessage[];
  messages: UIMessage[];
  permissionMode: PermissionMode;
  pendingPermission: PendingPermission | null;
  pendingWakeup: PendingWakeup | null;
  summary: string | null;
  summaryGeneratedAt: string | null;
  compactedContext: string | null;
  debugLog: DebugLogEntry[];
  createdAt: string;
  lastActiveAt: string;
}

export interface ImageAttachment {
  data: string;       // base64-encoded
  mimeType: string;   // image/png, image/jpeg, image/gif, image/webp
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
  /** True if this message was injected programmatically (trigger, wakeup, etc.) rather than typed by the user. */
  internal?: boolean;
}

export interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  images?: ImageAttachment[];
  toolUses?: ToolUseInfo[];
  timestamp: string;
  isStreaming?: boolean;
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

export interface RateLimitInfo {
  /** Budget ceiling for the rolling window (e.g. 5.00) */
  budgetLimit: number;
  /** Amount spent within the current rolling window */
  budgetUsed: number;
  /** ISO timestamp when the oldest cost entry expires (frees the most budget), or null */
  windowResetAt: string | null;
  /** ISO timestamp of when this was last computed */
  updatedAt: string;
}
