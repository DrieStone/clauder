import type { SessionConfig, SessionState, DiscoveredSession, ToolActivity, ContextUsage, RateLimitInfo, PermissionMode, ImageAttachment, QueuedMessage, ToolResultInfo, DebugLogEntry } from './session.js';

// Browser -> Server
export type WsInboundMessage =
  | { type: 'create_session'; config: SessionConfig }
  | { type: 'send_message'; sessionId: string; message: string; images?: ImageAttachment[] }
  | { type: 'destroy_session'; sessionId: string }
  | { type: 'interrupt_session'; sessionId: string }
  | { type: 'compact_session'; sessionId: string }
  | { type: 'reset_session'; sessionId: string }
  | { type: 'discover_sessions' }
  | { type: 'resume_discovered'; sdkSessionId: string; name: string; projectPath: string }
  | { type: 'pause_sessions'; pauseUntil: string }
  | { type: 'resume_sessions' }
  | { type: 'set_permission_mode'; sessionId: string; mode: PermissionMode }
  | { type: 'rename_session'; sessionId: string; newName: string }
  | { type: 'set_model'; sessionId: string; model: string }
  | { type: 'generate_summary'; sessionId: string }
  | { type: 'permission_response'; sessionId: string; toolUseId: string; decision: 'allow' | 'deny'; message?: string }
  | { type: 'dequeue_message'; sessionId: string; index: number }
  | { type: 'ping' };

// Server -> Browser
export type WsOutboundMessage =
  | { type: 'sessions_list'; sessions: SessionState[] }
  | { type: 'session_created'; session: SessionState }
  | { type: 'session_destroyed'; sessionId: string }
  | { type: 'state_change'; sessionId: string; status: string; error?: string }
  | { type: 'assistant_message'; sessionId: string; messageId: string; text: string; toolUses?: { id: string; name: string; input: Record<string, unknown> }[] }
  | { type: 'assistant_message_stream'; sessionId: string; messageId: string; delta: string }
  | { type: 'user_message_echo'; sessionId: string; messageId: string; text: string; images?: ImageAttachment[] }
  | { type: 'tool_activity'; sessionId: string; activity: ToolActivity }
  | { type: 'result'; sessionId: string; costUsd: number; success: boolean; error?: string }
  | { type: 'context_update'; sessionId: string; contextUsage: ContextUsage }
  | { type: 'discovered_sessions'; sessions: DiscoveredSession[] }
  | { type: 'queue_update'; sessionId: string; queue: QueuedMessage[] }
  | { type: 'rate_limit_update'; rateLimit: RateLimitInfo }
  | { type: 'pause_update'; pauseUntil: string | null }
  | { type: 'permission_mode_change'; sessionId: string; mode: PermissionMode }
  | { type: 'session_renamed'; sessionId: string; newName: string }
  | { type: 'model_changed'; sessionId: string; model: string }
  | { type: 'summary_generated'; sessionId: string; summary: string; summaryGeneratedAt: string }
  | { type: 'permission_request'; sessionId: string; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'permission_resolved'; sessionId: string }
  | { type: 'tool_result'; sessionId: string; toolUseId: string; result: ToolResultInfo }
  | { type: 'debug_log'; sessionId: string; entry: DebugLogEntry }
  | { type: 'error'; sessionId: string; message: string };
