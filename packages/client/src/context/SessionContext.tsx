import React, { createContext, useContext, useReducer, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SessionState, SessionConfig, DiscoveredSession, WsOutboundMessage, UIMessage, RateLimitInfo, PermissionMode, ImageAttachment, FileAttachment, QueuedMessage, ToolResultInfo, DebugLogEntry, PendingWakeup, Trigger, Skill, ProjectRun, RunBudget, GoalState, ModelPlan, MonitorInfo, TagDef, UiState, ShareLink, MessageAuthor } from '@clauder/shared';
import { trimMessages } from '@clauder/shared';
import { WsClient } from '../lib/ws-client';
import { buildWsCandidates, buildGuestWsUrl } from '../lib/hosts';
import { notify } from '../lib/notifications';
import { isSessionUnread } from '../lib/unread';
import { loadLocalUiState, saveLocalUiState, localUiStateToMerge, clearLocalUiState } from '../lib/uiStateLocal';

// State
export interface PendingQuestionInfo {
  toolUseId: string;
  question: string;
  header?: string;
  options?: { label: string; description?: string }[];
}

export interface PendingPlanInfo {
  toolUseId: string;
  plan: string;
  messageId: string;
}

interface AppState {
  sessions: Map<string, SessionState>;
  activeSessionId: string | null;
  wsConnected: boolean;
  discoveredSessions: DiscoveredSession[];
  showDiscovery: boolean;
  discoveryLoading: boolean;
  rateLimit: RateLimitInfo | null;
  pauseUntil: string | null;
  /** Pending AskUserQuestion per session: sessionId -> question info */
  pendingQuestions: Map<string, PendingQuestionInfo>;
  /** Pending ExitPlanMode per session: sessionId -> plan info */
  pendingPlans: Map<string, PendingPlanInfo>;
  /** All triggers (watches + scheduled), keyed by trigger id */
  triggers: Map<string, Trigger>;
  /** The tag registry (user-defined colored labels), in registry order. */
  tags: TagDef[];
  /** Read status, closed tabs and pinned-tab order. Synced across devices by the server once
   *  `uiSynced`; until then (a server that predates syncing) kept in this browser only. */
  uiState: UiState;
  uiSynced: boolean;
  /** Skill list per session: sessionId -> skills available in that session's cwd */
  sessionSkills: Map<string, Skill[]>;
  /** CLAUDE.md candidates already written (auto-applied by the server or applied manually),
   *  by candidate text — so the banner shows "Applied" without a click. */
  appliedClaudeMd: Set<string>;
  /** Overnight Project Runner runs, keyed by run id. */
  projectRuns: Map<string, ProjectRun>;
  /** Archive-project progress per session: sessionId -> latest stage/message. On the 'done'
   *  stage the message is the final zip path. Entries for destroyed sessions are harmless
   *  leftovers (tiny map, never cleaned up — not worth the complexity for v1). */
  archiveStatus: Map<string, { stage: string; message: string }>;
  /** The session whose Debug tab is open, if any. Debug logs are held only for it: the session
   *  list doesn't carry them, the tab fetches them (request_debug_log), and live entries for other
   *  sessions are dropped without a re-render. */
  debugSessionId: string | null;
  /** Share links (owner side, from shares_snapshot) and this Mac's address on the local network. */
  shares: ShareLink[];
  shareBaseUrl: string | null;
  /** Set on a share-link page: the one session this guest can see, and their name. */
  guest: { sessionId: string; guestName: string } | null;
  /** The share link was refused (revoked or invalid); the page has stopped reconnecting. */
  accessDenied: boolean;
}

// Actions
type Action =
  | { type: 'SESSIONS_LIST'; sessions: SessionState[] }
  | { type: 'SESSION_CREATED'; session: SessionState }
  | { type: 'SESSION_DESTROYED'; sessionId: string }
  | { type: 'SESSION_HISTORY'; sessionId: string; messages: UIMessage[] }
  | { type: 'STATE_CHANGE'; sessionId: string; status: string; error?: string; waitingFor?: string | null }
  | { type: 'ASSISTANT_MESSAGE'; sessionId: string; messageId: string; text: string; thinking?: string; toolUses?: any[]; images?: ImageAttachment[] }
  | { type: 'ASSISTANT_STREAM_DELTA'; sessionId: string; messageId: string; delta: string }
  | { type: 'USER_MESSAGE_ECHO'; sessionId: string; messageId: string; text: string; images?: ImageAttachment[]; files?: FileAttachment[]; author?: MessageAuthor }
  | { type: 'SHARES_SNAPSHOT'; shares: ShareLink[]; baseUrl: string }
  | { type: 'GUEST_INFO'; sessionId: string; guestName: string }
  | { type: 'ACCESS_DENIED' }
  | { type: 'TOOL_ACTIVITY'; sessionId: string; activity: { toolName: string; description: string } }
  | { type: 'RESULT'; sessionId: string; costUsd: number; success: boolean; error?: string }
  | { type: 'CONTEXT_UPDATE'; sessionId: string; contextUsage: { inputTokens: number; outputTokens: number; contextWindow: number } }
  | { type: 'QUEUE_UPDATE'; sessionId: string; queue: QueuedMessage[] }
  | { type: 'RATE_LIMIT_UPDATE'; rateLimit: RateLimitInfo }
  | { type: 'CLAUDE_MD_APPLIED'; candidate: string }
  | { type: 'PROJECT_RUNS_SNAPSHOT'; runs: ProjectRun[] }
  | { type: 'PROJECT_RUN_UPDATE'; run: ProjectRun }
  | { type: 'PROJECT_RUN_REMOVED'; runId: string }
  | { type: 'PAUSE_UPDATE'; pauseUntil: string | null }
  | { type: 'PERMISSION_MODE_CHANGE'; sessionId: string; mode: PermissionMode }
  | { type: 'SESSION_RENAMED'; sessionId: string; newName: string }
  | { type: 'MODEL_CHANGED'; sessionId: string; model: string }
  | { type: 'EFFORT_CHANGED'; sessionId: string; effort: string | null }
  | { type: 'GOAL_UPDATED'; sessionId: string; goal: GoalState | null }
  | { type: 'NOTES_UPDATED'; sessionId: string; notes: string | null; notesUpdatedAt: string | null }
  | { type: 'CWD_CHANGED'; sessionId: string; cwd: string }
  | { type: 'PINNED_CHANGED'; sessionId: string; pinned: boolean }
  | { type: 'TAGS_CHANGED'; sessionId: string; tags: string[] }
  | { type: 'TAGS_REGISTRY'; tags: TagDef[] }
  | { type: 'UI_STATE'; state: UiState }
  | { type: 'UI_MARK_READ'; sessionId: string; at: string }
  | { type: 'UI_TAB_CLOSED'; sessionId: string; closedAt: number | null }
  | { type: 'UI_PIN_ORDER'; ids: string[] }
  | { type: 'MESSAGE_PINNED'; sessionId: string; messageId: string; pinned: boolean }
  | { type: 'MODEL_PLAN_UPDATED'; sessionId: string; plan: ModelPlan | null }
  | { type: 'ARCHIVE_STATUS'; sessionId: string; stage: string; message: string }
  | { type: 'ARCHIVE_COMPLETE'; sessionId: string; zipPath: string }
  | { type: 'SUMMARY_GENERATED'; sessionId: string; summary: string; summaryGeneratedAt: string }
  | { type: 'PERMISSION_REQUEST'; sessionId: string; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'PERMISSION_RESOLVED'; sessionId: string }
  | { type: 'PENDING_QUESTION'; sessionId: string; toolUseId: string; question: { question: string; header?: string; options?: { label: string; description?: string }[] } }
  | { type: 'QUESTION_RESOLVED'; sessionId: string; toolUseId: string }
  | { type: 'PENDING_PLAN'; sessionId: string; toolUseId: string; plan: string; messageId: string }
  | { type: 'PLAN_RESOLVED'; sessionId: string; toolUseId: string }
  | { type: 'SKILLS_LIST'; sessionId: string; skills: Skill[] }
  | { type: 'TOOL_RESULT'; sessionId: string; toolUseId: string; result: ToolResultInfo }
  | { type: 'DEBUG_LOG'; sessionId: string; entry: DebugLogEntry }
  | { type: 'WATCH_DEBUG_LOG'; sessionId: string | null }
  | { type: 'SESSION_DEBUG_LOG'; sessionId: string; entries: DebugLogEntry[] }
  | { type: 'WAKEUP_SCHEDULED'; sessionId: string; wakeup: PendingWakeup }
  | { type: 'WAKEUP_CLEARED'; sessionId: string }
  | { type: 'MONITORS_UPDATE'; sessionId: string; monitors: MonitorInfo[] }
  | { type: 'TRIGGERS_SNAPSHOT'; triggers: Trigger[] }
  | { type: 'TRIGGER_CREATED'; trigger: Trigger }
  | { type: 'TRIGGER_UPDATED'; trigger: Trigger }
  | { type: 'TRIGGER_DELETED'; triggerId: string }
  | { type: 'TRIGGER_FIRED'; trigger: Trigger }
  | { type: 'UPDATE_LAST_ACTIVE'; sessionId: string }
  | { type: 'ERROR'; sessionId: string; message: string }
  | { type: 'SET_ACTIVE_SESSION'; sessionId: string | null }
  | { type: 'WS_CONNECTED'; connected: boolean }
  | { type: 'DISCOVERED_SESSIONS'; sessions: DiscoveredSession[] }
  | { type: 'SET_SHOW_DISCOVERY'; show: boolean }
  | { type: 'SET_DISCOVERY_LOADING'; loading: boolean }
  | { type: 'AUTH_RESTORED' }
  | { type: 'THREADS_UPDATE'; sessionId: string; threads: SessionState['threads']; activeThreadId: string; activeThreadName: string | null };

