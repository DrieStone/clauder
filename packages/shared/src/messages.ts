import type { SessionConfig, SessionState, DiscoveredSession, ToolActivity, ContextUsage, RateLimitInfo, PermissionMode, ImageAttachment, QueuedMessage, ToolResultInfo, DebugLogEntry, PendingWakeup, Trigger, Skill } from './session.js';

// Browser -> Server
export type WsInboundMessage =
  | { type: 'create_session'; config: SessionConfig }
  | { type: 'send_message'; sessionId: string; message: string; images?: ImageAttachment[]; planMode?: boolean }
  | { type: 'plan_response'; sessionId: string; toolUseId: string; decision: 'accept' | 'reject'; feedback?: string }
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
  | { type: 'update_cwd'; sessionId: string; cwd: string }
  | { type: 'set_model'; sessionId: string; model: string }
  | { type: 'set_effort'; sessionId: string; effort: string }
  | { type: 'generate_summary'; sessionId: string }
  | { type: 'permission_response'; sessionId: string; toolUseId: string; decision: 'allow' | 'deny'; message?: string }
  | { type: 'question_response'; sessionId: string; toolUseId: string; answer: string }
  | { type: 'dequeue_message'; sessionId: string; index: number }
  | { type: 'cancel_wakeup'; sessionId: string }
  | { type: 'apply_claude_md_candidate'; sessionId: string; candidate: string }
  | { type: 'list_skills'; sessionId: string }
  | { type: 'clear_session'; sessionId: string }
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
  | { type: 'effort_changed'; sessionId: string; effort: string | null }
  | { type: 'cwd_changed'; sessionId: string; cwd: string }
  | { type: 'summary_generated'; sessionId: string; summary: string; summaryGeneratedAt: string }
  | { type: 'permission_request'; sessionId: string; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'permission_resolved'; sessionId: string }
  | { type: 'tool_result'; sessionId: string; toolUseId: string; result: ToolResultInfo }
  | { type: 'pending_question'; sessionId: string; toolUseId: string; question: { question: string; header?: string; options?: { label: string; description?: string }[] } }
  | { type: 'question_resolved'; sessionId: string; toolUseId: string }
  | { type: 'debug_log'; sessionId: string; entry: DebugLogEntry }
  | { type: 'wakeup_scheduled'; sessionId: string; wakeup: PendingWakeup }
  | { type: 'wakeup_cleared'; sessionId: string }
  | { type: 'triggers_snapshot'; triggers: Trigger[] }
  | { type: 'trigger_created'; trigger: Trigger }
  | { type: 'trigger_updated'; trigger: Trigger }
  | { type: 'trigger_deleted'; triggerId: string }
  | { type: 'trigger_fired'; trigger: Trigger }
  | { type: 'claude_md_applied'; sessionId: string; candidate: string }
  | { type: 'pending_plan'; sessionId: string; toolUseId: string; plan: string; messageId: string }
  | { type: 'plan_resolved'; sessionId: string; toolUseId: string }
  | { type: 'skills_list'; sessionId: string; skills: Skill[] }
  | { type: 'error'; sessionId: string; message: string };
