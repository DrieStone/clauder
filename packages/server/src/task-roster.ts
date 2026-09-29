import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const ROSTER_DIR = join(homedir(), '.clauder', 'task-rosters');

/** Where a session's task roster lives. Outside the project on purpose (never written into the
 *  user's repo), and keyed only by session id, so the path — and the one system-prompt sentence
 *  that mentions it — never changes for the life of the session. Mentioning it therefore costs
 *  nothing against the prompt cache. */
export function taskRosterPath(sessionId: string): string {
  return join(ROSTER_DIR, `${sessionId}.md`);
}

export interface RosterTask {
  name: string;
  messageCount: number;
  lastActiveAt: string;
  preview: string;
  model?: string | null;
}

/** Rewrite a session's roster: the current task's name plus its other tasks. Tasks are only
 *  "lightly aware" of each other — Claude is told the file exists and reads it if the user refers
 *  to another task. Nothing about other tasks is ever pushed into a conversation, so switching
 *  tasks never disturbs a prompt cache. Best-effort: a stale roster is harmless. */
export function writeTaskRoster(sessionId: string, sessionName: string, current: string | null, others: RosterTask[]): void {
  const lines = [`# Tasks in "${sessionName}"`, '', `You are in: **${current ?? '(unnamed task)'}**`, ''];
  if (others.length === 0) {
    lines.push('There are no other tasks in this session.');
  } else {
    lines.push('Other tasks in this session, most recently active first. Each is a separate conversation you can\'t see; the user switches between them.', '');
    for (const t of others) {
      const facts = [`last active ${t.lastActiveAt.slice(0, 16).replace('T', ' ')} UTC`, `${t.messageCount} message${t.messageCount === 1 ? '' : 's'}`];
      if (t.model) facts.push(t.model);
      lines.push(`- **${t.name}** (${facts.join(', ')})${t.preview ? ` — started with: "${t.preview}"` : ''}`);
    }
  }
  try {
    mkdirSync(ROSTER_DIR, { recursive: true });
    writeFileSync(taskRosterPath(sessionId), lines.join('\n') + '\n');
  } catch { /* best-effort */ }
}

export function removeTaskRoster(sessionId: string): void {
  try { rmSync(taskRosterPath(sessionId), { force: true }); } catch { /* ignore */ }
}
