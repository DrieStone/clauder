import type { SessionState } from '@clauder/shared';
import { projectIdOf } from './projects';

// What was open, remembered on this device across reloads: the session last open in each project
// (so its tab, or its card on the dashboard, returns you to the task you were in) and the last one
// open at all (so reopening Clauder lands back in it rather than on the dashboard).

const PROJECTS_KEY = 'clauder.lastInProject';
const ACTIVE_KEY = 'clauder.lastActive';

function readMap(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? '{}') ?? {}; } catch { return {}; }
}

export function rememberOpen(session: SessionState): void {
  try {
    const map = readMap();
    map[projectIdOf(session)] = session.id;
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(map));
    localStorage.setItem(ACTIVE_KEY, session.id);
  } catch { /* private mode or full storage: just don't remember */ }
}

/** The session to open for a project: the one last open in it if it still belongs there, else its main. */
export function sessionToOpen(projectId: string, sessions: Map<string, SessionState>): string {
  const last = readMap()[projectId];
  const s = last ? sessions.get(last) : undefined;
  return s && projectIdOf(s) === projectId ? s.id : projectId;
}

/** The session open when Clauder was last used here, if it still exists. */
export function lastActive(sessions: Map<string, SessionState>): string | null {
  try {
    const id = localStorage.getItem(ACTIVE_KEY);
    return id && sessions.has(id) ? id : null;
  } catch { return null; }
}
