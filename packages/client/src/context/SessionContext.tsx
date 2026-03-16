import React, { createContext, useContext, useReducer, useCallback, useEffect, useRef } from 'react';
import type { SessionState, SessionConfig, DiscoveredSession, WsOutboundMessage, UIMessage, RateLimitInfo, PermissionMode, ImageAttachment, QueuedMessage, ToolResultInfo, DebugLogEntry } from '@clauder/shared';
import { WsClient } from '../lib/ws-client';

// State
interface AppState {
  sessions: Map<string, SessionState>;
  activeSessionId: string | null;
  wsConnected: boolean;
  discoveredSessions: DiscoveredSession[];
  showDiscovery: boolean;
  discoveryLoading: boolean;
  rateLimit: RateLimitInfo | null;
  pauseUntil: string | null;
}

// Actions
type Action =
  | { type: 'SESSIONS_LIST'; sessions: SessionState[] }
  | { type: 'SESSION_CREATED'; session: SessionState }
  | { type: 'SESSION_DESTROYED'; sessionId: string }
  | { type: 'STATE_CHANGE'; sessionId: string; status: string; error?: string }
  | { type: 'ASSISTANT_MESSAGE'; sessionId: string; messageId: string; text: string; toolUses?: any[] }
  | { type: 'ASSISTANT_STREAM_DELTA'; sessionId: string; messageId: string; delta: string }
  | { type: 'USER_MESSAGE_ECHO'; sessionId: string; messageId: string; text: string; images?: ImageAttachment[] }
  | { type: 'TOOL_ACTIVITY'; sessionId: string; activity: { toolName: string; description: string } }
  | { type: 'RESULT'; sessionId: string; costUsd: number; success: boolean; error?: string }
  | { type: 'CONTEXT_UPDATE'; sessionId: string; contextUsage: { inputTokens: number; outputTokens: number; contextWindow: number } }
  | { type: 'QUEUE_UPDATE'; sessionId: string; queue: QueuedMessage[] }
  | { type: 'RATE_LIMIT_UPDATE'; rateLimit: RateLimitInfo }
  | { type: 'PAUSE_UPDATE'; pauseUntil: string | null }
  | { type: 'PERMISSION_MODE_CHANGE'; sessionId: string; mode: PermissionMode }
  | { type: 'SESSION_RENAMED'; sessionId: string; newName: string }
  | { type: 'MODEL_CHANGED'; sessionId: string; model: string }
  | { type: 'SUMMARY_GENERATED'; sessionId: string; summary: string; summaryGeneratedAt: string }
  | { type: 'PERMISSION_REQUEST'; sessionId: string; toolUseId: string; toolName: string; input: Record<string, unknown> }
  | { type: 'PERMISSION_RESOLVED'; sessionId: string }
  | { type: 'TOOL_RESULT'; sessionId: string; toolUseId: string; result: ToolResultInfo }
  | { type: 'DEBUG_LOG'; sessionId: string; entry: DebugLogEntry }
  | { type: 'UPDATE_LAST_ACTIVE'; sessionId: string }
  | { type: 'ERROR'; sessionId: string; message: string }
  | { type: 'SET_ACTIVE_SESSION'; sessionId: string | null }
  | { type: 'WS_CONNECTED'; connected: boolean }
  | { type: 'DISCOVERED_SESSIONS'; sessions: DiscoveredSession[] }
  | { type: 'SET_SHOW_DISCOVERY'; show: boolean }
  | { type: 'SET_DISCOVERY_LOADING'; loading: boolean };

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

    default:
      return state;
  }
}

// Context
interface SessionContextValue {
  state: AppState;
  createSession: (config: SessionConfig) => void;
  sendMessage: (sessionId: string, message: string, images?: ImageAttachment[]) => void;
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
  updateLastActive: (sessionId: string) => void;
  setPermissionMode: (sessionId: string, mode: PermissionMode) => void;
  renameSession: (sessionId: string, newName: string) => void;
  setModel: (sessionId: string, model: string) => void;
  generateSummary: (sessionId: string) => void;
  respondToPermission: (sessionId: string, toolUseId: string, decision: 'allow' | 'deny', message?: string) => void;
  dequeueMessage: (sessionId: string, index: number) => void;
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
  });

  const wsRef = useRef<WsClient | null>(null);

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
      case 'state_change':
        dispatch({ type: 'STATE_CHANGE', sessionId: msg.sessionId, status: msg.status, error: msg.error });
        break;
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
      case 'summary_generated':
        dispatch({ type: 'SUMMARY_GENERATED', sessionId: msg.sessionId, summary: msg.summary, summaryGeneratedAt: msg.summaryGeneratedAt });
        break;
      case 'permission_request':
        dispatch({ type: 'PERMISSION_REQUEST', sessionId: msg.sessionId, toolUseId: msg.toolUseId, toolName: msg.toolName, input: msg.input });
        break;
      case 'permission_resolved':
        dispatch({ type: 'PERMISSION_RESOLVED', sessionId: msg.sessionId });
        break;
      case 'tool_result':
        dispatch({ type: 'TOOL_RESULT', sessionId: msg.sessionId, toolUseId: msg.toolUseId, result: msg.result });
        break;
      case 'debug_log':
        dispatch({ type: 'DEBUG_LOG', sessionId: msg.sessionId, entry: msg.entry });
        break;
      case 'discovered_sessions':
        dispatch({ type: 'DISCOVERED_SESSIONS', sessions: msg.sessions });
        break;
      case 'error':
        dispatch({ type: 'ERROR', sessionId: msg.sessionId, message: msg.message });
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

  const sendMessage = useCallback((sessionId: string, message: string, images?: ImageAttachment[]) => {
    wsRef.current?.send({ type: 'send_message', sessionId, message, images });
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

  const updateLastActive = useCallback((sessionId: string) => {
    dispatch({ type: 'UPDATE_LAST_ACTIVE', sessionId });
  }, []);

  const setPermissionModeFn = useCallback((sessionId: string, mode: PermissionMode) => {
    wsRef.current?.send({ type: 'set_permission_mode', sessionId, mode });
  }, []);

  const renameSessionFn = useCallback((sessionId: string, newName: string) => {
    wsRef.current?.send({ type: 'rename_session', sessionId, newName });
  }, []);

  const setModelFn = useCallback((sessionId: string, model: string) => {
    wsRef.current?.send({ type: 'set_model', sessionId, model });
  }, []);

  const generateSummaryFn = useCallback((sessionId: string) => {
    wsRef.current?.send({ type: 'generate_summary', sessionId });
  }, []);

  const respondToPermissionFn = useCallback((sessionId: string, toolUseId: string, decision: 'allow' | 'deny', message?: string) => {
    wsRef.current?.send({ type: 'permission_response', sessionId, toolUseId, decision, message });
  }, []);

  const dequeueMessageFn = useCallback((sessionId: string, index: number) => {
    wsRef.current?.send({ type: 'dequeue_message', sessionId, index });
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
      updateLastActive,
      setPermissionMode: setPermissionModeFn,
      renameSession: renameSessionFn,
      setModel: setModelFn,
      generateSummary: generateSummaryFn,
      respondToPermission: respondToPermissionFn,
      dequeueMessage: dequeueMessageFn,
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
