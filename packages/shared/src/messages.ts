import type { SessionConfig, SessionState, DiscoveredSession, ToolActivity, ContextUsage, RateLimitInfo, PermissionMode, ImageAttachment, FileAttachment, QueuedMessage, ToolResultInfo, DebugLogEntry, PendingWakeup, Trigger, Skill, GoalState, ModelPlan, MonitorInfo, ThreadSummary, TagDef, UIMessage, UiState, ShareLink, MessageAuthor } from './session.js';
import type { ProjectRun, RunBudget } from './project-run.js';

// Browser -> Server
export type WsInboundMessage =
  // projectFolder: create (or reuse) that folder in the server's dev root and run the session in
  // it — the new-session form's "New project" option. config.cwd is replaced on that path.
  | { type: 'create_session'; config: SessionConfig; projectFolder?: string }
  // Cross-device view state (server/src/ui-state.ts). merge_ui_state is sent once per device, with
  // what it tracked locally before syncing existed.
  | { type: 'mark_read'; sessionId: string }
  | { type: 'set_tab_closed'; sessionId: string; closed: boolean }
  | { type: 'set_pin_order'; ids: string[] }
  | { type: 'merge_ui_state'; state: Partial<UiState> }
  | { type: 'send_message'; sessionId: string; message: string; images?: ImageAttachment[]; files?: FileAttachment[]; planMode?: boolean; model?: string; effort?: string }
  | { type: 'plan_response'; sessionId: string; toolUseId: string; decision: 'accept' | 'reject'; feedback?: string }
  | { type: 'destroy_session'; sessionId: string }
  | { type: 'interrupt_session'; sessionId: string }
  | { type: 'compact_session'; sessionId: string }
  | { type: 'reset_session'; sessionId: string }
  | { type: 'discover_sessions' }
  | { type: 'resume_discovered'; sdkSessionId: string; name: string; projectPath: string }
  | { type: 'pause_sessions'; pauseUntil: string }
  | { type: 'resume_sessions' }
  | { type: 'reset_rate_limit' }
  | { type: 'create_project_run'; name: string; repoPath: string; goal: string; budget?: RunBudget; executorModel?: string }
  | { type: 'approve_project_run'; runId: string; budget?: RunBudget; verifyCommands?: string[] }
  | { type: 'cancel_project_run'; runId: string }
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
  /** Snapshot the live thread into the parked list and start a fresh conversation. `name?`
   *  overrides the auto-derived name for the thread being parked. */
  | { type: 'park_thread'; sessionId: string; name?: string }
  /** Swap a parked thread back in as the live one (parking the current live thread first, if it
   *  has any content). */
  | { type: 'resume_thread'; sessionId: string; threadId: string }
  | { type: 'discard_thread'; sessionId: string; threadId: string }
  /** Rename a thread — `threadId` may be the session's activeThreadId to rename the live thread. */
  | { type: 'rename_thread'; sessionId: string; threadId: string; name: string }
  /** Task selector's "New task": park the current task (if it has content), then start a fresh
   *  one with this name on its own starting model/effort. */
  | { type: 'start_task'; sessionId: string; name: string; model?: string; effort?: string }
  | { type: 'set_goal'; sessionId: string; goal: { text: string; checkEveryMin?: number; deadlineHours?: number; maxNudges?: number } | null }
  | { type: 'set_notes'; sessionId: string; notes: string | null }
  | { type: 'set_pinned'; sessionId: string; pinned: boolean }
  /** Replace the set of tags applied to a session (tag ids). */
  | { type: 'set_tags'; sessionId: string; tags: string[] }
  /** Ask for a session's full message history (the session list only carries recent messages). */
  | { type: 'request_history'; sessionId: string }
  /** Ask for a session's debug log — the session list doesn't carry it; the Debug tab asks. */
  | { type: 'request_debug_log'; sessionId: string }
  /** Tag-registry CRUD (the tag editor with colors). */
  | { type: 'create_tag'; label: string; color: string }
  | { type: 'update_tag'; id: string; label?: string; color?: string }
  | { type: 'delete_tag'; id: string }
  | { type: 'pin_message'; sessionId: string; messageId: string; pinned: boolean }
  /** Share links (owner only; a guest connection may send only ping, request_history,
   *  send_message and interrupt_session, for its own session). */
  | { type: 'create_share'; sessionId: string; guestName: string; rules: string }
  | { type: 'update_share'; id: string; guestName?: string; rules?: string }
  | { type: 'revoke_share'; id: string }
  | { type: 'stop_model_plan'; sessionId: string }
  | { type: 'stop_monitor'; sessionId: string; monitorId: string }
  | { type: 'archive_session'; sessionId: string }
  /** Generic feature-usage log for pure client-side navigation (tab switches, modal opens)
   *  that never otherwise touches the server. `feature` is a short slug, `detail` a few
   *  safe scalar fields only — never free text. */
  | { type: 'log_event'; feature: string; detail?: Record<string, string | number | boolean> }
  | { type: 'ping' };

