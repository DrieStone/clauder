import type { SessionState, ShareLink, UIMessage, WsOutboundMessage } from '@clauder/shared';

/** Session events a guest receives, and only for its own session. Everything else is owner-only
 *  (notes, debug logs, other tasks, monitors, plans, schedules, share links, tags, settings). */
const GUEST_EVENTS = new Set<WsOutboundMessage['type']>([
  'state_change', 'assistant_message', 'assistant_message_stream', 'user_message_echo', 'tool_activity',
  'tool_result', 'result', 'context_update', 'session_renamed', 'message_pinned', 'error',
]);

/** Attachment URLs need the share token: the guest's browser fetches them from /api, which
 *  otherwise answers only the owner. */
function withShareParam(m: UIMessage, token: string): UIMessage {
  const tag = (src: string | undefined) => (src ? `${src}${src.includes('?') ? '&' : '?'}share=${encodeURIComponent(token)}` : src);
  if (!m.images?.length && !m.files?.length) return m;
  return {
    ...m,
    images: m.images?.map(img => ({ ...img, src: tag(img.src) })),
    files: m.files?.map(f => ({ ...f, src: tag(f.src) })),
  };
}

export function guestMessages(messages: UIMessage[], share: ShareLink): UIMessage[] {
  return messages.map(m => withShareParam(m, share.token));
}

/** A session as a guest sees it: the conversation, and none of the owner's private state. Takes
 *  an already client-trimmed state (toClientState). */
export function toGuestState(s: SessionState, share: ShareLink): SessionState {
  return {
    ...s,
    config: { name: s.config.name, cwd: '', model: s.config.model, effort: s.config.effort },
    sdkSessionId: null,
    queuedMessages: [],
    pendingPermission: null,
    pendingWakeup: null,
    pendingPlan: null,
    monitors: [],
    summary: null,
    summaryGeneratedAt: null,
    compactedContext: null,
    notes: null,
    notesUpdatedAt: null,
    debugLog: [],
    threads: [],
    activeThreadName: null,
    messages: guestMessages(s.messages, share),
  };
}

/** What a broadcast becomes on a guest's connection: its own session's events, or nothing. */
export function forGuest(msg: WsOutboundMessage, share: ShareLink): WsOutboundMessage | null {
  if (msg.type === 'session_created') {
    return msg.session.id === share.sessionId ? { type: 'session_created', session: toGuestState(msg.session, share) } : null;
  }
  if (msg.type === 'session_destroyed') return msg.sessionId === share.sessionId ? msg : null;
  if (!GUEST_EVENTS.has(msg.type) || !('sessionId' in msg) || msg.sessionId !== share.sessionId) return null;
  return msg;
}