function updateSession(
  sessions: Map<string, SessionState>,
  sessionId: string,
  updater: (session: SessionState) => SessionState,
): Map<string, SessionState> {
  const session = sessions.get(sessionId);
  if (!session) return sessions;
  const next = new Map(sessions);
  next.set(sessionId, updater(session));
  return next;
}

// Caps how much chat history the browser keeps in memory / renders per session. Without
// this, a long-lived session (or a long-lived browser tab that's never reloaded) grows
// `messages` forever, which slows down the DOM (MessageList renders every entry) and the
// tab's memory footprint. Server-side history is unaffected — this only trims client state.
const MAX_MESSAGES_IN_MEMORY = 400;

function appendMessage(messages: UIMessage[], msg: UIMessage): UIMessage[] {
  return trimMessages([...messages, msg], MAX_MESSAGES_IN_MEMORY);
}

/** Debug logs are held only for the session whose Debug tab is open (debugSessionId), which
 *  fetches its own. A server from before that change still sends every session's log in the
 *  session list; drop those, keeping whatever the open tab already has. */
function withoutDebugLog(s: SessionState, state: AppState): SessionState {
  if (s.id === state.debugSessionId) return { ...s, debugLog: state.sessions.get(s.id)?.debugLog ?? [] };
  return s.debugLog?.length ? { ...s, debugLog: [] } : s;
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SESSIONS_LIST': {
      const sessions = new Map<string, SessionState>();
      // Rebuild the plan-banner map from the snapshot so a pending plan survives WS reconnects
      // (mobile drops/reconnects constantly). Without this, pendingPlans is driven only by the
      // one-shot PENDING_PLAN event and a client that connected late/reconnected shows no banner.
      const pendingPlans = new Map(state.pendingPlans);
      for (const s of action.sessions) {
        sessions.set(s.id, withoutDebugLog(s, state));
        if (s.pendingPlan) {
          pendingPlans.set(s.id, s.pendingPlan);
        } else {
          pendingPlans.delete(s.id);
        }
      }
      return { ...state, sessions, pendingPlans };
    }

    case 'SESSION_CREATED': {
      const sessions = new Map(state.sessions);
      sessions.set(action.session.id, withoutDebugLog(action.session, state));
      return { ...state, sessions };
    }

    case 'SESSION_DESTROYED': {
      const sessions = new Map(state.sessions);
      sessions.delete(action.sessionId);
      const activeSessionId = state.activeSessionId === action.sessionId ? null : state.activeSessionId;
      return { ...state, sessions, activeSessionId };
    }

    case 'STATE_CHANGE': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          status: action.status as SessionState['status'],
          error: action.error || null,
          waitingFor: action.waitingFor !== undefined ? (action.waitingFor ?? null) : s.waitingFor,
          currentToolActivity: action.status === 'idle' ? null : s.currentToolActivity,
          lastActiveAt: new Date().toISOString(),
        })),
      };
    }

    case 'USER_MESSAGE_ECHO': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          messages: appendMessage(s.messages, {
            id: action.messageId,
            role: 'user' as const,
            content: action.text,
            images: action.images,
            files: action.files,
            author: action.author,
            timestamp: new Date().toISOString(),
          }),
        })),
      };
    }

    case 'ASSISTANT_MESSAGE': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => {
          // Replace streaming message with final message, or add new
          const existingIdx = s.messages.findIndex(m => m.id === action.messageId);
          const msg: UIMessage = {
            id: action.messageId,
            role: 'assistant',
            content: action.text,
            thinking: action.thinking,
            toolUses: action.toolUses,
            images: action.images,
            timestamp: new Date().toISOString(),
          };
          if (existingIdx >= 0) {
            const messages = [...s.messages];
            messages[existingIdx] = msg;
            return { ...s, messages };
          }
          return { ...s, messages: appendMessage(s.messages, msg) };
        }),
      };
    }

    case 'ASSISTANT_STREAM_DELTA': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => {
          const existingIdx = s.messages.findIndex(m => m.id === action.messageId);
          if (existingIdx >= 0) {
            const messages = [...s.messages];
            messages[existingIdx] = {
              ...messages[existingIdx],
              content: messages[existingIdx].content + action.delta,
              isStreaming: true,
            };
            return { ...s, messages };
          }
          // New streaming message
          return {
            ...s,
            messages: appendMessage(s.messages, {
              id: action.messageId,
              role: 'assistant' as const,
              content: action.delta,
              timestamp: new Date().toISOString(),
              isStreaming: true,
            }),
          };
        }),
      };
    }

    case 'TOOL_ACTIVITY': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          currentToolActivity: action.activity,
          lastActiveAt: new Date().toISOString(),
        })),
      };
    }

    case 'RESULT': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          totalCostUsd: action.costUsd,
          lastActiveAt: new Date().toISOString(),
        })),
      };
    }

    case 'CONTEXT_UPDATE': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          contextUsage: action.contextUsage,
        })),
      };
    }

    case 'QUEUE_UPDATE': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          queuedMessages: action.queue,
        })),
      };
    }

    case 'RATE_LIMIT_UPDATE':
      return { ...state, rateLimit: action.rateLimit };

    case 'CLAUDE_MD_APPLIED':
      return { ...state, appliedClaudeMd: new Set(state.appliedClaudeMd).add(action.candidate) };

    case 'PROJECT_RUNS_SNAPSHOT': {
      const projectRuns = new Map<string, ProjectRun>();
      for (const run of action.runs) projectRuns.set(run.id, run);
      return { ...state, projectRuns };
    }

    case 'PROJECT_RUN_UPDATE': {
      const projectRuns = new Map(state.projectRuns);
      projectRuns.set(action.run.id, action.run);
      return { ...state, projectRuns };
    }

    case 'PROJECT_RUN_REMOVED': {
      const projectRuns = new Map(state.projectRuns);
      projectRuns.delete(action.runId);
      return { ...state, projectRuns };
    }

    case 'PAUSE_UPDATE':
      return { ...state, pauseUntil: action.pauseUntil };

    case 'PERMISSION_MODE_CHANGE': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          permissionMode: action.mode,
        })),
      };
    }

    case 'SESSION_RENAMED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          config: { ...s.config, name: action.newName },
        })),
      };
    }

    case 'MODEL_CHANGED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          config: { ...s.config, model: action.model || undefined },
        })),
      };
    }

    case 'EFFORT_CHANGED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          config: { ...s.config, effort: (action.effort || undefined) as any },
        })),
      };
    }

    case 'GOAL_UPDATED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          config: { ...s.config, goal: action.goal },
        })),
      };
    }

    case 'NOTES_UPDATED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          notes: action.notes,
          notesUpdatedAt: action.notesUpdatedAt,
        })),
      };
    }

    case 'CWD_CHANGED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          config: { ...s.config, cwd: action.cwd },
        })),
      };
    }

    case 'SESSION_HISTORY': {
      // Full history for a session just opened — the bulk list only carried its recent messages.
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({ ...s, messages: action.messages })),
      };
    }

    case 'PINNED_CHANGED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          config: { ...s.config, pinned: action.pinned },
        })),
      };
    }

    case 'TAGS_CHANGED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          config: { ...s.config, tags: action.tags },
        })),
      };
    }

    case 'TAGS_REGISTRY': {
      return { ...state, tags: action.tags };
    }

    case 'UI_STATE':
      return { ...state, uiState: action.state, uiSynced: true };

    case 'UI_MARK_READ':
      return { ...state, uiState: { ...state.uiState, readAt: { ...state.uiState.readAt, [action.sessionId]: action.at } } };

    case 'UI_TAB_CLOSED': {
      const closedTabs = { ...state.uiState.closedTabs };
      if (action.closedAt === null) delete closedTabs[action.sessionId];
      else closedTabs[action.sessionId] = action.closedAt;
      return { ...state, uiState: { ...state.uiState, closedTabs } };
    }

    case 'UI_PIN_ORDER':
      return { ...state, uiState: { ...state.uiState, pinOrder: action.ids } };

    case 'MESSAGE_PINNED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          messages: s.messages.map(m => m.id === action.messageId ? { ...m, pinned: action.pinned } : m),
        })),
      };
    }

    case 'MODEL_PLAN_UPDATED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          config: { ...s.config, modelPlan: action.plan },
        })),
      };
    }

    case 'ARCHIVE_STATUS': {
      const archiveStatus = new Map(state.archiveStatus);
      archiveStatus.set(action.sessionId, { stage: action.stage, message: action.message });
      return { ...state, archiveStatus };
    }

    case 'ARCHIVE_COMPLETE': {
      const archiveStatus = new Map(state.archiveStatus);
      archiveStatus.set(action.sessionId, { stage: 'done', message: action.zipPath });
      return { ...state, archiveStatus };
    }

    case 'SUMMARY_GENERATED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          summary: action.summary,
          summaryGeneratedAt: action.summaryGeneratedAt,
        })),
      };
    }

    case 'PERMISSION_REQUEST': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          pendingPermission: { toolUseId: action.toolUseId, toolName: action.toolName, input: action.input },
        })),
      };
    }

    case 'PERMISSION_RESOLVED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          pendingPermission: null,
        })),
      };
    }

    case 'PENDING_QUESTION': {
      const pq = new Map(state.pendingQuestions);
      pq.set(action.sessionId, {
        toolUseId: action.toolUseId,
        question: action.question.question,
        header: action.question.header,
        options: action.question.options,
      });
      return { ...state, pendingQuestions: pq };
    }

    case 'QUESTION_RESOLVED': {
      const pq = new Map(state.pendingQuestions);
      pq.delete(action.sessionId);
      return { ...state, pendingQuestions: pq };
    }

    case 'PENDING_PLAN': {
      const pp = new Map(state.pendingPlans);
      pp.set(action.sessionId, {
        toolUseId: action.toolUseId,
        plan: action.plan,
        messageId: action.messageId,
      });
      return { ...state, pendingPlans: pp };
    }

    case 'PLAN_RESOLVED': {
      const pp = new Map(state.pendingPlans);
      pp.delete(action.sessionId);
      return { ...state, pendingPlans: pp };
    }

    case 'SKILLS_LIST': {
      // Server re-broadcasts on every WS reconnect; if nothing changed, skip the Map churn.
      const prev = state.sessionSkills.get(action.sessionId);
      if (prev && prev.length === action.skills.length &&
          prev.every((s, i) => s.name === action.skills[i].name && s.source === action.skills[i].source)) {
        return state;
      }
      const ss = new Map(state.sessionSkills);
      ss.set(action.sessionId, action.skills);
      return { ...state, sessionSkills: ss };
    }

    case 'TOOL_RESULT': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          messages: s.messages.map((m) => {
            if (!m.toolUses) return m;
            const idx = m.toolUses.findIndex((tu) => tu.id === action.toolUseId);
            if (idx < 0) return m;
            const toolUses = [...m.toolUses];
            toolUses[idx] = { ...toolUses[idx], result: action.result };
            return { ...m, toolUses };
          }),
        })),
      };
    }

    case 'DEBUG_LOG': {
      // Only the session with its Debug tab open keeps a log. Returning the same state for the
      // rest (about one entry a second while sessions work) means they cost no re-render.
      if (action.sessionId !== state.debugSessionId) return state;
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => {
          const debugLog = [...s.debugLog, action.entry];
          if (debugLog.length > 500) debugLog.splice(0, debugLog.length - 500);
          return { ...s, debugLog };
        }),
      };
    }

    case 'SHARES_SNAPSHOT':
      return { ...state, shares: action.shares, shareBaseUrl: action.baseUrl };

    case 'GUEST_INFO':
      return { ...state, guest: { sessionId: action.sessionId, guestName: action.guestName } };

    case 'ACCESS_DENIED':
      return { ...state, accessDenied: true };

    case 'WATCH_DEBUG_LOG': {
      if (action.sessionId === state.debugSessionId) return state;
      // Free the log of the tab being left; the new one arrives as SESSION_DEBUG_LOG.
      const prev = state.debugSessionId;
      const sessions = prev
        ? updateSession(state.sessions, prev, (s) => (s.debugLog.length ? { ...s, debugLog: [] } : s))
        : state.sessions;
      return { ...state, sessions, debugSessionId: action.sessionId };
    }

    case 'SESSION_DEBUG_LOG': {
      if (action.sessionId !== state.debugSessionId) return state;
      return { ...state, sessions: updateSession(state.sessions, action.sessionId, (s) => ({ ...s, debugLog: action.entries })) };
    }

    case 'WAKEUP_SCHEDULED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          pendingWakeup: action.wakeup,
        })),
      };
    }

    case 'WAKEUP_CLEARED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          pendingWakeup: null,
        })),
      };
    }

    // Rename/discard patch the thread list without a full session replace — park/resume
    // instead ride 'session_created' (SESSION_CREATED above), which already swaps in the
    // whole session wholesale (messages, activeThreadId, threads, etc.).
    case 'THREADS_UPDATE': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          threads: action.threads,
          activeThreadId: action.activeThreadId,
          activeThreadName: action.activeThreadName,
        })),
      };
    }

    case 'MONITORS_UPDATE': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          monitors: action.monitors,
        })),
      };
    }

    case 'TRIGGERS_SNAPSHOT': {
      const triggers = new Map<string, Trigger>();
      for (const t of action.triggers) triggers.set(t.id, t);
      return { ...state, triggers };
    }

    case 'TRIGGER_CREATED':
    case 'TRIGGER_UPDATED':
    case 'TRIGGER_FIRED': {
      const triggers = new Map(state.triggers);
      triggers.set(action.trigger.id, action.trigger);
      return { ...state, triggers };
    }

    case 'TRIGGER_DELETED': {
      const triggers = new Map(state.triggers);
      triggers.delete(action.triggerId);
      return { ...state, triggers };
    }

    case 'UPDATE_LAST_ACTIVE': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          lastActiveAt: new Date().toISOString(),
        })),
      };
    }

    case 'ERROR': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          error: action.message,
        })),
      };
    }

    case 'SET_ACTIVE_SESSION':
      return { ...state, activeSessionId: action.sessionId };

    case 'WS_CONNECTED':
      return { ...state, wsConnected: action.connected };

    case 'DISCOVERED_SESSIONS':
      return { ...state, discoveredSessions: action.sessions, discoveryLoading: false };

    case 'SET_SHOW_DISCOVERY':
      return { ...state, showDiscovery: action.show };

    case 'SET_DISCOVERY_LOADING':
      return { ...state, discoveryLoading: action.loading };

    case 'AUTH_RESTORED': {
      // Clear AUTH_EXPIRED error from all sessions so they return to idle
      const sessions = new Map(state.sessions);
      for (const [id, s] of sessions) {
        if (s.error === 'AUTH_EXPIRED') {
          sessions.set(id, { ...s, status: 'idle', error: null });
        }
      }
      return { ...state, sessions };
    }

    default:
      return state;
  }
}

