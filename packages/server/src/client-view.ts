import type { SessionState, UIMessage } from '@clauder/shared';

/** How many recent messages ride along in the bulk session list. The dashboard never shows more
 *  than the last few, and the rest arrive via `request_history` when a session is actually opened.
 *  Before this, connecting pushed every session's full in-memory history in one frame: with ~40
 *  sessions × up to 400 messages (images inline) that frame measured **66 MB**, took the server
 *  ~4.5s to build, and left a phone on cellular staring at an empty screen for over a minute. */
export const LIST_MESSAGE_TAIL = 40;

/** Replace attachment blobs with URLs the browser fetches on demand. Base64 images were ~80% of
 *  the connect payload; an attachment never changes once recorded, so it belongs in the HTTP
 *  cache (served `immutable` by /api/attachments) rather than in every session snapshot. */
function stripAttachments(sessionId: string, messages: UIMessage[]): UIMessage[] {
  return messages.map(m => {
    const images = m.images?.map((img, i) => (img.data
      ? { ...img, data: '', src: `/api/attachments/${sessionId}/${encodeURIComponent(m.id)}/image/${i}` }
      : img));
    const files = m.files?.map((f, i) => (f.content
      ? { ...f, content: '', src: `/api/attachments/${sessionId}/${encodeURIComponent(m.id)}/file/${i}` }
      : f));
    if (!images && !files) return m;
    return { ...m, ...(images ? { images } : {}), ...(files ? { files } : {}) };
  });
}

/** The wire shape of a session for the browser: recent messages only, attachments by URL.
 *  `messageCount` is the real total, so the client knows there's more history to ask for.
 *  No debug log: it was half the connect payload (~3,100 entries across 42 sessions) and is only
 *  read in a session's Debug tab, which fetches it with `request_debug_log`. */
export function toClientState(state: SessionState): SessionState {
  return {
    ...state,
    messages: stripAttachments(state.id, state.messages.slice(-LIST_MESSAGE_TAIL)),
    messageCount: state.messages.length,
    debugLog: [],
  };
}

/** Full history for one session (still attachment-free) — the reply to `request_history`. */
export function toClientHistory(state: SessionState): UIMessage[] {
  return stripAttachments(state.id, state.messages);
}
