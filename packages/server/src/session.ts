import { v4 as uuid } from 'uuid';
import { spawn } from 'child_process';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import type { ChildProcess } from 'child_process';
import type { SessionConfig, SessionState, SessionStatus, SessionOrigin, PermissionMode, UIMessage, ToolActivity, ToolUseInfo, ContextUsage, PendingPermission, PendingWakeup, ImageAttachment, QueuedMessage, ToolResultInfo, DebugLogEntry, DebugLogEntryType } from '@clauder/shared';
import type { WsOutboundMessage } from '@clauder/shared';
import { recordCostDelta } from './rate-limits.js';

// Walk up the directory tree from this file to find the Claude CLI binary.
// v2.1.120+ ships a native binary at bin/claude.exe instead of cli.js.
const CLAUDE_CLI_PATH = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  // Check for native binary first (v2.1.120+), then legacy cli.js
  const candidates = [
    'node_modules/@anthropic-ai/claude-code/bin/claude.exe',
    'node_modules/@anthropic-ai/claude-code/cli.js',
  ];
  while (true) {
    for (const rel of candidates) {
      const candidate = join(dir, rel);
      if (existsSync(candidate)) {
        console.log(`[Clauder] Claude CLI found at: ${candidate}`);
        return candidate;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not find Claude CLI binary — is @anthropic-ai/claude-code installed?');
    dir = parent;
  }
})();

// Detect whether the CLI is a native binary or a Node.js script
const CLI_IS_NATIVE = CLAUDE_CLI_PATH.endsWith('.exe');

// Path to the Clauder MCP server (built from packages/mcp-server)
const CLAUDER_MCP_PATH = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(dir, 'packages', 'mcp-server', 'dist', 'index.js');
    if (existsSync(candidate)) {
      console.log(`[Clauder] MCP server found at: ${candidate}`);
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      console.warn('[Clauder] MCP server not found — controller mode will not work until built');
      return '';
    }
    dir = parent;
  }
})();

// Directory for per-session MCP config files
const MCP_CONFIG_DIR = join(homedir(), '.clauder', 'mcp-configs');
if (!existsSync(MCP_CONFIG_DIR)) {
  mkdirSync(MCP_CONFIG_DIR, { recursive: true });
}

const CLAUDER_PORT = process.env.CLAUDER_PORT || '3001';

/** Max characters for tool result content sent to client */
const MAX_TOOL_RESULT_LENGTH = 10_000;
/** Max characters for debug log entry content */
const MAX_DEBUG_CONTENT_LENGTH = 5_000;

export class ManagedSession {
  readonly id: string;
  config: SessionConfig;
  status: SessionStatus = 'idle';
  origin: SessionOrigin;
  permissionMode: PermissionMode;
  sdkSessionId: string | null = null;
  totalCostUsd = 0;
  error: string | null = null;
  currentToolActivity: ToolActivity | null = null;
  contextUsage: ContextUsage | null = null;
  messages: UIMessage[] = [];
  summary: string | null = null;
  summaryGeneratedAt: string | null = null;
  debugLog: DebugLogEntry[] = [];
  createdAt: string;
  lastActiveAt: string;

  queuedMessages: QueuedMessage[] = [];

  pendingPermission: PendingPermission | null = null;
  pendingWakeup: PendingWakeup | null = null;
  private wakeupTimer: NodeJS.Timeout | null = null;

  private activeProcess: ChildProcess | null = null;
  private broadcast: (msg: WsOutboundMessage) => void;
  private needsFork = false;
  private wasReset = false;
  private awaitingCompactSummary = false;
  compactedContext: string | null = null;
  private retryCount = 0;
  private consecutiveStalls = 0;

  constructor(config: SessionConfig, broadcast: (msg: WsOutboundMessage) => void, origin?: SessionOrigin) {
    this.id = uuid();
    this.config = config;
    this.createdAt = new Date().toISOString();
    this.lastActiveAt = this.createdAt;
    this.broadcast = broadcast;
    this.origin = origin ?? (config.resumeSessionId ? 'vscode' : 'clauder');
    this.permissionMode = config.permissionMode ?? 'bypassPermissions';

    // If resuming from an existing session (e.g. VS Code), pre-set the SDK session ID
    // and mark for forking so the original session file isn't modified
    if (config.resumeSessionId) {
      this.sdkSessionId = config.resumeSessionId;
      this.needsFork = true;
    }
  }

  /** Restore a session from persisted data (e.g. after server restart) */
  static restore(
    data: {
      id: string;
      config: SessionConfig;
      origin?: SessionOrigin;
      sdkSessionId: string | null;
      totalCostUsd: number;
      contextUsage: ContextUsage | null;
      messages: UIMessage[];
      permissionMode?: string;
      summary?: string | null;
      summaryGeneratedAt?: string | null;
      compactedContext?: string | null;
      pendingWakeup?: PendingWakeup | null;
      createdAt: string;
      lastActiveAt: string;
    },
    broadcast: (msg: WsOutboundMessage) => void,
  ): ManagedSession {
    const origin = data.origin ?? 'clauder';
    const config = { ...data.config, resumeSessionId: data.sdkSessionId || undefined };
    const session = new ManagedSession(config, broadcast, origin);

    // Override the auto-generated fields with persisted data
    (session as any).id = data.id;
    session.totalCostUsd = data.totalCostUsd;
    session.contextUsage = data.contextUsage;
    session.messages = data.messages;
    session.createdAt = data.createdAt;
    session.lastActiveAt = data.lastActiveAt;
    session.permissionMode = (data.permissionMode ?? data.config.permissionMode ?? 'bypassPermissions') as PermissionMode;
    session.summary = data.summary ?? null;
    session.summaryGeneratedAt = data.summaryGeneratedAt ?? null;
    session.compactedContext = data.compactedContext ?? null;

    // Restore pending wakeup if not past due
    if (data.pendingWakeup) {
      const scheduledMs = new Date(data.pendingWakeup.scheduledAt).getTime();
      const remainingMs = scheduledMs - Date.now();
      if (remainingMs > 0) {
        session.pendingWakeup = data.pendingWakeup;
        session.wakeupTimer = setTimeout(() => session.fireWakeup(), remainingMs);
      }
      // If past due, drop it silently — server was down past the firing time
    }

    // Clauder-native sessions: resume directly (we own the session file)
    // VS Code sessions: they were already forked on first use, so also resume directly
    session.needsFork = false;

    // Mark any pending (no-result) tool uses as failed — they're stale from a previous
    // server instance that died or restarted mid-query
    for (const msg of session.messages) {
      if (msg.toolUses) {
        for (const tu of msg.toolUses) {
          if (!tu.result) {
            tu.result = { content: 'Server restarted — tool result lost', isError: true };
          }
        }
      }
    }

    return session;
  }

