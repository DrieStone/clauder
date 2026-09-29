import type { UIMessage } from './session.js';

/** Cap `messages` to at most `maxCount` entries while NEVER dropping a pinned message,
 *  regardless of age. Trims the oldest unpinned messages first; original relative order
 *  is preserved. Used identically by the client (in-memory), the server (in-memory), and
 *  persistence (on-disk) so a pinned message can never silently disappear from any of them.
 *  If pinned messages alone exceed maxCount, all pinned messages are kept anyway — pinning
 *  is an explicit user action and should never be undone by a size cap. */
export function trimMessages(messages: UIMessage[], maxCount: number): UIMessage[] {
  if (messages.length <= maxCount) return messages;
  const pinned = messages.filter(m => m.pinned);
  const unpinned = messages.filter(m => !m.pinned);
  const keepUnpinnedCount = Math.max(0, maxCount - pinned.length);
  const keptUnpinned = unpinned.slice(-keepUnpinnedCount);
  const keptIds = new Set([...pinned, ...keptUnpinned].map(m => m.id));
  return messages.filter(m => keptIds.has(m.id));
}
