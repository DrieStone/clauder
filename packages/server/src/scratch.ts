// Scratch: quick conversations, each a session of its own in the scratch folder (config
// scratchConversation, mainSessionId = the Scratch session), with no project rules. Opening Scratch
// after SCRATCH_STALE_HOURS away starts a fresh one (the client decides, it knows when you last
// looked); a conversation untouched for SCRATCH_EXPIRY_DAYS is deleted unless kept. One can become
// a session of its own where it is, or be handed off, through a note Claude writes, to a new
// project folder or as a task of a project. SessionManager does the work; the words live here.

export { SCRATCH_EXPIRY_DAYS, SCRATCH_NEW_NAME } from '@clauder/shared';

/** A conversation's name from its first message: the first line, shortened. */
export function nameFromMessage(text: string): string {
  const line = text.replace(/^\s*\/\S+\s*/, '').split('\n').map(l => l.trim()).find(Boolean) ?? '';
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

/** Sent to a Scratch conversation when the owner hands it off somewhere else. */
export function handoffRequest(where: string): string {
  return `[Clauder: the owner wants to continue this conversation as ${where}, a separate Claude session that won't see this conversation. Don't start that work here. ` +
    'Write a handoff for it: the goal, what has been learned or decided so far that matters, any files, commands or links involved, and the first step. ' +
    'Then end your reply with this on its own line:\n<<new_task>>{"name": "<short name, 2-5 words>", "brief": "<the handoff>"}<<>>]';
}

/** The first message of the session a handoff starts. */
export function handoffMessage(fromName: string, brief: string): string {
  return `Handoff from the Scratch conversation "${fromName}":\n\n${brief}`;
}