  getState(): SessionState {
    return {
      id: this.id,
      config: this.config,
      status: this.status,
      origin: this.origin,
      sdkSessionId: this.sdkSessionId,
      totalCostUsd: this.totalCostUsd,
      error: this.error,
      currentToolActivity: this.currentToolActivity,
      contextUsage: this.contextUsage,
      messages: this.messages,
      queuedMessages: [...this.queuedMessages],
      permissionMode: this.permissionMode,
      pendingPermission: this.pendingPermission,
      pendingWakeup: this.pendingWakeup,
      summary: this.summary,
      summaryGeneratedAt: this.summaryGeneratedAt,
      compactedContext: this.compactedContext,
      debugLog: this.debugLog.slice(-200),
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt,
    };
  }

  /** Queue a message to be sent after the current turn finishes */
  queueMessage(message: string, images?: ImageAttachment[]): void {
    this.queuedMessages.push({ text: message, images: images?.length ? images : undefined });
    this.broadcast({
      type: 'queue_update',
      sessionId: this.id,
      queue: [...this.queuedMessages],
    });
  }

  /** Schedule a wakeup from a ScheduleWakeup tool call. Replaces any existing schedule. */
  private scheduleWakeup(input: any, toolUseId: string): void {
    this.clearWakeupTimer();

    // Clamp to [60, 3600] to match the ScheduleWakeup tool's documented bounds
    const rawDelay = Number(input?.delaySeconds) || 60;
    const delaySeconds = Math.max(60, Math.min(3600, Math.floor(rawDelay)));
    const scheduledAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
    const reason = String(input?.reason || '').slice(0, 500);
    const prompt = String(input?.prompt || '');

    this.pendingWakeup = { scheduledAt, reason, delaySeconds, prompt, toolUseId };
    this.wakeupTimer = setTimeout(() => this.fireWakeup(), delaySeconds * 1000);

    console.log(`[Session ${this.id}] Wakeup scheduled in ${delaySeconds}s at ${scheduledAt}`);
    this.broadcast({ type: 'wakeup_scheduled', sessionId: this.id, wakeup: this.pendingWakeup });
  }

  /** Fire the pending wakeup: send a continuation message to the session. */
  private fireWakeup(): void {
    if (!this.pendingWakeup) return;
    const wakeup = this.pendingWakeup;
    this.pendingWakeup = null;
    this.wakeupTimer = null;
    console.log(`[Session ${this.id}] Wakeup firing (reason: ${wakeup.reason})`);

    // Build a continuation message. If the prompt is the autonomous-loop sentinel,
    // Claude won't recognize it — send a generic continue with the reason for context.
    const isSentinel = wakeup.prompt === '<<autonomous-loop-dynamic>>' || wakeup.prompt === '<<autonomous-loop>>';
    const message = isSentinel
      ? `[Scheduled wakeup] Continue with the task.${wakeup.reason ? ` Reason: ${wakeup.reason}` : ''}`
      : wakeup.prompt;

    this.broadcast({ type: 'wakeup_cleared', sessionId: this.id });

    // Send as a normal user message (will be queued if session is currently working)
    this.sendMessage(message, []).catch(err => {
      console.error(`[Session ${this.id}] Wakeup send failed: ${err.message}`);
    });
  }

  /** Cancel a pending wakeup (user-initiated or new message). */
  cancelWakeup(): void {
    if (!this.pendingWakeup) return;
    this.clearWakeupTimer();
    this.pendingWakeup = null;
    console.log(`[Session ${this.id}] Wakeup canceled`);
    this.broadcast({ type: 'wakeup_cleared', sessionId: this.id });
  }

  private clearWakeupTimer(): void {
    if (this.wakeupTimer) {
      clearTimeout(this.wakeupTimer);
      this.wakeupTimer = null;
    }
  }

  /** Remove a queued message by index */
  dequeueMessage(index: number): void {
    if (index < 0 || index >= this.queuedMessages.length) return;
    this.queuedMessages.splice(index, 1);
    this.broadcast({
      type: 'queue_update',
      sessionId: this.id,
      queue: [...this.queuedMessages],
    });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.permissionMode = mode;
    // In v2, permission mode is a CLI startup flag — changes take effect on next query
    this.broadcast({ type: 'permission_mode_change', sessionId: this.id, mode: this.permissionMode });
  }

  setModel(model: string): void {
    this.config = { ...this.config, model: model || undefined };
    this.broadcast({
      type: 'model_changed',
      sessionId: this.id,
      model,
    });
  }

  setEffort(effort: string | undefined): void {
    this.config = { ...this.config, effort: (effort || undefined) as any };
    this.broadcast({
      type: 'effort_changed',
      sessionId: this.id,
      effort: effort || null,
    });
  }

  rename(newName: string): void {
    this.config = { ...this.config, name: newName };
    this.broadcast({
      type: 'session_renamed',
      sessionId: this.id,
      newName,
    });
  }

