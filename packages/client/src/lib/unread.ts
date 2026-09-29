/**
 * "Unread" = a session had activity after it was last read — on any device, since read times sync
 * through the server (server/src/ui-state.ts). Working sessions are never unread (they're mid-turn),
 * and neither is a session never read anywhere, so a fresh device doesn't open to a sea of red dots.
 */
export function isSessionUnread(
  session: { id: string; lastActiveAt: string; status: string },
  readAt: Record<string, string>,
): boolean {
  if (session.status === 'working') return false;
  const lastRead = readAt[session.id];
  if (!lastRead) return false;
  return new Date(session.lastActiveAt) > new Date(lastRead);
}
