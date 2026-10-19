// Background work that dies with its turn. Clauder runs each turn as its own CLI process, and a
// command or agent started "in the background" lives only as long as that process: when the turn
// ends it is stopped, and the next turn's CLI reports it as "didn't finish before the previous
// session ended". A session that starts one and then ends its turn without anything that comes
// back for it (a wakeup, a monitor, a watch) has stranded the work. BackgroundTracker spots those
// from a turn's tool calls; the messages here say so, to the owner and to Claude.

export interface BackgroundTask {
  toolUseId: string;
  kind: 'command' | 'agent';
  label: string;
  /** The CLI's id for it, once its tool result says. */
  id?: string;
  /** Claude is managing it: it waited for it or stopped it. */
  handled: boolean;
}

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export class BackgroundTracker {
  private tasks = new Map<string, BackgroundTask>();

  onToolUse(tu: { id: string; name: string; input?: Record<string, unknown> }): void {
    const input = tu.input ?? {};
    if ((tu.name === 'Bash' || tu.name === 'Agent' || tu.name === 'Task') && input.run_in_background) {
      const isCommand = tu.name === 'Bash';
      const label = clip(input.description || (isCommand ? input.command : input.prompt), 90) || (isCommand ? 'a command' : 'an agent');
      this.tasks.set(tu.id, { toolUseId: tu.id, kind: isCommand ? 'command' : 'agent', label, handled: false });
      return;
    }
    // Waiting on one, or stopping one, means Claude is minding it.
    if (['TaskOutput', 'TaskStop', 'BashOutput', 'KillShell'].includes(tu.name)) {
      const target = String(input.task_id ?? input.bash_id ?? input.shell_id ?? '').trim();
      for (const t of this.tasks.values()) if (!target || t.id === target) t.handled = true;
    }
  }

  /** A tool result: for a task just started, it carries the CLI's id for it. */
  onToolResult(toolUseId: string, text: string): void {
    const t = this.tasks.get(toolUseId);
    if (!t || t.id) return;
    t.id = /\bID:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? /agentId:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1];
  }

  /** Tasks started this turn that nothing waited for or stopped. */
  outstanding(): BackgroundTask[] {
    return [...this.tasks.values()].filter(t => !t.handled);
  }
}

const list = (tasks: BackgroundTask[]) => tasks.slice(0, 5).map(t => `${t.kind}: ${t.label}`).join('; ') + (tasks.length > 5 ? `; and ${tasks.length - 5} more` : '');

/** The line in the chat when a turn ends with background work still running. */
export function strandedLine(tasks: BackgroundTask[]): string {
  return `⚠️ ${tasks.length === 1 ? 'A background task was' : `${tasks.length} background tasks were`} still running when this turn ended, and stopped with it (${list(tasks)}). ` +
    'Work started in the background only lasts as long as the turn that started it.';
}

/** What Claude is told, so the work gets done instead of stranded. */
export function strandedPrompt(tasks: BackgroundTask[]): string {
  const lines = tasks.slice(0, 8).map(t => `- ${t.kind}: ${t.label}`).join('\n');
  return '[Clauder] Your last turn ended while this background work was still running, and it stopped with the turn:\n' + lines + '\n' +
    'Background commands and agents only live as long as the turn that started them. If you still need the result, redo it so it survives: ' +
    'run a command with nohup (output to a log file) and have a <<monitor>> or a ScheduleWakeup come back for it, ' +
    'or, for an agent, wait for it within the turn (TaskOutput with block). Then keep going. ' +
    'If it had already finished, or you no longer need it, just say so in one line.';
}
