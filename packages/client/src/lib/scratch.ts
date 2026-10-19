import type { SessionState } from '@clauder/shared';
import { SCRATCH_STALE_HOURS, SCRATCH_EXPIRY_DAYS } from '@clauder/shared';

// Scratch (server/src/scratch.ts): quick conversations, each a session of its own (a task of the
// Scratch session, config.scratchConversation). Opening Scratch after SCRATCH_STALE_HOURS away
// starts a fresh one; one untouched for SCRATCH_EXPIRY_DAYS is deleted unless kept.

const SEEN_KEY = 'clauder.scratchSeen';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Scratch or one of its conversations. */
export const inScratch = (s: SessionState): boolean => !!(s.config.isScratch || s.config.scratchConversation);

/** Whether anything has been said in it yet. */
export const hasConversation = (s: SessionState): boolean => s.messages.some(m => m.role === 'user' || m.role === 'assistant');

/** Scratch's conversations, newest first. */
export function scratchConversations(scratchId: string, sessions: Iterable<SessionState>): SessionState[] {
  const out: SessionState[] = [];
  for (const s of sessions) if (s.config.mainSessionId === scratchId) out.push(s);
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Remember the Scratch conversation this device has open, and when. */
export function noteScratchSeen(id: string): void {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify({ id, at: Date.now() })); } catch { /* private mode */ }
}

function lastSeenHere(): { id: string; at: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? 'null');
    return v && typeof v.id === 'string' && typeof v.at === 'number' ? v : null;
  } catch {
    return null;
  }
}

/** The conversation opening Scratch shows: the one in use, if Scratch was used in the last
 *  SCRATCH_STALE_HOURS (on this device, or any, going by activity and reads); otherwise one never
 *  written in. Null means start a new one. */
export function scratchToOpen(convs: SessionState[], readAt: Record<string, string>, now = Date.now()): string | null {
  const stale = SCRATCH_STALE_HOURS * HOUR_MS;
  const seen = lastSeenHere();
  const here = seen ? convs.find(c => c.id === seen.id) : undefined;
  if (here && (now - seen!.at < stale || now - Date.parse(here.lastActiveAt) < stale)) return here.id;
  const at = (c: SessionState) => Math.max(Date.parse(c.lastActiveAt), readAt[c.id] ? Date.parse(readAt[c.id]) : 0);
  const recent = [...convs].sort((a, b) => at(b) - at(a))[0];
  if (recent && now - at(recent) < stale) return recent.id;
  return convs.find(c => !hasConversation(c) && c.status !== 'working')?.id ?? null;
}

/** Whole days before an unkept conversation expires (0: today), or null when kept. */
export function daysLeft(s: SessionState, now = Date.now()): number | null {
  if (s.config.keep) return null;
  return Math.max(0, Math.ceil((Date.parse(s.lastActiveAt) + SCRATCH_EXPIRY_DAYS * DAY_MS - now) / DAY_MS));
}
