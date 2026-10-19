import type { SessionState } from '@clauder/shared';

/** The singleton scratch session, if it has been bootstrapped on the server. */
export function getScratchSession(sessions: Map<string, SessionState>): SessionState | undefined {
  for (const s of sessions.values()) {
    if (s.config.isScratch) return s;
  }
  return undefined;
}

/** All sessions except the scratch session, in insertion order. */
export function getNonScratchSessions(sessions: Map<string, SessionState>): SessionState[] {
  const out: SessionState[] = [];
  for (const s of sessions.values()) {
    // Not Scratch's conversations or a project's tasks either: those aren't tabs of their own.
    if (!s.config.isScratch && !s.config.mainSessionId) out.push(s);
  }
  return out;
}
