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
    if (!s.config.isScratch) out.push(s);
  }
  return out;
}
