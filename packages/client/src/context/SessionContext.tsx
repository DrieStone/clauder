import React, { createContext, useContext, useReducer, useCallback, useEffect, useRef } from 'react';
import type { SessionState, SessionConfig, DiscoveredSession, WsOutboundMessage, UIMessage, RateLimitInfo, PermissionMode, ImageAttachment, QueuedMessage, ToolResultInfo, DebugLogEntry, PendingWakeup, Trigger, Skill, ProjectRun, RunBudget } from '@clauder/shared';
import { WsClient } from '../lib/ws-client';
import { notify } from '../lib/notifications';

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
  /** Skill list per session: sessionId -> skills available in that session's cwd */
  sessionSkills: Map<string, Skill[]>;
  /** CLAUDE.md candidates already written (auto-applied by the server or applied manually),
   *  by candidate text — so the banner shows "Applied" without a click. */
  appliedClaudeMd: Set<string>;
  /** Overnight Project Runner runs, keyed by run id. */
  projectRuns: Map<string, ProjectRun>;
}

// Actions
type Action =
  | { type: 'SESSIONS_LIST'; sessions: SessionState[] }
  | { type: 'SESSION_CREATED'; session: SessionState }
  | { type: 'SESSION_DESTROYED'; sessionId: string }
  | { type: 'STATE_CHANGE'; sessionId: string; status: string; error?: string; waitingFor?: string | null }
  | { type: 'ASSISTANT_MESSAGE'; sessionId: string; messageId: string; text: string; toolUses?: any[] }
  | { type: 'ASSISTANT_STREAM_DELTA'; sessionId: string; messageId: string; delta: string }
  | { type: 'USER_MESSAGE_ECHO'; sessionId: string; messageId: string; text: string; images?: ImageAttachment[] }
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
  | { type: 'CWD_CHANGED'; sessionId: string; cwd: string }
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
  | { type: 'WAKEUP_SCHEDULED'; sessionId: string; wakeup: PendingWakeup }
  | { type: 'WAKEUP_CLEARED'; sessionId: string }
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
  | { type: 'AUTH_RESTORED' };

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

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SESSIONS_LIST': {
      const sessions = new Map<string, SessionState>();
      for (const s of action.sessions) {
        sessions.set(s.id, s);
      }
      return { ...state, sessions };
    }

    case 'SESSION_CREATED': {
      const sessions = new Map(state.sessions);
      sessions.set(action.session.id, action.session);
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
          messages: [...s.messages, {
            id: action.messageId,
            role: 'user' as const,
            content: action.text,
            images: action.images,
            timestamp: new Date().toISOString(),
          }],
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
            toolUses: action.toolUses,
            timestamp: new Date().toISOString(),
          };
          if (existingIdx >= 0) {
            const messages = [...s.messages];
            messages[existingIdx] = msg;
            return { ...s, messages };
          }
          return { ...s, messages: [...s.messages, msg] };
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
            messages: [...s.messages, {
              id: action.messageId,
              role: 'assistant' as const,
              content: action.delta,
              timestamp: new Date().toISOString(),
              isStreaming: true,
            }],
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

    case 'CWD_CHANGED': {
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => ({
          ...s,
          config: { ...s.config, cwd: action.cwd },
        })),
      };
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
      return {
        ...state,
        sessions: updateSession(state.sessions, action.sessionId, (s) => {
          const debugLog = [...s.debugLog, action.entry];
          if (debugLog.length > 500) debugLog.splice(0, debugLog.length - 500);
          return { ...s, debugLog };
        }),
      };
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
  createSession: (config: SessionConfig) => void;
  sendMessage: (sessionId: string, message: string, images?: ImageAttachment[], planMode?: boolean) => void;
  respondToPlan: (sessionId: string, toolUseId: string, decision: 'accept' | 'reject', feedback?: string) => void;
  refreshSkills: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;
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
  createProjectRun: (input: { name: string; repoPath: string; goal: string; budget?: RunBudget; executorModel?: string }) => void;
  approveProjectRun: (runId: string, opts?: { budget?: RunBudget; verifyCommands?: string[] }) => void;
  cancelProjectRun: (runId: string) => void;
  updateLastActive: (sessionId: string) => void;
  setPermissionMode: (sessionId: string, mode: PermissionMode) => void;
  renameSession: (sessionId: string, newName: string) => void;
  updateCwd: (sessionId: string, cwd: string) => void;
  setModel: (sessionId: string, model: string) => void;
  setEffort: (sessionId: string, effort: string) => void;
  generateSummary: (sessionId: string) => void;
  respondToPermission: (sessionId: string, toolUseId: string, decision: 'allow' | 'deny', message?: string) => void;
  respondToQuestion: (sessionId: string, toolUseId: string, answer: string) => void;
  dequeueMessage: (sessionId: string, index: number) => void;
  cancelWakeup: (sessionId: string) => void;
  applyClaudeMdCandidate: (sessionId: string, candidate: string) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
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
    sessionSkills: new Map(),
    appliedClaudeMd: new Set<string>(),
    projectRuns: new Map(),
  });

  const wsRef = useRef<WsClient | null>(null);

  // Keep latest state accessible from the WS handler without retriggering useCallback
  const stateRef = useRef(state);
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
        dispatch({ type: 'USER_MESSAGE_ECHO', sessionId: msg.sessionId, messageId: msg.messageId, text: msg.text, images: msg.images });
        break;
      case 'assistant_message':
        dispatch({ type: 'ASSISTANT_MESSAGE', sessionId: msg.sessionId, messageId: msg.messageId, text: msg.text, toolUses: msg.toolUses });
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
      case 'cwd_changed':
        dispatch({ type: 'CWD_CHANGED', sessionId: msg.sessionId, cwd: msg.cwd });
        break;
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
    }
  }, []);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    const client = new WsClient(
      wsUrl,
      handleWsMessage,
      (connected) => dispatch({ type: 'WS_CONNECTED', connected }),
    );
    client.connect();
    wsRef.current = client;
    return () => client.destroy();
  }, [handleWsMessage]);

  const createSession = useCallback((config: SessionConfig) => {
    wsRef.current?.send({ type: 'create_session', config });
  }, []);

  const sendMessage = useCallback((sessionId: string, message: string, images?: ImageAttachment[], planMode?: boolean) => {
    wsRef.current?.send({ type: 'send_message', sessionId, message, images, planMode });
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

  const setModelFn = useCallback((sessionId: string, model: string) => {
    wsRef.current?.send({ type: 'set_model', sessionId, model });
  }, []);

  const setEffortFn = useCallback((sessionId: string, effort: string) => {
    wsRef.current?.send({ type: 'set_effort', sessionId, effort });
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

  return (
    <SessionContext.Provider value={{
      state,
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
      createProjectRun,
      approveProjectRun,
      cancelProjectRun,
      updateLastActive,
      setPermissionMode: setPermissionModeFn,
      renameSession: renameSessionFn,
      updateCwd: updateCwdFn,
      setModel: setModelFn,
      setEffort: setEffortFn,
      generateSummary: generateSummaryFn,
      respondToPermission: respondToPermissionFn,
      respondToQuestion: respondToQuestionFn,
      dequeueMessage: dequeueMessageFn,
      cancelWakeup: cancelWakeupFn,
      applyClaudeMdCandidate: applyClaudeMdCandidateFn,
      respondToPlan: respondToPlanFn,
      refreshSkills: refreshSkillsFn,
      clearSession: clearSessionFn,
    }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSessions() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSessions must be used within SessionProvider');
  return ctx;
}
