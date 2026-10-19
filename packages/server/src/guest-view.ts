import type { SessionState, ShareLink, UIMessage, WsOutboundMessage, ImageAttachment, FileAttachment } from '@clauder/shared';

const GUEST_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_GUEST_IMAGES = 10;
const MAX_GUEST_FILES = 5;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // each, as the composer allows
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;      // per message
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** A guest's attachments, checked as untrusted input: the composer's own limits (10 images,
 *  5 files, 15 MB each) plus 50 MB per message, image types the API accepts, well-formed base64,
 *  and only the file kinds the server knows how to hand to Claude. Any problem rejects the whole
 *  message with a reason. Saving is uploads.ts, which strips directories from file names. */
export function guestAttachments(rawImages: unknown, rawFiles: unknown): { images: ImageAttachment[]; files: FileAttachment[] } | { error: string } {
  const images: ImageAttachment[] = [];
  const files: FileAttachment[] = [];
  const decoded = (b64: string) => Math.floor((b64.length * 3) / 4);
  let total = 0;
  if (rawImages != null) {
    if (!Array.isArray(rawImages) || rawImages.length > MAX_GUEST_IMAGES) return { error: `Up to ${MAX_GUEST_IMAGES} images per message.` };
    for (const img of rawImages) {
      if (!img || typeof img.data !== 'string' || !GUEST_IMAGE_TYPES.has(img.mimeType) || !BASE64_RE.test(img.data)) {
        return { error: "An image couldn't be used. PNG, JPEG, GIF and WebP work." };
      }
      if (decoded(img.data) > MAX_ATTACHMENT_BYTES) return { error: 'An image is over 15 MB.' };
      total += decoded(img.data);
      images.push({ data: img.data, mimeType: img.mimeType });
    }
  }
  if (rawFiles != null) {
    if (!Array.isArray(rawFiles) || rawFiles.length > MAX_GUEST_FILES) return { error: `Up to ${MAX_GUEST_FILES} files per message.` };
    for (const f of rawFiles) {
      if (!f || typeof f.name !== 'string' || typeof f.content !== 'string' || !['text', 'document', 'binary'].includes(f.kind)) {
        return { error: "A file couldn't be read." };
      }
      const name = f.name.slice(0, 200);
      if (f.kind === 'document' && f.mimeType !== 'application/pdf') return { error: `"${name}" isn't a PDF.` };
      if (f.kind !== 'text' && !BASE64_RE.test(f.content)) return { error: `"${name}" couldn't be read.` };
      const size = f.kind === 'text' ? Buffer.byteLength(f.content) : decoded(f.content);
      if (size > MAX_ATTACHMENT_BYTES) return { error: `"${name}" is over 15 MB.` };
      total += size;
      files.push({ name, mimeType: typeof f.mimeType === 'string' ? f.mimeType.slice(0, 100) : 'application/octet-stream', content: f.content, kind: f.kind });
    }
  }
  if (total > MAX_TOTAL_BYTES) return { error: 'The attachments are over 50 MB together.' };
  return { images, files };
}

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
 *  an already client-trimmed state (toClientState). A share covers a whole project, so a task keeps
 *  the link to its main session that groups them. */
export function toGuestState(s: SessionState, share: ShareLink): SessionState {
  return {
    ...s,
    config: { name: s.config.name, cwd: '', model: s.config.model, effort: s.config.effort, ...(s.config.mainSessionId ? { mainSessionId: s.config.mainSessionId } : {}) },
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

/** What a broadcast becomes on a guest's connection: the events of its project's sessions (the
 *  shared session and its tasks), or nothing. `projectOf` gives a session's project id, including
 *  for one just destroyed. */
export function forGuest(msg: WsOutboundMessage, share: ShareLink, projectOf: (sessionId: string) => string | null): WsOutboundMessage | null {
  const inScope = (id: string) => projectOf(id) === share.sessionId;
  if (msg.type === 'session_created') {
    return inScope(msg.session.id) ? { type: 'session_created', session: toGuestState(msg.session, share) } : null;
  }
  if (msg.type === 'session_destroyed') return inScope(msg.sessionId) ? msg : null;
  if (!GUEST_EVENTS.has(msg.type) || !('sessionId' in msg) || !inScope(msg.sessionId)) return null;
  return msg;
}
