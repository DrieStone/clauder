import type { SessionState } from '@clauder/shared';

// Projects (server/src/project.ts): a main session plus tasks, each task a session of its own in
// the main session's folder (config.mainSessionId). The dashboard and tab bar show one entry per
// project; the session view's task bar switches between its sessions.

export const projectIdOf = (s: SessionState): string => s.config.mainSessionId ?? s.id;
export const isTask = (s: SessionState): boolean => !!s.config.mainSessionId;

/** A main session's tasks, oldest first (the order the task bar shows them in). */
export function tasksOf(mainId: string, sessions: Iterable<SessionState>): SessionState[] {
  const out: SessionState[] = [];
  for (const s of sessions) if (s.config.mainSessionId === mainId) out.push(s);
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Tasks grouped by their main session's id. */
export function tasksByMain(sessions: Iterable<SessionState>): Map<string, SessionState[]> {
  const map = new Map<string, SessionState[]>();
  for (const s of sessions) {
    const main = s.config.mainSessionId;
    if (!main) continue;
    const list = map.get(main);
    if (list) list.push(s); else map.set(main, [s]);
  }
  for (const list of map.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return map;
}

/** A project's state as a whole: working if any of its sessions is, needs you if any does, and as
 *  recent as its most recent session. Used to place its card and tab. */
export function projectActivity(main: SessionState, tasks: SessionState[]): { status: string; waitingFor: string | null; lastActiveAt: string } {
  let lastActiveAt = main.lastActiveAt;
  let working = main.status === 'working';
  let waitingFor = main.waitingFor ?? null;
  for (const t of tasks) {
    if (t.lastActiveAt > lastActiveAt) lastActiveAt = t.lastActiveAt;
    if (t.status === 'working') working = true;
    if (!waitingFor && t.waitingFor) waitingFor = t.waitingFor;
  }
  return { status: working ? 'working' : main.status, waitingFor, lastActiveAt };
}

/** "Project › Task" for a task, the session's own name otherwise. */
export function displayName(s: SessionState, sessions: Map<string, SessionState>): string {
  const main = s.config.mainSessionId ? sessions.get(s.config.mainSessionId) : undefined;
  return main ? `${main.config.name} › ${s.config.name}` : s.config.name;
}