// Context
interface SessionContextValue {
  state: AppState;
  createSession: (config: SessionConfig, opts?: { projectFolder?: string }) => void;
  sendMessage: (sessionId: string, message: string, images?: ImageAttachment[], planMode?: boolean, files?: FileAttachment[], model?: string, effort?: string) => void;
  respondToPlan: (sessionId: string, toolUseId: string, decision: 'accept' | 'reject', feedback?: string) => void;
  refreshSkills: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;
  /** Snapshot the live thread into the parked list and start a fresh conversation. See
   *  TaskSelector — parking/resuming never spawns the CLI, so this
   *  is purely bookkeeping (no quota cost). */
  parkThread: (sessionId: string, name?: string) => void;
  /** Swap a parked thread back in as the live one (server parks whatever's currently live
   *  first, if it has any content). */
  resumeThread: (sessionId: string, threadId: string) => void;
  discardThread: (sessionId: string, threadId: string) => void;
  /** Rename a thread — pass the session's activeThreadId to rename the live thread. */
  renameThread: (sessionId: string, threadId: string, name: string) => void;
  /** Task selector's "New task": park the current task and start a named one on its own model. */
  startTask: (sessionId: string, name: string, model?: string, effort?: string) => void;
  destroySession: (sessionId: string) => void;
  interruptSession: (sessionId: string) => void;
  compactSession: (sessionId: string) => void;
  resetSession: (sessionId: string) => void;
  setActiveSession: (sessionId: string | null) => void;
  discoverSessions: () => void;
  resumeDiscovered: (sdkSessionId: string, name: string, projectPath: string) => void;
  setShowDiscovery: (show: boolean) => void;
  pauseSessions: (pauseUntil: string) => void;
  resumeSessions: () => void;
  resetRateLimit: () => void;
  restartServer: () => Promise<void>;
  stopModelPlan: (sessionId: string) => void;
  stopMonitor: (sessionId: string, monitorId: string) => void;
  archiveSession: (sessionId: string) => void;
  createProjectRun: (input: { name: string; repoPath: string; goal: string; budget?: RunBudget; executorModel?: string }) => void;
  approveProjectRun: (runId: string, opts?: { budget?: RunBudget; verifyCommands?: string[] }) => void;
  cancelProjectRun: (runId: string) => void;
  updateLastActive: (sessionId: string) => void;
  setPermissionMode: (sessionId: string, mode: PermissionMode) => void;
  renameSession: (sessionId: string, newName: string) => void;
  updateCwd: (sessionId: string, cwd: string) => void;
  setPinned: (sessionId: string, pinned: boolean) => void;
  /** Pull a session's full history; the session list only carries its recent messages. */
  requestHistory: (sessionId: string) => void;
  setTags: (sessionId: string, tags: string[]) => void;
  /** Mark a session read — on every device once synced. A no-op when nothing is new. */
  markSessionRead: (sessionId: string) => void;
  /** Whether a session has activity newer than its last read (on any device, once synced). */
  isUnread: (session: SessionState) => boolean;
  setTabClosed: (sessionId: string, closed: boolean) => void;
  setPinOrder: (ids: string[]) => void;
  createTag: (label: string, color: string) => void;
  updateTag: (id: string, patch: { label?: string; color?: string }) => void;
  deleteTag: (id: string) => void;
  pinMessage: (sessionId: string, messageId: string, pinned: boolean) => void;
  setModel: (sessionId: string, model: string) => void;
  setEffort: (sessionId: string, effort: string) => void;
  setGoal: (sessionId: string, goal: { text: string; checkEveryMin?: number; deadlineHours?: number; maxNudges?: number } | null) => void;
  setNotes: (sessionId: string, notes: string | null) => void;
  generateSummary: (sessionId: string) => void;
  respondToPermission: (sessionId: string, toolUseId: string, decision: 'allow' | 'deny', message?: string) => void;
  respondToQuestion: (sessionId: string, toolUseId: string, answer: string) => void;
  dequeueMessage: (sessionId: string, index: number) => void;
  cancelWakeup: (sessionId: string) => void;
  applyClaudeMdCandidate: (sessionId: string, candidate: string) => void;
  /** Open (sessionId) or close (null) a session's Debug tab: fetches its log and keeps it live
   *  while open; closing frees it. */
  watchDebugLog: (sessionId: string | null) => void;
  /** Share links: one session with one named guest on the local network, until revoked. */
  createShare: (sessionId: string, guestName: string, rules: string) => void;
  updateShare: (id: string, patch: { guestName?: string; rules?: string }) => void;
  revokeShare: (id: string) => void;
  logEvent: (feature: string, detail?: Record<string, string | number | boolean>) => void;
  // --- Global search (Cmd/Ctrl+K) — UI-only state, not part of the reducer/server snapshot ---
  showSearch: boolean;
  openSearch: () => void;
  closeSearch: () => void;
  /** Set by requestScrollTo; SessionView watches this and scrolls/highlights the matching
   *  message, then clears it via setScrollToMessageId(null). */
  scrollToMessageId: string | null;
  setScrollToMessageId: (id: string | null) => void;
  /** Navigates to the session, then arms scrollToMessageId — used by search's session hits. */
  requestScrollTo: (sessionId: string, messageId: string | undefined) => void;
  /** Appends text to a session's in-progress compose draft (e.g. "Insert path" from search).
   *  Drafts themselves live outside this context (App.tsx's draftsRef, read by PromptInput's
   *  own local state) — this is a one-shot signal PromptInput listens for and applies while
   *  mounted, since there's no other live channel into that per-session ref. */
  appendToDraft: (sessionId: string, text: string) => void;
  draftAppend: { sessionId: string; text: string; nonce: number } | null;
}