  setCwd(cwd: string): void {
    this.config = { ...this.config, cwd };
    // Clear SDK session ID — the old session was tied to the old project path
    // and can't be resumed in a different directory
    this.sdkSessionId = null;
    this.broadcast({
      type: 'cwd_changed',
      sessionId: this.id,
      cwd,
    });
  }

  /** Emit a debug log entry to both the in-memory array and WebSocket */
  private emitDebugLog(type: DebugLogEntryType, label: string, content: string, toolUseId?: string): void {
    const entry: DebugLogEntry = {
      id: uuid(),
      timestamp: new Date().toISOString(),
      type,
      label,
      content: content.slice(0, MAX_DEBUG_CONTENT_LENGTH),
      originalLength: content.length > MAX_DEBUG_CONTENT_LENGTH ? content.length : undefined,
      toolUseId,
    };
    this.debugLog.push(entry);
    if (this.debugLog.length > 500) {
      this.debugLog = this.debugLog.slice(-200);
    }
    this.broadcast({ type: 'debug_log', sessionId: this.id, entry });
  }

  /** Attach a tool result to the matching ToolUseInfo in messages */
  private attachToolResult(toolUseId: string, result: ToolResultInfo): void {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.toolUses) {
        const tu = msg.toolUses.find(t => t.id === toolUseId);
        if (tu) {
          tu.result = result;
          return;
        }
      }
    }
  }

  /** Look up the tool name for a given tool use ID */
  private findToolName(toolUseId: string): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.toolUses) {
        const tu = msg.toolUses.find(t => t.id === toolUseId);
        if (tu) return tu.name;
      }
    }
    return null;
  }

  private spawnClaudeProcess(extraArgs: string[], stdinPayload: string, keepStdinOpen = false): ChildProcess {
    // Validate cwd exists before spawning — missing cwd causes a misleading ENOENT on the binary
    if (!existsSync(this.config.cwd)) {
      throw new Error(`Working directory does not exist: ${this.config.cwd}`);
    }
    const cliArgs = [
      '--print',
      '--output-format=stream-json',
      '--input-format=stream-json',
      '--include-partial-messages',
      '--verbose',
      ...extraArgs,
    ];
    // Native binary (v2.1.120+): run directly. Legacy cli.js: run via node.
    const command = CLI_IS_NATIVE ? CLAUDE_CLI_PATH : process.execPath;
    const args = CLI_IS_NATIVE ? cliArgs : [CLAUDE_CLI_PATH, ...cliArgs];
    console.log(`[Session ${this.id}] Spawning: ${command} ${args.slice(0, 5).join(' ')} ...`);
    const proc = spawn(command, args, {
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Catch spawn errors (e.g. ENOENT) so they don't crash the process
    proc.on('error', (err) => {
      console.error(`[Session ${this.id}] Spawn error: ${err.message}`);
    });
    proc.stdin!.write(stdinPayload + '\n');
    if (!keepStdinOpen) proc.stdin!.end();
    return proc;
  }

  /** Send a tool result back to the active Claude process via stdin (for AskUserQuestion) */
  respondToQuestion(toolUseId: string, answer: string): void {
    if (!this.activeProcess?.stdin?.writable) {
      console.warn(`[Session ${this.id}] Cannot respond to question — no active writable process`);
      return;
    }
    const payload = JSON.stringify({
      type: 'tool_result',
      tool_use_id: toolUseId,
      result: answer,
    });
    console.log(`[Session ${this.id}] Sending question response for ${toolUseId}: ${answer.slice(0, 80)}`);
    this.activeProcess.stdin.write(payload + '\n');
  }

  private async *readNdjson(proc: ChildProcess): AsyncGenerator<unknown> {
    const queue: unknown[] = [];
    let done = false;
    let resolveNext: (() => void) | null = null;

    const enqueue = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        queue.push(JSON.parse(trimmed));
        if (resolveNext) { resolveNext(); resolveNext = null; }
      } catch {
        // skip non-JSON lines (e.g. npm warnings)
      }
    };

    // Handle spawn errors (e.g. ENOENT) — mark stream as done so the generator exits
    proc.on('error', () => {
      done = true;
      if (resolveNext) { resolveNext(); resolveNext = null; }
    });

    let partial = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      const text = partial + chunk.toString();
      const lines = text.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) enqueue(line);
    });

    proc.stdout!.on('end', () => {
      if (partial.trim()) enqueue(partial);
      done = true;
      if (resolveNext) { resolveNext(); resolveNext = null; }
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      const trimmed = chunk.toString().trim();
      if (trimmed) this.emitDebugLog('stderr', 'stderr', trimmed);
    });

    while (true) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else if (done) {
        break;
      } else {
        await new Promise<void>(resolve => { resolveNext = resolve; });
      }
    }

    // Wait for exit and check code
    const exitCode = await new Promise<number | null>(resolve => {
      if (proc.exitCode !== null) {
        resolve(proc.exitCode);
      } else {
        proc.once('close', (code) => resolve(code));
      }
    });

    // Non-zero exit that isn't from a signal (SIGINT=130, SIGTERM=143 on unix)
    // is a real error. Signal-killed processes are expected during interrupt/stall.
    if (exitCode !== null && exitCode !== 0 && exitCode !== 130 && exitCode !== 143) {
      throw new Error(`Claude process exited with code ${exitCode}`);
    }
  }

  async generateSummary(): Promise<string> {
    const conversationMsgs = this.messages
      .filter(m => m.role !== 'system')
      .slice(-20);

    if (conversationMsgs.length === 0) {
      return 'No messages yet.';
    }

    const transcript = conversationMsgs
      .map(m => `${m.role}: ${m.content.slice(0, 500)}`)
      .join('\n\n');

    const prompt = `Give a brief overview of this coding session as 2-4 short bullet points. Each bullet should be a few words, not full sentences. Focus on what was built/changed/fixed. Do NOT start with "This conversation..." or any preamble — just the bullets. Do NOT use any tools.\n\nExample format:\n• Added user auth endpoint\n• Fixed cart total calculation\n• Refactored DB queries\n\nConversation:\n${transcript}`;

    const flags = [
      '--permission-mode', 'plan',
      '--no-session-persistence',
      '--disallowed-tools', 'Read,Write,Edit,Bash,Glob,Grep,WebFetch,WebSearch,Task,TodoWrite,NotebookEdit',
    ];
    const stdinPayload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: prompt },
    });

    const proc = this.spawnClaudeProcess(flags, stdinPayload);
    const killTimeout = setTimeout(() => {
      console.warn(`[Session ${this.id}] Summary generation timed out after 2 minutes, killing`);
      proc.kill('SIGTERM');
    }, 120_000);

    console.log(`[Session ${this.id}] Starting summary generation...`);
    let summaryText = '';
    try {
      for await (const msg of this.readNdjson(proc)) {
        const m = msg as any;
        if (m.type === 'assistant') {
          const content = m.message?.content;
          if (content) {
            summaryText += content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
          }
        }
      }
      console.log(`[Session ${this.id}] Summary generation complete (${summaryText.length} chars)`);
      return summaryText || 'Unable to generate summary.';
    } catch (err: any) {
      console.error(`[Session ${this.id}] Summary generation failed:`, err.message);
      return 'Error generating summary.';
    } finally {
      clearTimeout(killTimeout);
    }
  }

  async sendMessage(message: string, images?: ImageAttachment[]): Promise<void> {
    // If busy, queue the message for later
    if (this.status === 'working') {
      this.queueMessage(message, images);
      return;
    }

    // Any new user input cancels a pending wakeup — Claude has fresh input now
    if (this.pendingWakeup) {
      this.cancelWakeup();
    }

    // Add user message to history
    const userMsgId = uuid();
    const userMsg: UIMessage = {
      id: userMsgId,
      role: 'user',
      content: message,
      images: images?.length ? images : undefined,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(userMsg);
    this.broadcast({ type: 'user_message_echo', sessionId: this.id, messageId: userMsgId, text: message, images: images?.length ? images : undefined });

    // Update status
    this.status = 'working';
    this.error = null;
    this.lastActiveAt = new Date().toISOString();
    this.broadcast({ type: 'state_change', sessionId: this.id, status: 'working' });
    console.log(`[Session ${this.id}] Starting query (resume=${!!this.sdkSessionId})`);

    // Stall detection: abort if no SDK messages for 8 minutes.
    // Must be longer than the max Bash timeout we recommend (5 min) plus buffer
    // for API processing, so the tool timeout fires first and returns a result.
    const STALL_TIMEOUT_MS = 8 * 60 * 1000;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let stallAborted = false;
    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        console.log(`[Session ${this.id}] Query stalled (no messages for 8 min), aborting`);
        stallAborted = true;
        this.activeProcess?.kill('SIGTERM');
      }, STALL_TIMEOUT_MS);
    };
    resetStallTimer();

    try {
      // Build CLI flags
      const flags: string[] = ['--permission-mode', this.permissionMode];

      if (this.sdkSessionId) {
        flags.push('--resume', this.sdkSessionId);
        if (this.needsFork) {
          flags.push('--fork-session');
        }
      }

      if (this.config.model) {
        flags.push('--model', this.config.model);
      }

      if (this.config.effort) {
        flags.push('--effort', this.config.effort);
      }

      // Controller mode: load the Clauder MCP server so this session can orchestrate others
      if (this.config.controllerMode && CLAUDER_MCP_PATH) {
        const mcpConfigPath = join(MCP_CONFIG_DIR, `${this.id}.json`);
        const mcpConfig = {
          mcpServers: {
            clauder: {
              command: process.execPath,
              args: [CLAUDER_MCP_PATH],
              env: {
                CLAUDER_URL: `http://localhost:${CLAUDER_PORT}`,
                CLAUDER_CONTROLLER_ID: this.id,
              },
            },
          },
        };
        writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
        flags.push('--mcp-config', mcpConfigPath);
      }

      const systemParts: string[] = [
        'When running Bash commands that involve SSH, SCP, network requests, package installs (apt-get, pip, npm), or builds, always set the timeout parameter to at least 300000 (5 minutes). The default 2-minute timeout is too short for these operations.',
      ];

      if (this.config.controllerMode) {
        systemParts.push(
          'You are the **controller** in a multi-session Clauder setup. Other Claude sessions ("workers") run in parallel; you orchestrate them via the `clauder` MCP tools.\n\n' +
          '**Worker control:**\n' +
          '- `list_sessions()` — see all available workers and status\n' +
          '- `send_message(sessionId, message)` — dispatch (returns immediately)\n' +
          '- `wait_until_idle(sessionId, timeoutSec)` — block until worker finishes its turn\n' +
          '- `get_recent_messages(sessionId, count)` — read what a worker did\n' +
          '- `get_session_status(sessionId)` — quick status check\n\n' +
          '**Self-managed watches (for long-running monitoring):**\n' +
          '- `add_watch(description, intervalSeconds, message)` — set up a recurring self-check-in. Every interval, the Clauder server will send the given message to you as if the user typed it.\n' +
          '- `list_watches()` — see your active watches\n' +
          '- `remove_watch(watchId)` — stop a watch (do this when monitoring is no longer needed)\n' +
          '- `update_watch(watchId, ...)` — adjust interval/message\n\n' +
          '**Overnight workflow:** dispatch tasks to workers with `send_message`, then add a watch like `add_watch("Check on project X", 1200, "Check on the project X worker. If idle, review its recent messages and decide next steps.")`. When that fires, investigate, possibly dispatch more work or remove the watch when done.\n\n' +
          '**Cost discipline:** Be focused. Don\'t add redundant watches. Remove watches the moment work completes. If a worker errors, read its messages before retrying.'
        );
      }

      if (this.config.systemPrompt) {
        systemParts.push(this.config.systemPrompt);
      }

      // Prime new session with context from prior conversation after a reset
      if (this.wasReset && !this.sdkSessionId) {
        let contextPayload: string | null = null;
        if (this.compactedContext) {
          contextPayload = this.compactedContext;
          console.log(`[Session ${this.id}] Priming with SDK compacted context (${contextPayload.length} chars)`);
        } else {
          const contextParts: string[] = [];
          if (this.summary) {
            contextParts.push(`## Prior conversation summary\n${this.summary}`);
          }
          const recentMessages = this.messages.slice(-20);
          if (recentMessages.length > 0) {
            const transcript = recentMessages
              .filter(m => m.role === 'user' || m.role === 'assistant')
              .map(m => {
                const content = typeof m.content === 'string' ? m.content : '[complex content]';
                const truncated = content.length > 500 ? content.slice(0, 500) + '...' : content;
                return `${m.role === 'user' ? 'User' : 'Assistant'}: ${truncated}`;
              })
              .join('\n\n');
            contextParts.push(`## Recent conversation history\n${transcript}`);
          }
          if (contextParts.length > 0) {
            contextPayload = contextParts.join('\n\n');
            console.log(`[Session ${this.id}] Priming with fallback context (${contextPayload.length} chars)`);
          }
        }

        if (contextPayload) {
          systemParts.push(
            'IMPORTANT: This session was reset because the previous conversation exceeded the API size limit. ' +
            'Below is context from the prior conversation to help you continue seamlessly. ' +
            'Do NOT mention this reset to the user — just pick up where things left off.\n\n' +
            contextPayload
          );
        }
        this.wasReset = false;
      }

      flags.push('--append-system-prompt', systemParts.join('\n\n'));

      if (this.config.maxBudgetUsd) {
        flags.push('--max-budget-usd', String(this.config.maxBudgetUsd));
      }

      if (this.config.maxTurns) {
        flags.push('--max-turns', String(this.config.maxTurns));
      }

      // Build stdin message
      let stdinPayload: string;
      if (images?.length) {
        const contentBlocks: any[] = [
          ...images.map(img => ({
            type: 'image' as const,
            source: { type: 'base64' as const, media_type: img.mimeType, data: img.data },
          })),
          { type: 'text' as const, text: message || 'What is in this image?' },
        ];
        stdinPayload = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: contentBlocks },
        });
      } else {
        stdinPayload = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: message },
        });
      }

      this.activeProcess = this.spawnClaudeProcess(flags, stdinPayload, true); // keep stdin open for AskUserQuestion

      let currentAssistantMsgId: string | null = null;

      for await (const msg of this.readNdjson(this.activeProcess)) {
        resetStallTimer(); // Got a message — reset stall detection

        // Capture session_id for resume. When forking, the CLI returns a new
        // session ID - grab it so subsequent messages use the fork, not the original.
        const anyMsg = msg as any;
        if (anyMsg.session_id) {
          if (!this.sdkSessionId || this.needsFork) {
            this.sdkSessionId = anyMsg.session_id;
            this.needsFork = false;
          }
        }

        switch ((msg as any).type) {
          case 'system': {
            const subtype = 'subtype' in (msg as any) ? (msg as any).subtype : null;
            if (subtype === 'init') {
              const sysMsg: UIMessage = {
                id: uuid(),
                role: 'system',
                content: `Session initialized (model: ${((msg as any).model ?? '').replace(/\[.*?\]$/, '')})`,
                timestamp: new Date().toISOString(),
              };
              this.messages.push(sysMsg);
            } else if (subtype === 'compact_boundary') {
              const meta = (msg as any).compact_metadata;
              const preTokens = meta?.pre_tokens;
              const postTokens = meta?.post_tokens;
              const trigger = meta?.trigger || 'auto';
              const sysMsg: UIMessage = {
                id: uuid(),
                role: 'system',
                content: `Context compacted (${trigger}) — was ${preTokens ? Math.round(preTokens / 1000) + 'k tokens' : 'unknown size'} before compaction`,
                timestamp: new Date().toISOString(),
              };
              this.messages.push(sysMsg);
              this.broadcast({
                type: 'assistant_message',
                sessionId: this.id,
                messageId: sysMsg.id,
                text: sysMsg.content,
              });
              // Update context usage with actual conversation token count from compact
              const contextWindow = this.contextUsage?.contextWindow || 200000;
              this.contextUsage = {
                inputTokens: postTokens || 0,
                outputTokens: 0,
                contextWindow,
              };
              this.broadcast({
                type: 'context_update',
                sessionId: this.id,
                contextUsage: this.contextUsage,
              });
              // The SDK injects a user message with the compacted summary right after this
              this.awaitingCompactSummary = true;
            }
            this.emitDebugLog('sdk_event', subtype || 'system', JSON.stringify(msg, null, 2));
            break;
          }

          case 'assistant': {
            this.lastActiveAt = new Date().toISOString();
            const assistantMsg = msg as any;
            const content = assistantMsg.message?.content;
            if (!content) break;

            // Reuse the streaming message ID if we have one, so the client
            // replaces the streaming message rather than adding a duplicate.
            // Fall back to the SDK's uuid, then generate one.
            const msgId: string = currentAssistantMsgId || (msg as any).uuid || uuid();

            // Extract text blocks
            const textBlocks = content
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text);

            // Extract tool uses
            const toolUses: ToolUseInfo[] = content
              .filter((b: any) => b.type === 'tool_use')
              .map((b: any) => ({ id: b.id, name: b.name, input: b.input }));

            const text = textBlocks.join('');

            if (toolUses.length > 0) {
              const lastTool = toolUses[toolUses.length - 1];
              this.currentToolActivity = {
                toolName: lastTool.name,
                description: summarizeToolInput(lastTool.name, lastTool.input),
              };
              this.broadcast({
                type: 'tool_activity',
                sessionId: this.id,
                activity: this.currentToolActivity,
              });
              for (const tu of toolUses) {
                this.emitDebugLog('tool_start', tu.name, JSON.stringify(tu.input, null, 2), tu.id);
              }
            }

            const uiMsg: UIMessage = {
              id: msgId,
              role: 'assistant',
              content: text,
              toolUses: toolUses.length > 0 ? toolUses : undefined,
              timestamp: new Date().toISOString(),
            };

            // Update existing message in-place (from streaming or prior partial),
            // or append if this is the first time we see this ID.
            const existingIdx = this.messages.findIndex(m => m.id === msgId);
            if (existingIdx >= 0) {
              this.messages[existingIdx] = uiMsg;
            } else {
              this.messages.push(uiMsg);
            }

            if (text || toolUses.length > 0) {
              this.broadcast({
                type: 'assistant_message',
                sessionId: this.id,
                messageId: msgId,
                text,
                toolUses: toolUses.length > 0 ? toolUses : undefined,
              });
            }

            // Detect ScheduleWakeup tool uses — set up a server-side timer to auto-resume
            for (const tu of toolUses) {
              if (tu.name === 'ScheduleWakeup') {
                this.scheduleWakeup(tu.input, tu.id);
              }
            }

            // Detect AskUserQuestion tool uses — broadcast interactive question to client
            for (const tu of toolUses) {
              if (tu.name === 'AskUserQuestion') {
                const questions = (tu.input as any)?.questions;
                if (Array.isArray(questions) && questions.length > 0) {
                  const q = questions[0]; // Show first question
                  this.broadcast({
                    type: 'pending_question',
                    sessionId: this.id,
                    toolUseId: tu.id,
                    question: {
                      question: q.question || '',
                      header: q.header,
                      options: q.options,
                    },
                  });
                  console.log(`[Session ${this.id}] AskUserQuestion detected: ${q.question?.slice(0, 80)}`);
                }
              }
            }

            // Reset for next turn so a new assistant message gets a fresh ID
            // rather than replacing this one.
            currentAssistantMsgId = null;
            break;
          }

          case 'stream_event': {
            const streamMsg = msg as any;
            const event = streamMsg.event;
            if (event?.type === 'content_block_delta' && event?.delta?.type === 'text_delta') {
              const delta = event.delta.text;
              if (!currentAssistantMsgId) {
                currentAssistantMsgId = uuid();
              }
              this.broadcast({
                type: 'assistant_message_stream',
                sessionId: this.id,
                messageId: currentAssistantMsgId,
                delta,
              });
            }
            break;
          }

          case 'user': {
            // After compaction, the SDK injects a user message with the compacted summary.
            // Capture it so we can use it to prime fresh sessions after a reset.
            if (this.awaitingCompactSummary) {
              this.awaitingCompactSummary = false;
              const content = (msg as any).message?.content;
              const summaryText = typeof content === 'string' ? content : '';
              if (summaryText && summaryText.includes('continued from a previous conversation')) {
                this.compactedContext = summaryText;
                console.log(`[Session ${this.id}] Captured compacted context (${summaryText.length} chars)`);
              }
            }
            // Capture tool results from user messages (tool_result content blocks)
            const userContent = (msg as any).message?.content;
            if (userContent && Array.isArray(userContent)) {
              for (const block of userContent) {
                if (block.type === 'tool_result') {
                  const toolUseId = block.tool_use_id;
                  let resultText = '';
                  if (typeof block.content === 'string') {
                    resultText = block.content;
                  } else if (Array.isArray(block.content)) {
                    resultText = block.content
                      .filter((c: any) => c.type === 'text')
                      .map((c: any) => c.text)
                      .join('\n');
                  }

                  const truncated = resultText.slice(0, MAX_TOOL_RESULT_LENGTH);
                  const result: ToolResultInfo = {
                    content: truncated,
                    isError: !!block.is_error,
                    originalLength: resultText.length > MAX_TOOL_RESULT_LENGTH ? resultText.length : undefined,
                  };

                  this.attachToolResult(toolUseId, result);
                  this.broadcast({ type: 'tool_result', sessionId: this.id, toolUseId, result });
                  this.emitDebugLog('tool_result', this.findToolName(toolUseId) || 'tool_result', truncated, toolUseId);
                }
              }
            }
            break;
          }

          case 'rate_limit_event': {
            const rle = msg as any;
            this.emitDebugLog('sdk_event', 'rate_limit', JSON.stringify(rle, null, 2));
            break;
          }

          case 'result': {
            const resultMsg = msg as any;
            const newTotal = resultMsg.total_cost_usd || this.totalCostUsd;
            const costDelta = newTotal - this.totalCostUsd;
            this.totalCostUsd = newTotal;
            if (costDelta > 0) recordCostDelta(costDelta);
            this.lastActiveAt = new Date().toISOString();
            const success = resultMsg.subtype === 'success';
            if (!success) {
              const errorText = resultMsg.result
                || (Array.isArray(resultMsg.errors) ? resultMsg.errors.join('; ') : '')
                || 'Unknown error';
              // Auto-recover on 413 request too large: reset SDK session and
              // re-send the last user message (it will be primed with compacted context)
              if (/request_too_large|413|prompt is too long/i.test(errorText) && this.sdkSessionId) {
                console.log(`[Session ${this.id}] Request too large (from result) — auto-recovering`);
                this.autoRecoverFrom413();
                // Don't set error — we're auto-recovering
              } else if (/No conversation found/.test(errorText) && this.sdkSessionId) {
                // Stale SDK session ID (e.g. from v1 migration) — clear it so next message starts fresh
                console.log(`[Session ${this.id}] SDK session not found — clearing stale ID ${this.sdkSessionId}`);
                this.sdkSessionId = null;
                this.needsFork = false;
                this.error = 'Session data not found (likely from migration). Send another message to start fresh.';
              } else if (/authentication_error|OAuth token has expired|401/.test(errorText)) {
                console.log(`[Session ${this.id}] Auth error — OAuth token expired`);
                this.error = 'AUTH_EXPIRED';
              } else {
                this.error = errorText;
              }
            }

            // Extract context usage from modelUsage
            // NOTE: modelUsage aggregates across ALL API calls in a multi-turn query,
            // so cache tokens are cumulative and can't represent a single context snapshot.
            // We extract contextWindow here, but rely on compact_boundary events for
            // accurate conversation token counts.
            if (resultMsg.modelUsage) {
              const usages = Object.values(resultMsg.modelUsage) as any[];
              if (usages.length > 0) {
                let totalInput = 0;
                let totalOutput = 0;
                let contextWindow = 0;
                for (const u of usages) {
                  totalInput += (u.inputTokens || 0) + (u.cacheCreationInputTokens || 0) + (u.cacheReadInputTokens || 0);
                  totalOutput += u.outputTokens || 0;
                  contextWindow = Math.max(contextWindow, u.contextWindow || 0);
                }
                // Use conversationTokens from compact_boundary if available,
                // otherwise don't update (keep previous value)
                if (this.contextUsage) {
                  this.contextUsage.contextWindow = contextWindow;
                  this.contextUsage.outputTokens = totalOutput;
                } else {
                  // First query — no compact_boundary yet, so no reliable conversation size
                  this.contextUsage = { inputTokens: 0, outputTokens: totalOutput, contextWindow };
                }
                this.broadcast({
                  type: 'context_update',
                  sessionId: this.id,
                  contextUsage: this.contextUsage,
                });
              }
            }

            this.broadcast({
              type: 'result',
              sessionId: this.id,
              costUsd: this.totalCostUsd,
              success,
              error: !success ? this.error || undefined : undefined,
            });

            // Close stdin so the process exits (we kept it open for AskUserQuestion support)
            try { this.activeProcess?.stdin?.end(); } catch {}
            break;
          }
        }
      }

      // Query completed
      this.retryCount = 0;
      this.consecutiveStalls = 0;
      this.status = 'idle';
      this.currentToolActivity = null;
      this.broadcast({ type: 'state_change', sessionId: this.id, status: 'idle' });
      console.log(`[Session ${this.id}] Query completed successfully`);
    } catch (err: any) {
      const errMsg = err.message || 'Unknown error';
      console.log(`[Session ${this.id}] Query error: ${errMsg}`);

      // Check if the last assistant message contains a 413 error
      // (the CLI emits the API error as an assistant message before exiting)
      const lastMsgContent = this.messages.length > 0
        ? this.messages[this.messages.length - 1].content
        : '';
      const has413InMessages = typeof lastMsgContent === 'string' && /request_too_large|413|prompt is too long/i.test(lastMsgContent);

      // Check for auth errors in stderr/messages
      const lastDebugEntries = this.debugLog.slice(-5).map(e => e.content).join(' ');
      const hasAuthError = /authentication_error|OAuth token has expired/.test(lastDebugEntries)
        || /authentication_error|OAuth token has expired/.test(errMsg);
      if (hasAuthError) {
        console.log(`[Session ${this.id}] Auth error — OAuth token expired`);
        this.status = 'error';
        this.error = 'AUTH_EXPIRED';
        this.currentToolActivity = null;
        this.broadcast({ type: 'state_change', sessionId: this.id, status: 'error', error: this.error });
        return;
      }

      if ((has413InMessages || /request_too_large|413|prompt is too long/i.test(errMsg)) && this.sdkSessionId) {
        console.log(`[Session ${this.id}] Request too large (from crash) — auto-recovering`);
        this.autoRecoverFrom413();
        return;
      }
      this.emitDebugLog('api_error', 'error', errMsg);

      // Detect fatal session errors: stalls (dangling tool_use in session file)
      // and SIGKILL (SDK process killed, often from OOM or corrupted session).
      // Recovery strategy when resuming an SDK session:
      // - 1st failure: fork the session (new branch may escape the stuck state)
      // - 2nd+ failure: abandon the SDK session entirely (start fresh)
      // When no SDK session (fresh query), SIGKILL usually means OOM.
      const isProcessKilled = /SIGKILL|SIGABRT|SIGSEGV/.test(errMsg);
      const isFatalSessionError = stallAborted || isProcessKilled;

      // 413 request_too_large: SDK session file is too bloated to resume.
      // Auto-reset the SDK session so the next message starts fresh.
      const isRequestTooLarge = /request_too_large|413|prompt is too long/i.test(errMsg);
      if (isRequestTooLarge && this.sdkSessionId) {
        console.log(`[Session ${this.id}] Request too large — abandoning SDK session ${this.sdkSessionId} to start fresh`);
        this.reset();
        this.status = 'error';
        this.error = 'Session too large for API. It has been auto-reset — your next message will start a fresh conversation.';
        this.currentToolActivity = null;
        this.broadcast({
          type: 'state_change',
          sessionId: this.id,
          status: 'error',
          error: this.error,
        });
        return;
      }

      // Clean exits (exit code 1 = API error, spending cap, etc.) should NOT
      // escalate the fatal error counter. Only signal-based kills should.
      if (!isFatalSessionError) {
        this.consecutiveStalls = 0;
      }

      if (isFatalSessionError && this.sdkSessionId) {
        this.consecutiveStalls++;
        if (this.consecutiveStalls >= 2) {
          console.log(`[Session ${this.id}] ${this.consecutiveStalls} consecutive fatal errors — abandoning SDK session ${this.sdkSessionId} to break failure loop`);
          this.sdkSessionId = null;
          this.needsFork = false;
        } else {
          console.log(`[Session ${this.id}] Fatal error on resume — will fork session on next message to escape stuck state`);
          this.needsFork = true;
        }
      }

      const isTransient = /500|502|503|529|internal server error|overloaded/i.test(errMsg);

      if (isTransient && this.retryCount < 3) {
        this.retryCount++;
        const delay = Math.min(1000 * Math.pow(2, this.retryCount - 1), 8000);
        console.log(`[Session ${this.id}] Transient API error, retry ${this.retryCount}/3 in ${delay}ms: ${errMsg}`);
        this.currentToolActivity = { toolName: 'Retry', description: `Attempt ${this.retryCount}/3 in ${Math.round(delay / 1000)}s...` };
        this.broadcast({ type: 'tool_activity', sessionId: this.id, activity: this.currentToolActivity });
        this.activeProcess = null;
        if (stallTimer) clearTimeout(stallTimer);
        await new Promise(resolve => setTimeout(resolve, delay));
        // Re-send the same message (it was already pushed to this.messages)
        const lastUserMsg = [...this.messages].reverse().find(m => m.role === 'user');
        if (lastUserMsg) {
          // Remove the user message so sendMessage re-adds it
          this.messages = this.messages.filter(m => m.id !== lastUserMsg.id);
          this.status = 'idle';
          return this.sendMessage(lastUserMsg.content, lastUserMsg.images);
        }
      }

      this.retryCount = 0;
      this.status = 'error';
      // Craft a helpful error message based on the failure mode
      if (isProcessKilled && !this.sdkSessionId) {
        // Fresh query got killed — almost certainly OOM
        this.error = 'Process killed (likely out of memory). Close other apps to free RAM and try again.';
      } else if (isFatalSessionError && this.consecutiveStalls >= 2) {
        this.error = 'Repeated fatal errors. SDK session abandoned — next message starts fresh (conversation history lost).';
      } else if (isFatalSessionError) {
        this.error = `Fatal error (${stallAborted ? 'stall' : 'process killed'}). Session will fork on next message to recover.`;
      } else {
        this.error = errMsg;
      }
      this.currentToolActivity = null;
      this.broadcast({
        type: 'state_change',
        sessionId: this.id,
        status: 'error',
        error: this.error || undefined,
      });
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      // Close stdin if still open (from keepStdinOpen for AskUserQuestion support)
      try { this.activeProcess?.stdin?.end(); } catch {}
      this.activeProcess = null;
    }

    // NOTE: We don't auto-compact from Clauder's side. The SDK handles compaction
    // internally based on actual conversation token counts. Our modelUsage numbers
    // include system prompt + tool definitions which inflate the percentage.

    // Drain the queue: if there are queued messages, send the next one
    if (this.queuedMessages.length > 0 && this.status === 'idle') {
      const next = this.queuedMessages.shift()!;
      this.broadcast({
        type: 'queue_update',
        sessionId: this.id,
        queue: [...this.queuedMessages],
      });
      // Fire and forget - the recursive call handles its own lifecycle
      this.sendMessage(next.text, next.images).catch(err => {
        console.error(`Error processing queued message for session ${this.id}:`, err);
      });
    }
  }

  reset(): void {
    this.sdkSessionId = null;
    this.needsFork = false;
    this.wasReset = true;
    this.status = 'idle';
    this.error = null;
    this.contextUsage = null;
    this.broadcast({ type: 'state_change', sessionId: this.id, status: 'idle' });
  }

  private autoRecoverFrom413(): void {
    const oldSdkId = this.sdkSessionId;
    this.reset();

    // Find the last user message to re-send
    const lastUserMsg = [...this.messages].reverse().find(m => m.role === 'user');
    const resendText = lastUserMsg?.content
      ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : 'Continue where you left off.')
      : 'Continue where you left off.';

    // Remove the last user message so sendMessage doesn't duplicate it
    if (lastUserMsg) {
      this.messages = this.messages.filter(m => m.id !== lastUserMsg.id);
    }

    // Add a system message so the user knows what happened
    const sysMsg: UIMessage = {
      id: uuid(),
      role: 'system',
      content: `Session too large (413) — auto-recovering with context from prior conversation. (Old SDK session: ${oldSdkId})`,
      timestamp: new Date().toISOString(),
    };
    this.messages.push(sysMsg);
    this.broadcast({ type: 'assistant_message', sessionId: this.id, messageId: sysMsg.id, text: sysMsg.content });

    console.log(`[Session ${this.id}] Auto-recovering from 413 — resending: "${resendText.slice(0, 80)}..."`);

    // Re-send with primed context (wasReset is true, so sendMessage will inject compacted context)
    this.sendMessage(resendText).catch(err => {
      console.error(`[Session ${this.id}] Auto-recovery failed:`, err.message);
      this.status = 'error';
      this.error = 'Auto-recovery from 413 failed. Click "Start Fresh" to try manually.';
      this.broadcast({ type: 'state_change', sessionId: this.id, status: 'error', error: this.error });
    });
  }

  async compact(): Promise<void> {
    // Send /compact as a user message to trigger context compaction
    await this.sendMessage('/compact');
  }

  async interrupt(): Promise<void> {
    this.cancelWakeup();
    if (this.activeProcess) {
      this.activeProcess.kill('SIGINT');
    }
  }

  async destroy(): Promise<void> {
    this.pendingPermission = null;
    this.clearWakeupTimer();
    this.pendingWakeup = null;

    if (this.activeProcess) {
      this.activeProcess.kill('SIGINT');
    }
  }
}

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return String(input.command || '').slice(0, 100);
    case 'Read':
      return String(input.file_path || '');
    case 'Write':
      return String(input.file_path || '');
    case 'Edit':
      return String(input.file_path || '');
    case 'Glob':
      return String(input.pattern || '');
    case 'Grep':
      return String(input.pattern || '');
    default:
      return toolName;
  }
}
