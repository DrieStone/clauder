import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { CLAUDE_CLI_PATH, CLI_IS_NATIVE } from './session.js';

export interface OneShotOpts {
  prompt: string;
  model: string;
  timeoutMs?: number;
  cwd?: string;
}

/** A headless, non-session Claude CLI call — for cheap out-of-band asks (e.g. search's Haiku
 *  query-expansion/rerank passes) that don't belong to any ManagedSession. Mirrors
 *  ManagedSession.generateSummary()'s subprocess shape exactly (same flags, same stdin
 *  protocol, same "collect assistant text blocks" drain) but is a free function so callers
 *  don't need a session instance. Never throws — resolves '' on spawn error, non-JSON output,
 *  process failure, or timeout, so a broken one-shot call degrades a caller's feature rather
 *  than crashing it. ANTHROPIC_API_KEY is unset in prod, so this subprocess path is the only
 *  way to get an out-of-band LLM call — see CLAUDE.md. */
export async function runClaudeOneShot(opts: OneShotOpts): Promise<string> {
  const { prompt, model, timeoutMs = 45_000, cwd = homedir() } = opts;

  const flags = [
    '--model', model,
    '--permission-mode', 'plan',
    '--no-session-persistence',
    '--disallowed-tools', 'Read,Write,Edit,Bash,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit',
  ];
  const cliArgs = [
    '--print',
    '--output-format=stream-json',
    '--input-format=stream-json',
    '--verbose',
    ...flags,
  ];
  const command = CLI_IS_NATIVE ? CLAUDE_CLI_PATH : process.execPath;
  const args = CLI_IS_NATIVE ? cliArgs : [CLAUDE_CLI_PATH, ...cliArgs];
  const stdinPayload = JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } });

  return new Promise<string>((resolve) => {
    let settled = false;
    const finish = (text: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve(text);
    };

    let proc;
    try {
      proc = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      finish('');
      return;
    }
    proc.on('error', () => finish(''));

    const killTimer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      finish('');
    }, timeoutMs);

    let out = '';
    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed) as any;
        if (msg.type === 'assistant') {
          const content = msg.message?.content;
          if (content) out += content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
        }
      } catch {
        // skip non-JSON lines
      }
    });

    proc.on('close', () => finish(out));

    try {
      proc.stdin!.write(stdinPayload + '\n');
      proc.stdin!.end();
    } catch {
      finish('');
    }
  });
}
