export type SessionStatus = 'idle' | 'working' | 'error' | 'resumable';

/** Where the session originated */
export type SessionOrigin = 'clauder' | 'vscode';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';

export interface SessionConfig {
  name: string;
  cwd: string;
  model?: string;
  allowedTools?: string[];
  systemPrompt?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** SDK session ID to resume (e.g. from a VS Code session) */
  resumeSessionId?: string;
  permissionMode?: PermissionMode;
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

export interface QueuedMessage {
  text: string;
  images?: ImageAttachment[];
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