/** The parts of the context that change. Everything else is an action with a stable identity. */
type SessionStateKey = 'state' | 'isUnread' | 'showSearch' | 'scrollToMessageId' | 'draftAppend';
type SessionStateValue = Pick<SessionContextValue, SessionStateKey>;
export type SessionActions = Omit<SessionContextValue, SessionStateKey>;

const SessionStateContext = createContext<SessionStateValue | null>(null);
const SessionActionsContext = createContext<SessionActions | null>(null);
/** The tag registry on its own: session cards read it for their chips and color bar, and it only
 *  changes when tags are edited. */
const SessionTagsContext = createContext<TagDef[]>([]);

/** `shareToken` makes this a share-link page: one connection, scoped by the server to one session. */
export function SessionProvider({ children, shareToken }: { children: React.ReactNode; shareToken?: string }) {
  const [state, dispatch] = useReducer(reducer, {
    sessions: new Map(),
    activeSessionId: null,
    wsConnected: false,
    discoveredSessions: [],
    showDiscovery: false,
    discoveryLoading: false,
    rateLimit: null,
    pauseUntil: null,
    pendingQuestions: new Map(),
    pendingPlans: new Map(),
    triggers: new Map(),
    tags: [],
    uiState: { readAt: {}, closedTabs: {}, pinOrder: [] },
    uiSynced: false,
    sessionSkills: new Map(),
    appliedClaudeMd: new Set<string>(),
    projectRuns: new Map(),
    archiveStatus: new Map(),
    debugSessionId: null,
    shares: [],
    shareBaseUrl: null,
    guest: null,
    accessDenied: false,
  // This browser's own copy until the server syncs — see lib/uiStateLocal.ts.
  }, (init) => ({ ...init, uiState: loadLocalUiState() }));

  const wsRef = useRef<WsClient | null>(null);

  // Keep latest state accessible from the WS handler without retriggering useCallback
  const stateRef = useRef(state);
  // Until the server syncs view state, this browser's copy is the only copy — keep it saved.
  useEffect(() => {
    if (!state.uiSynced) saveLocalUiState(state.uiState);
  }, [state.uiState, state.uiSynced]);
  useEffect(() => { stateRef.current = state; }, [state]);

  // Track previous status per session so we only notify on transitions into error
  const prevStatusRef = useRef<Map<string, string>>(new Map());

  const sessionName = (sessionId: string): string => {
    return stateRef.current.sessions.get(sessionId)?.config.name || 'Session';
  };

  const handleWsMessage = useCallback((msg: WsOutboundMessage) => {
    switch (msg.type) {
      case 'sessions_list':
        dispatch({ type: 'SESSIONS_LIST', sessions: msg.sessions });
        break;
      case 'session_created':
        dispatch({ type: 'SESSION_CREATED', session: msg.session });
        break;
      case 'session_destroyed':
        dispatch({ type: 'SESSION_DESTROYED', sessionId: msg.sessionId });
        break;
      case 'state_change': {
        const prev = prevStatusRef.current.get(msg.sessionId);
        prevStatusRef.current.set(msg.sessionId, msg.status);
        dispatch({ type: 'STATE_CHANGE', sessionId: msg.sessionId, status: msg.status, error: msg.error, waitingFor: msg.waitingFor });
        // Notify on entering error state (not for repeated 'error' broadcasts)
        if (msg.status === 'error' && prev !== 'error') {
          const errText = msg.error === 'AUTH_EXPIRED'
            ? 'Claude authentication expired'
            : msg.error || 'Session errored';
          notify({
            title: `❗ ${sessionName(msg.sessionId)}`,
            body: errText,
            sessionId: msg.sessionId,
            tag: `error-${msg.sessionId}`,
          });
        }
        break;
      }
      case 'user_message_echo':
        dispatch({ type: 'USER_MESSAGE_ECHO', sessionId: msg.sessionId, messageId: msg.messageId, text: msg.text, images: msg.images, files: msg.files, author: msg.author });
        break;
      case 'assistant_message':
        dispatch({ type: 'ASSISTANT_MESSAGE', sessionId: msg.sessionId, messageId: msg.messageId, text: msg.text, thinking: msg.thinking, toolUses: msg.toolUses, images: msg.images });
        break;
      case 'assistant_message_stream':
        dispatch({ type: 'ASSISTANT_STREAM_DELTA', sessionId: msg.sessionId, messageId: msg.messageId, delta: msg.delta });
        break;
      case 'tool_activity':
        dispatch({ type: 'TOOL_ACTIVITY', sessionId: msg.sessionId, activity: msg.activity });
        break;
      case 'result':
        dispatch({ type: 'RESULT', sessionId: msg.sessionId, costUsd: msg.costUsd, success: msg.success, error: msg.error });
        break;
      case 'context_update':
        dispatch({ type: 'CONTEXT_UPDATE', sessionId: msg.sessionId, contextUsage: msg.contextUsage });
        break;
      case 'queue_update':
        dispatch({ type: 'QUEUE_UPDATE', sessionId: msg.sessionId, queue: msg.queue });
        break;
      case 'rate_limit_update':
        dispatch({ type: 'RATE_LIMIT_UPDATE', rateLimit: msg.rateLimit });
        break;
      case 'pause_update':
        dispatch({ type: 'PAUSE_UPDATE', pauseUntil: msg.pauseUntil });
        break;
      case 'permission_mode_change':
        dispatch({ type: 'PERMISSION_MODE_CHANGE', sessionId: msg.sessionId, mode: msg.mode });
        break;
      case 'session_renamed':
        dispatch({ type: 'SESSION_RENAMED', sessionId: msg.sessionId, newName: msg.newName });
        break;
      case 'model_changed':
        dispatch({ type: 'MODEL_CHANGED', sessionId: msg.sessionId, model: msg.model });
        break;
      case 'effort_changed':
        dispatch({ type: 'EFFORT_CHANGED', sessionId: msg.sessionId, effort: msg.effort });
        break;
      case 'goal_updated':
        dispatch({ type: 'GOAL_UPDATED', sessionId: msg.sessionId, goal: msg.goal });
        break;
      case 'notes_updated':
        dispatch({ type: 'NOTES_UPDATED', sessionId: msg.sessionId, notes: msg.notes, notesUpdatedAt: msg.notesUpdatedAt });
        break;
      case 'cwd_changed':
        dispatch({ type: 'CWD_CHANGED', sessionId: msg.sessionId, cwd: msg.cwd });
        break;
      case 'session_history':
        dispatch({ type: 'SESSION_HISTORY', sessionId: msg.sessionId, messages: msg.messages });
        break;
      case 'shares_snapshot':
        dispatch({ type: 'SHARES_SNAPSHOT', shares: msg.shares, baseUrl: msg.baseUrl });
        break;
      case 'guest_info':
        dispatch({ type: 'GUEST_INFO', sessionId: msg.sessionId, guestName: msg.guestName });
        break;
      case 'session_debug_log':
        dispatch({ type: 'SESSION_DEBUG_LOG', sessionId: msg.sessionId, entries: msg.entries });
        break;
      case 'pinned_changed':
        dispatch({ type: 'PINNED_CHANGED', sessionId: msg.sessionId, pinned: msg.pinned });
        break;
      case 'tags_changed':
        dispatch({ type: 'TAGS_CHANGED', sessionId: msg.sessionId, tags: msg.tags });
        break;
      case 'tags_registry':
        dispatch({ type: 'TAGS_REGISTRY', tags: msg.tags });
        break;
      case 'ui_state': {
        // First snapshot from a syncing server: fold in what this browser tracked on its own, once,
        // then drop the local copy. The server broadcasts the merged state straight back.
        const local = stateRef.current.uiSynced ? null : localUiStateToMerge();
        if (local) {
          wsRef.current?.send({ type: 'merge_ui_state', state: local });
          clearLocalUiState();
        }
        dispatch({ type: 'UI_STATE', state: msg.state });
        break;
      }
      case 'message_pinned':
        dispatch({ type: 'MESSAGE_PINNED', sessionId: msg.sessionId, messageId: msg.messageId, pinned: msg.pinned });
        break;
      case 'model_plan_updated':
        dispatch({ type: 'MODEL_PLAN_UPDATED', sessionId: msg.sessionId, plan: msg.plan });
        break;
      case 'archive_status':
        dispatch({ type: 'ARCHIVE_STATUS', sessionId: msg.sessionId, stage: msg.stage, message: msg.message });
        break;
      case 'archive_complete': {
        dispatch({ type: 'ARCHIVE_COMPLETE', sessionId: msg.sessionId, zipPath: msg.zipPath });
        // Session is already gone by the time this arrives (destroy happens before this
        // broadcast) — a brief notice with the zip filename, same mechanism as other
        // out-of-band events (permission/question), rather than inventing a new toast system.
        notify({
          title: '📦 Project archived',
          body: `Saved to ${msg.zipPath.split('/').pop()}`,
          sessionId: msg.sessionId,
          tag: `archive-${msg.sessionId}`,
        });
        break;
      }
      case 'summary_generated':
        dispatch({ type: 'SUMMARY_GENERATED', sessionId: msg.sessionId, summary: msg.summary, summaryGeneratedAt: msg.summaryGeneratedAt });
        break;
      case 'permission_request':
        dispatch({ type: 'PERMISSION_REQUEST', sessionId: msg.sessionId, toolUseId: msg.toolUseId, toolName: msg.toolName, input: msg.input });
        notify({
          title: `🔐 ${sessionName(msg.sessionId)}`,
          body: `Permission requested: ${msg.toolName}`,
          sessionId: msg.sessionId,
          tag: `perm-${msg.sessionId}`,
        });
        break;
      case 'permission_resolved':
        dispatch({ type: 'PERMISSION_RESOLVED', sessionId: msg.sessionId });
        break;
      case 'tool_result':
        dispatch({ type: 'TOOL_RESULT', sessionId: msg.sessionId, toolUseId: msg.toolUseId, result: msg.result });
        // If this tool result resolves a pending question, clear it
        dispatch({ type: 'QUESTION_RESOLVED', sessionId: msg.sessionId, toolUseId: msg.toolUseId });
        break;
      case 'pending_question':
        dispatch({ type: 'PENDING_QUESTION', sessionId: msg.sessionId, toolUseId: msg.toolUseId, question: msg.question });
        notify({
          title: `❓ ${sessionName(msg.sessionId)}`,
          body: msg.question.question || 'Claude is asking a question',
          sessionId: msg.sessionId,
          tag: `question-${msg.sessionId}`,
        });
        break;
      case 'question_resolved':
        dispatch({ type: 'QUESTION_RESOLVED', sessionId: msg.sessionId, toolUseId: msg.toolUseId });
        break;
      case 'debug_log':
        dispatch({ type: 'DEBUG_LOG', sessionId: msg.sessionId, entry: msg.entry });
        break;
      case 'wakeup_scheduled':
        dispatch({ type: 'WAKEUP_SCHEDULED', sessionId: msg.sessionId, wakeup: msg.wakeup });
        break;
      case 'wakeup_cleared':
        dispatch({ type: 'WAKEUP_CLEARED', sessionId: msg.sessionId });
        break;
      case 'monitors_update':
        dispatch({ type: 'MONITORS_UPDATE', sessionId: msg.sessionId, monitors: msg.monitors });
        break;
      case 'triggers_snapshot':
        dispatch({ type: 'TRIGGERS_SNAPSHOT', triggers: msg.triggers });
        break;
      case 'trigger_created':
        dispatch({ type: 'TRIGGER_CREATED', trigger: msg.trigger });
        break;
      case 'trigger_updated':
        dispatch({ type: 'TRIGGER_UPDATED', trigger: msg.trigger });
        break;
      case 'trigger_deleted':
        dispatch({ type: 'TRIGGER_DELETED', triggerId: msg.triggerId });
        break;
      case 'trigger_fired':
        dispatch({ type: 'TRIGGER_FIRED', trigger: msg.trigger });
        break;
      case 'claude_md_applied':
        // Server auto-applied (or confirmed a manual apply) — mark it so the banner shows "Applied".
        dispatch({ type: 'CLAUDE_MD_APPLIED', candidate: msg.candidate });
        break;
      case 'project_runs_snapshot':
        dispatch({ type: 'PROJECT_RUNS_SNAPSHOT', runs: msg.runs });
        break;
      case 'project_run_update':
        dispatch({ type: 'PROJECT_RUN_UPDATE', run: msg.run });
        break;
      case 'project_run_removed':
        dispatch({ type: 'PROJECT_RUN_REMOVED', runId: msg.runId });
        break;
      case 'pending_plan':
        dispatch({ type: 'PENDING_PLAN', sessionId: msg.sessionId, toolUseId: msg.toolUseId, plan: msg.plan, messageId: msg.messageId });
        break;
      case 'plan_resolved':
        dispatch({ type: 'PLAN_RESOLVED', sessionId: msg.sessionId, toolUseId: msg.toolUseId });
        break;
      case 'skills_list':
        dispatch({ type: 'SKILLS_LIST', sessionId: msg.sessionId, skills: msg.skills });
        break;
      case 'discovered_sessions':
        dispatch({ type: 'DISCOVERED_SESSIONS', sessions: msg.sessions });
        break;
      case 'error':
        dispatch({ type: 'ERROR', sessionId: msg.sessionId, message: msg.message });
        break;
      case 'auth_restored':
        dispatch({ type: 'AUTH_RESTORED' });
        break;
      case 'threads_update':
        dispatch({ type: 'THREADS_UPDATE', sessionId: msg.sessionId, threads: msg.threads, activeThreadId: msg.activeThreadId, activeThreadName: msg.activeThreadName });
        break;
    }
  }, []);

  useEffect(() => {
    const client = new WsClient(
      shareToken ? [buildGuestWsUrl(shareToken)] : buildWsCandidates(),
      handleWsMessage,
      (connected) => {
        dispatch({ type: 'WS_CONNECTED', connected });
        // An open Debug tab missed whatever was logged while disconnected — fetch it again.
        const debugSessionId = stateRef.current.debugSessionId;
        if (connected && debugSessionId) client.send({ type: 'request_debug_log', sessionId: debugSessionId });
      },
      // A share link that's revoked or invalid is closed with 4403: stop retrying and say so.
      (code) => {
        if (!shareToken || code !== 4403) return false;
        dispatch({ type: 'ACCESS_DENIED' });
        return true;
      },
    );
    client.connect();
    wsRef.current = client;
    return () => client.destroy();
  }, [handleWsMessage, shareToken]);

  const createSession = useCallback((config: SessionConfig, opts?: { projectFolder?: string }) => {
    wsRef.current?.send({ type: 'create_session', config, projectFolder: opts?.projectFolder });
  }, []);

  const sendMessage = useCallback((sessionId: string, message: string, images?: ImageAttachment[], planMode?: boolean, files?: FileAttachment[], model?: string, effort?: string) => {
    wsRef.current?.send({ type: 'send_message', sessionId, message, images, files, planMode, model, effort });
  }, []);

  const respondToPlanFn = useCallback((sessionId: string, toolUseId: string, decision: 'accept' | 'reject', feedback?: string) => {
    wsRef.current?.send({ type: 'plan_response', sessionId, toolUseId, decision, feedback });
  }, []);

  const refreshSkillsFn = useCallback((sessionId: string) => {
    wsRef.current?.send({ type: 'list_skills', sessionId });
  }, []);

  const clearSessionFn = useCallback((sessionId: string) => {
    wsRef.current?.send({ type: 'clear_session', sessionId });
  }, []);

  const parkThreadFn = useCallback((sessionId: string, name?: string) => {
    wsRef.current?.send({ type: 'park_thread', sessionId, name });
  }, []);

  const resumeThreadFn = useCallback((sessionId: string, threadId: string) => {
    wsRef.current?.send({ type: 'resume_thread', sessionId, threadId });
  }, []);

  const discardThreadFn = useCallback((sessionId: string, threadId: string) => {
    wsRef.current?.send({ type: 'discard_thread', sessionId, threadId });
  }, []);

  const startTaskFn = useCallback((sessionId: string, name: string, model?: string, effort?: string) => {
    wsRef.current?.send({ type: 'start_task', sessionId, name, model, effort });
  }, []);

  const renameThreadFn = useCallback((sessionId: string, threadId: string, name: string) => {
    wsRef.current?.send({ type: 'rename_thread', sessionId, threadId, name });
  }, []);

  const destroySession = useCallback((sessionId: string) => {
    wsRef.current?.send({ type: 'destroy_session', sessionId });
  }, []);

  const interruptSession = useCallback((sessionId: string) => {
    wsRef.current?.send({ type: 'interrupt_session', sessionId });
  }, []);

  const compactSession = useCallback((sessionId: string) => {
    wsRef.current?.send({ type: 'compact_session', sessionId });
  }, []);

  const resetSession = useCallback((sessionId: string) => {
    wsRef.current?.send({ type: 'reset_session', sessionId });
  }, []);

  const setActiveSession = useCallback((sessionId: string | null) => {
    dispatch({ type: 'SET_ACTIVE_SESSION', sessionId });
  }, []);

  // --- Global search UI state (Cmd/Ctrl+K) — plain useState, not the reducer: purely local
  // UI plumbing, never persisted or driven by WS events. ---
  const [showSearch, setShowSearch] = useState(false);
  const openSearch = useCallback(() => setShowSearch(true), []);
  const closeSearch = useCallback(() => setShowSearch(false), []);

  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null);
  const requestScrollTo = useCallback((sessionId: string, messageId: string | undefined) => {
    setActiveSession(sessionId);
    setScrollToMessageId(messageId ?? null);
  }, [setActiveSession]);

  const [draftAppend, setDraftAppend] = useState<{ sessionId: string; text: string; nonce: number } | null>(null);
  const draftAppendNonceRef = useRef(0);
  const appendToDraft = useCallback((sessionId: string, text: string) => {
    draftAppendNonceRef.current += 1;
    setDraftAppend({ sessionId, text, nonce: draftAppendNonceRef.current });
  }, []);

  const discoverSessionsFn = useCallback(() => {
    dispatch({ type: 'SET_DISCOVERY_LOADING', loading: true });
    wsRef.current?.send({ type: 'discover_sessions' });
  }, []);

  const resumeDiscovered = useCallback((sdkSessionId: string, name: string, projectPath: string) => {
    wsRef.current?.send({ type: 'resume_discovered', sdkSessionId, name, projectPath });
  }, []);

  const setShowDiscovery = useCallback((show: boolean) => {
    dispatch({ type: 'SET_SHOW_DISCOVERY', show });
  }, []);

  const pauseSessionsFn = useCallback((pauseUntil: string) => {
    wsRef.current?.send({ type: 'pause_sessions', pauseUntil });
  }, []);

  const resumeSessionsFn = useCallback(() => {
    wsRef.current?.send({ type: 'resume_sessions' });
  }, []);

  const resetRateLimitFn = useCallback(() => {
    wsRef.current?.send({ type: 'reset_rate_limit' });
  }, []);

  // Plain HTTP, not WS — the server process dies right after responding, so there's no
  // live WS connection to reply on anyway. The existing WsClient reconnect/host-rollover
  // logic (lib/ws-client.ts) picks the connection back up once the process is back.
  const restartServerFn = useCallback(async () => {
    await fetch('/api/restart-server', { method: 'POST' }).catch(() => { /* expected: process exits mid-response sometimes */ });
  }, []);

  const stopModelPlanFn = useCallback((sessionId: string) => {
    wsRef.current?.send({ type: 'stop_model_plan', sessionId });
  }, []);

  const stopMonitorFn = useCallback((sessionId: string, monitorId: string) => {
    wsRef.current?.send({ type: 'stop_monitor', sessionId, monitorId });
  }, []);

  const archiveSessionFn = useCallback((sessionId: string) => {
    wsRef.current?.send({ type: 'archive_session', sessionId });
  }, []);

  const createProjectRun = useCallback((input: { name: string; repoPath: string; goal: string; budget?: RunBudget; executorModel?: string }) => {
    wsRef.current?.send({ type: 'create_project_run', ...input });
  }, []);

  const approveProjectRun = useCallback((runId: string, opts?: { budget?: RunBudget; verifyCommands?: string[] }) => {
    wsRef.current?.send({ type: 'approve_project_run', runId, budget: opts?.budget, verifyCommands: opts?.verifyCommands });
  }, []);

  const cancelProjectRun = useCallback((runId: string) => {
    wsRef.current?.send({ type: 'cancel_project_run', runId });
  }, []);

  const updateLastActive = useCallback((sessionId: string) => {
    dispatch({ type: 'UPDATE_LAST_ACTIVE', sessionId });
  }, []);

  const setPermissionModeFn = useCallback((sessionId: string, mode: PermissionMode) => {
    wsRef.current?.send({ type: 'set_permission_mode', sessionId, mode });
  }, []);

  const renameSessionFn = useCallback((sessionId: string, newName: string) => {
    wsRef.current?.send({ type: 'rename_session', sessionId, newName });
  }, []);

  const updateCwdFn = useCallback((sessionId: string, cwd: string) => {
    wsRef.current?.send({ type: 'update_cwd', sessionId, cwd });
  }, []);

  // Generic feature-usage log for pure client-side navigation (tab switches, modal opens)
  // that never otherwise reaches the server. See shared/messages.ts for the wire shape.
  const logEvent = useCallback((feature: string, detail?: Record<string, string | number | boolean>) => {
    wsRef.current?.send({ type: 'log_event', feature, detail });
  }, []);

  const setPinnedFn = useCallback((sessionId: string, pinned: boolean) => {
    wsRef.current?.send({ type: 'set_pinned', sessionId, pinned });
  }, []);

  const pinMessageFn = useCallback((sessionId: string, messageId: string, pinned: boolean) => {
    wsRef.current?.send({ type: 'pin_message', sessionId, messageId, pinned });
  }, []);

  const requestHistory = useCallback((sessionId: string) => {
    wsRef.current?.send({ type: 'request_history', sessionId });
  }, []);

  // Optimistic: the change shows at once; once synced the server's snapshot (server clock) follows.
  // The optimistic times are nudged past the session's last activity so a phone whose clock runs
  // slow can't briefly re-show what was just read or closed.
  const markSessionReadFn = useCallback((sessionId: string) => {
    const st = stateRef.current;
    const s = st.sessions.get(sessionId);
    const lastRead = st.uiState.readAt[sessionId];
    if (s && lastRead && Date.parse(lastRead) >= Date.parse(s.lastActiveAt)) return; // nothing new
    const at = new Date(Math.max(Date.now(), s ? Date.parse(s.lastActiveAt) : 0)).toISOString();
    dispatch({ type: 'UI_MARK_READ', sessionId, at });
    if (st.uiSynced) wsRef.current?.send({ type: 'mark_read', sessionId });
  }, []);

  const isUnreadFn = useCallback((s: SessionState) => isSessionUnread(s, state.uiState.readAt), [state.uiState.readAt]);

  const setTabClosedFn = useCallback((sessionId: string, closed: boolean) => {
    const s = stateRef.current.sessions.get(sessionId);
    const closedAt = closed ? Math.max(Date.now(), s ? Date.parse(s.lastActiveAt) + 1 : 0) : null;
    dispatch({ type: 'UI_TAB_CLOSED', sessionId, closedAt });
    if (stateRef.current.uiSynced) wsRef.current?.send({ type: 'set_tab_closed', sessionId, closed });
  }, []);

  const setPinOrderFn = useCallback((ids: string[]) => {
    dispatch({ type: 'UI_PIN_ORDER', ids });
    if (stateRef.current.uiSynced) wsRef.current?.send({ type: 'set_pin_order', ids });
  }, []);

  const setTagsFn = useCallback((sessionId: string, tags: string[]) => {
    wsRef.current?.send({ type: 'set_tags', sessionId, tags });
  }, []);

  const createTagFn = useCallback((label: string, color: string) => {
    wsRef.current?.send({ type: 'create_tag', label, color });
  }, []);

  const updateTagFn = useCallback((id: string, patch: { label?: string; color?: string }) => {
    wsRef.current?.send({ type: 'update_tag', id, ...patch });
  }, []);

  const deleteTagFn = useCallback((id: string) => {
    wsRef.current?.send({ type: 'delete_tag', id });
  }, []);

  const setModelFn = useCallback((sessionId: string, model: string) => {
    wsRef.current?.send({ type: 'set_model', sessionId, model });
  }, []);

  const setEffortFn = useCallback((sessionId: string, effort: string) => {
    wsRef.current?.send({ type: 'set_effort', sessionId, effort });
  }, []);

  const setGoalFn = useCallback((sessionId: string, goal: { text: string; checkEveryMin?: number; deadlineHours?: number; maxNudges?: number } | null) => {
    wsRef.current?.send({ type: 'set_goal', sessionId, goal });
  }, []);

  const setNotesFn = useCallback((sessionId: string, notes: string | null) => {
    wsRef.current?.send({ type: 'set_notes', sessionId, notes });
  }, []);

  const generateSummaryFn = useCallback((sessionId: string) => {
    wsRef.current?.send({ type: 'generate_summary', sessionId });
  }, []);

  const respondToPermissionFn = useCallback((sessionId: string, toolUseId: string, decision: 'allow' | 'deny', message?: string) => {
    wsRef.current?.send({ type: 'permission_response', sessionId, toolUseId, decision, message });
  }, []);

  const respondToQuestionFn = useCallback((sessionId: string, toolUseId: string, answer: string) => {
    wsRef.current?.send({ type: 'question_response', sessionId, toolUseId, answer });
    dispatch({ type: 'QUESTION_RESOLVED', sessionId, toolUseId });
  }, []);

  const dequeueMessageFn = useCallback((sessionId: string, index: number) => {
    wsRef.current?.send({ type: 'dequeue_message', sessionId, index });
  }, []);

  const cancelWakeupFn = useCallback((sessionId: string) => {
    wsRef.current?.send({ type: 'cancel_wakeup', sessionId });
  }, []);

  const applyClaudeMdCandidateFn = useCallback((sessionId: string, candidate: string) => {
    wsRef.current?.send({ type: 'apply_claude_md_candidate', sessionId, candidate });
  }, []);

  const createShareFn = useCallback((sessionId: string, guestName: string, rules: string) => {
    wsRef.current?.send({ type: 'create_share', sessionId, guestName, rules });
  }, []);
  const updateShareFn = useCallback((id: string, patch: { guestName?: string; rules?: string }) => {
    wsRef.current?.send({ type: 'update_share', id, ...patch });
  }, []);
  const revokeShareFn = useCallback((id: string) => {
    wsRef.current?.send({ type: 'revoke_share', id });
  }, []);

  const watchDebugLogFn = useCallback((sessionId: string | null) => {
    dispatch({ type: 'WATCH_DEBUG_LOG', sessionId });
    if (sessionId) wsRef.current?.send({ type: 'request_debug_log', sessionId });
  }, []);

  // Two contexts, so a component can subscribe to the actions alone. `state` changes on every WS
  // message; the actions never do (useCallback over refs and dispatch), so a component drawn once
  // per chat message or per session card that only acts no longer re-renders on every message.
  // Before the split, each message re-rendered every chat bubble and re-parsed its markdown (~27 ms
  // per message in a 450-message session). Keep new actions stable: read state via stateRef.
  const actionList: SessionActions = {
    createSession,
    sendMessage,
    destroySession,
    interruptSession,
    compactSession,
    resetSession,
    setActiveSession,
    discoverSessions: discoverSessionsFn,
    resumeDiscovered,
    setShowDiscovery,
    pauseSessions: pauseSessionsFn,
    resumeSessions: resumeSessionsFn,
    resetRateLimit: resetRateLimitFn,
    restartServer: restartServerFn,
    stopModelPlan: stopModelPlanFn,
    stopMonitor: stopMonitorFn,
    archiveSession: archiveSessionFn,
    createProjectRun,
    approveProjectRun,
    cancelProjectRun,
    updateLastActive,
    setPermissionMode: setPermissionModeFn,
    renameSession: renameSessionFn,
    updateCwd: updateCwdFn,
    setPinned: setPinnedFn,
    requestHistory,
    setTags: setTagsFn,
    markSessionRead: markSessionReadFn,
    setTabClosed: setTabClosedFn,
    setPinOrder: setPinOrderFn,
    createTag: createTagFn,
    updateTag: updateTagFn,
    deleteTag: deleteTagFn,
    logEvent,
    pinMessage: pinMessageFn,
    setModel: setModelFn,
    setEffort: setEffortFn,
    setGoal: setGoalFn,
    setNotes: setNotesFn,
    generateSummary: generateSummaryFn,
    respondToPermission: respondToPermissionFn,
    respondToQuestion: respondToQuestionFn,
    dequeueMessage: dequeueMessageFn,
    cancelWakeup: cancelWakeupFn,
    applyClaudeMdCandidate: applyClaudeMdCandidateFn,
    respondToPlan: respondToPlanFn,
    refreshSkills: refreshSkillsFn,
    clearSession: clearSessionFn,
    parkThread: parkThreadFn,
    resumeThread: resumeThreadFn,
    discardThread: discardThreadFn,
    renameThread: renameThreadFn,
    startTask: startTaskFn,
    openSearch,
    closeSearch,
    setScrollToMessageId,
    requestScrollTo,
    appendToDraft,
    watchDebugLog: watchDebugLogFn,
    createShare: createShareFn,
    updateShare: updateShareFn,
    revokeShare: revokeShareFn,
  };
  // The same object for as long as every action keeps its identity, which they all do.
  const actions = useMemo(() => actionList, Object.values(actionList)); // eslint-disable-line react-hooks/exhaustive-deps
  const stateValue = useMemo<SessionStateValue>(
    () => ({ state, isUnread: isUnreadFn, showSearch, scrollToMessageId, draftAppend }),
    [state, isUnreadFn, showSearch, scrollToMessageId, draftAppend],
  );

  return (
    <SessionActionsContext.Provider value={actions}>
      <SessionStateContext.Provider value={stateValue}>
        <SessionTagsContext.Provider value={state.tags}>
          {children}
        </SessionTagsContext.Provider>
      </SessionStateContext.Provider>
    </SessionActionsContext.Provider>
  );
}

/** State plus actions. Re-renders on every WS message — components drawn once per chat message or
 *  per session card should use useSessionActions() instead and take what they read as props. */
export function useSessions(): SessionContextValue {
  const stateValue = useContext(SessionStateContext);
  const actions = useContext(SessionActionsContext);
  const merged = useMemo(() => (stateValue && actions ? { ...actions, ...stateValue } : null), [stateValue, actions]);
  if (!merged) throw new Error('useSessions must be used within SessionProvider');
  return merged;
}

/** The actions alone. Stable, so a consumer re-renders only when its own props change. */
export function useSessionActions(): SessionActions {
  const actions = useContext(SessionActionsContext);
  if (!actions) throw new Error('useSessionActions must be used within SessionProvider');
  return actions;
}

/** The tag registry alone, for per-card chips and colors. */
export function useTagRegistry(): TagDef[] {
  return useContext(SessionTagsContext);
}