// Server -> Browser
export type WsOutboundMessage =
  | { type: 'sessions_list'; sessions: SessionState[] }
  | { type: 'session_created'; session: SessionState }
  | { type: 'session_destroyed'; sessionId: string }
  | { type: 'state_change'; sessionId: string; status: string; error?: string; waitingFor?: string | null }
  | { type: 'assistant_message'; sessionId: string; messageId: string; text: string; thinking?: string; toolUses?: { id: string; name: string; input: Record<string, unknown> }[]; images?: ImageAttachment[] }
  | { type: 'assistant_message_stream'; sessionId: string; messageId: string; delta: string }
  | { type: 'user_message_echo'; sessionId: string; messageId: string; text: string; images?: ImageAttachment[]; files?: FileAttachment[]; author?: MessageAuthor }
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
  | { type: 'monitors_update'; sessionId: string; monitors: MonitorInfo[] }
  | { type: 'skills_list'; sessionId: string; skills: Skill[] }
  | { type: 'project_runs_snapshot'; runs: ProjectRun[] }
  | { type: 'project_run_update'; run: ProjectRun }
  | { type: 'project_run_removed'; runId: string }
  | { type: 'goal_updated'; sessionId: string; goal: GoalState | null }
  | { type: 'notes_updated'; sessionId: string; notes: string | null; notesUpdatedAt: string | null }
  | { type: 'pinned_changed'; sessionId: string; pinned: boolean }
  /** A session's tag set changed. */
  | { type: 'tags_changed'; sessionId: string; tags: string[] }
  /** Full snapshot of the tag registry (sent on connect and after any tag CRUD). */
  | { type: 'tags_registry'; tags: TagDef[] }
  | { type: 'ui_state'; state: UiState }
  /** Every share link, to owner connections only. `baseUrl` is this Mac on the local network. */
  | { type: 'shares_snapshot'; shares: ShareLink[]; baseUrl: string }
  /** Sent to a guest connection once, on connect: which session it's scoped to and who it is. */
  | { type: 'guest_info'; sessionId: string; guestName: string }
  /** Reply to `request_history`: the session's full history, attachments as URLs. */
  | { type: 'session_history'; sessionId: string; messages: UIMessage[] }
  /** Reply to `request_debug_log`: the session's recent debug entries. */
  | { type: 'session_debug_log'; sessionId: string; entries: DebugLogEntry[] }
  | { type: 'message_pinned'; sessionId: string; messageId: string; pinned: boolean }
  | { type: 'model_plan_updated'; sessionId: string; plan: ModelPlan | null }
  | { type: 'archive_status'; sessionId: string; stage: 'summarizing' | 'zipping' | 'verifying' | 'trashing' | 'done' | 'error'; message: string }
  | { type: 'archive_complete'; sessionId: string; zipPath: string }
  | { type: 'error'; sessionId: string; message: string }
  | { type: 'auth_restored' }
  /** Parked-thread list changed (rename/discard) without a full session replace — park/resume
   *  instead ride the existing 'session_created' broadcast (see ManagedSession.clearMessages). */
  | { type: 'threads_update'; sessionId: string; threads: ThreadSummary[]; activeThreadId: string; activeThreadName: string | null };
