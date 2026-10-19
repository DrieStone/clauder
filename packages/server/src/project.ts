import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { SessionState } from '@clauder/shared';
import { taskRosterPath } from './task-roster.js';
import type { ClosedTask } from './project-notes.js';

// Projects: a main session plus tasks, each task a full session of its own in the main session's
// folder, free to run alongside the others. The main session is the only one that commits: tasks
// check their work in with it. Sessions of a project message each other through sentinels
// (<<to_main>>, <<to_task>>, <<new_task>>) that SessionManager delivers.
//
// Prompt-cache rule: nothing here may change an EXISTING session's system prompt. The main session
// keeps its own unchanged, and learns about its tasks from (1) the task list, written to the roster
// file its system prompt already points at, and (2) a note on each message while it has tasks.
// Only a task, being a new session, gets project rules in its system prompt.

export const MAX_TASKS_PER_PROJECT = 12;
/** Messages sessions of one project may send each other between two of the owner's messages. */
export const MAX_RELAYS_WITHOUT_OWNER = 10;
const MAX_TEXT = 8_000;

/** The project a session belongs to: its main session's id (its own, for a main or standalone one). */
export const projectIdOf = (s: { id: string; config: { mainSessionId?: string } }): string => s.config.mainSessionId ?? s.id;

/** The project's task list lives in the file the main session's system prompt already names. */
export const projectRosterPath = (mainId: string): string => taskRosterPath(mainId);

export const clip = (text: unknown, max = MAX_TEXT): string => String(text ?? '').trim().slice(0, max);

/** How a project's sessions keep each other informed. Shared by the roster, task prompts and notes. */
export const NOTES_RULES = [
  'Keeping each other informed:',
  '- The project has a shared notes board. Leave a note for the others with <<note>>{"text": "<what they should know>"}<<>> on its own line: progress, decisions, finished work and its files, anything another session may need later. A note wakes no one; every session reads the new ones before its next turn.',
  '- Send a direct message only when another session must act on it now, or for something important: <<to_task>>{"task": "<name>", "message": "<text>"}<<>> (or <<to_main>>{"message": "<text>"}<<>> to the main session). Each one wakes that session, which costs a full turn. Never message just to inform or acknowledge.',
].join('\n');

const RULES = [
  'Rules while tasks share the folder:',
  '- Only the main session commits, pushes, pulls, merges, rebases, switches branches, stashes, resets, restores or cleans.',
  '- The main session commits only files it changed itself or that a task\'s check-in names (`git add -- <files>`), never `git add -A` or `git commit -a`.',
  '- Nobody reverts, reformats or deletes changes another session made.',
  '- Check this list before restarting a shared dev server or rewriting shared build output.',
  '',
  NOTES_RULES,
].join('\n');

function statusWord(s: SessionState): string {
  if (s.status === 'working') return 'working now';
  if (s.waitingFor) return 'waiting for the owner';
  if (s.status === 'error') return 'stopped on an error';
  return 'idle';
}

const firstLine = (s: SessionState) =>
  (s.messages.find(m => m.role === 'user' && !m.author)?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);

/** The task list Claude reads on demand: who's in the project, what each is doing, the rules. */
export function projectRosterText(main: SessionState, tasks: SessionState[], closed: ClosedTask[] = []): string {
  const lines = [
    `# Project "${main.config.name}"`,
    '',
    `Several Claude sessions work in this project's folder (${main.config.cwd}), possibly at the same time. Each is a separate conversation; none can see the others'.`,
    '',
    `- Main session: **${main.config.name}** (${statusWord(main)}). The only one that commits; tasks check in with it.`,
  ];
  for (const t of [...tasks].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))) {
    const started = firstLine(t);
    lines.push(`- Task: **${t.config.name}** (${statusWord(t)}, last active ${t.lastActiveAt.slice(0, 16).replace('T', ' ')} UTC)${started ? ` — started with: "${started}"` : ''}`);
  }
  if (closed.length) {
    lines.push('', '## Closed tasks (newest first): what each one did', '');
    for (const c of [...closed].reverse()) {
      lines.push(`### ${c.name} (${c.startedAt.slice(0, 10)} to ${c.closedAt.slice(0, 10)})`, c.summary.trim(), '');
    }
  }
  lines.push('', RULES);
  return lines.join('\n') + '\n';
}

export function writeProjectRoster(main: SessionState, tasks: SessionState[], closed: ClosedTask[] = []): void {
  try {
    const path = projectRosterPath(main.id);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, projectRosterText(main, tasks, closed));
  } catch { /* best-effort, like task-roster.ts */ }
}

/** A task's system prompt block. Fixed for the task's life (the roster path depends only on the
 *  main session's id), so it never costs the task's prompt cache. */
export function taskSystemPrompt(mainId: string): string {
  return [
    'You are one TASK in a Clauder project: a separate Claude session working in the same folder as the project\'s main session and possibly other tasks, at the same time. You only see your own conversation. ' +
      `The project's task list (who is working on what, and who is busy right now) and its rules are in \`${projectRosterPath(mainId)}\`; read it when you need to know what else is going on.`,
    'Because others may be changing this folder right now:',
    '- Never run git commands that change the repository: no commit, push, pull, merge, rebase, checkout or switch, stash, reset, restore or clean. Reading (status, diff, log, show) is fine. The main session does all check-ins.',
    '- Change only the files your task needs, and don\'t revert, reformat or delete changes you didn\'t make.',
    '- Before restarting a shared dev server, or running something that rewrites shared build output, check the task list for anyone working.',
    'When your work is finished, leave a note saying what changed and why, listing every file you changed or created.',
    NOTES_RULES,
    'Messages from the main session or other tasks arrive marked as theirs; answer one only if an answer is needed.',
  ].join('\n');
}

/** The main session's note on each message while its project has tasks. In the message rather than
 *  the system prompt, so adding a task never costs the main session's prompt cache. */
/** The per-message reminder for every session of a project that has tasks (cache-safe: it's in the
 *  message, not the system prompt). Older tasks' prompts still describe check-ins, which now arrive
 *  as notes. */
export const NOTES_REMINDER = '[Clauder: this project has a shared notes board. Put anything the other sessions should know in <<note>>{"text": "..."}<<>>; it wakes no one. ' +
  'Use <<to_task>>/<<to_main>> only for something another session must act on now, or that is important. A task\'s check-in is posted to the board as a note.]';

export function mainProjectNote(mainId: string, taskNames: string[]): string {
  const names = taskNames.slice(0, 6).map(n => `"${n}"`).join(', ') + (taskNames.length > 6 ? ', …' : '');
  return `[Clauder: this project has ${taskNames.length === 1 ? 'a task' : `${taskNames.length} tasks`} (${names}): separate Claude sessions working in this same folder, possibly right now. ` +
    `You're the main session, the only one that commits. While they exist, commit only files you changed yourself or that a task's check-in names (\`git add -- <files>\`); never \`git add -A\`, \`git commit -a\`, stash, reset, checkout or switch branches, and don't revert their changes. ` +
    `Their status and the rules are in \`${projectRosterPath(mainId)}\`. Tasks' check-ins and notes reach you on the shared notes board, not as messages; commit their work only when the owner asks.]`;
}

/** Claude's note ahead of a message from another session of the project. */
export function relayNote(fromName: string, mainId: string): string {
  const name = fromName.replace(/[\[\]\r\n]/g, ' ').trim().slice(0, 60) || 'another session';
  return `[Clauder: this message is from "${name}", another Claude session in this project working in the same folder, not from the owner. ` +
    `The project's task list and rules are in \`${projectRosterPath(mainId)}\`. Answer only if an answer is needed.]`;
}

/** Claude's note ahead of a message from a session of ANOTHER project (<<to_session>>). */
export function crossRelayNote(fromName: string): string {
  const name = fromName.replace(/[\[\]\r\n]/g, ' ').trim().slice(0, 60) || 'another session';
  return `[Clauder: this message is from "${name}", a Claude session of another project (a different folder), sent on the owner's behalf, not typed by the owner. ` +
    `Do what it asks if it fits this project; if something is unclear or risky, ask the owner instead. To answer it, end your reply with ` +
    `<<to_session>>{"session": "${name}", "message": "<text>"}<<>> on its own line, only if an answer is needed.]`;
}

/** The note on each message to a session the owner has let message others: who, and how. */
export function canMessageNote(names: string[]): string {
  const list = names.slice(0, 12).map(n => `"${n}"`).join(', ') + (names.length > 12 ? ', …' : '');
  return `[Clauder: when the owner asks you to, you can send a message to another session (a separate Claude working on another project): ` +
    `end your reply with <<to_session>>{"session": "<name>", "message": "<what to do or ask, self-contained>"}<<>> on its own line. ` +
    `Sessions you may message: ${list}. Its answer arrives later as a message from it. Only message when the owner asked for it or to answer one.]`;
}

/** Sent to a session when the owner types `/task <description>` in it. */
export function spinOffRequest(description: string): string {
  return `[Clauder: the owner wants to spin off a new task: "${clip(description, 2_000)}". Don't start that work here. ` +
    'Write a short handoff for a separate Claude session that will do it in this same folder, possibly while work continues here: the goal, what has been learned or decided that matters, the relevant files, and the first step. ' +
    'Then end your reply with this on its own line:\n<<new_task>>{"name": "<short task name, 2-5 words>", "brief": "<the handoff>"}<<>>]';
}
