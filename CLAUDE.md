# CLAUDE.md — Clauder

Web interface to the Claude CLI. **Lets Jonathan run ~18 concurrent Claude
sessions in parallel across his businesses from a browser instead of juggling
terminal tabs.** This is the meta-tool that makes every other project
tractable — treat it with corresponding care.

**This is the live, deployed copy at `/Users/jsweet/clauder/`.** Launched by
launchctl as `com.jsweet.clauder` from `dist/index.js`. A separate copy at
`/Users/jsweet/Documents/Clauder/` is a stale fork — do not edit it.

## Stack

- TypeScript monorepo (npm workspaces): `packages/shared`, `packages/server`,
  `packages/client`, `packages/mcp-server`.
- Server: Node.js, WebSocket-based session multiplexer.
- Client: React + Vite + TSX.
- MCP server: separate Node package — runs as a child process loaded by
  controller sessions, lets one Claude orchestrate the others.
- Spawns the Claude CLI binary (or `cli.js`) per session as a child process.
- Persists sessions, triggers, debug logs, and config across server restarts.

## Layout

- `packages/shared/src/` — shared types (`messages.ts`, `session.ts`).
- `packages/server/src/`:
  - `index.ts` — entrypoint; wires TriggerManager + SessionManager + WS server.
  - `server.ts` — HTTP server (REST endpoints used by MCP server).
  - `ws.ts` — WebSocket inbound/outbound message router.
  - `session.ts` (~1300 lines) — the `ManagedSession` class. Spawns/manages
    the Claude CLI child process, parses output, tracks tool activity,
    handles pending permissions, computes context usage, schedules wakeups.
    **The heart of the system.**
  - `session-manager.ts` — session lifecycle, persistence orchestration.
  - `persistence.ts` — disk persistence under `~/.clauder/sessions/`.
  - `discovery.ts` — finds and surfaces existing Claude CLI sessions from
    `~/.claude/projects/` so they can be resumed.
  - `triggers.ts` — `TriggerManager`: scheduled and recurring message fires.
    Persists to `~/.clauder/triggers.json`. Fires by calling
    `sessionManager.sendMessage(sessionId, message)`.
  - `auth.ts` — token-based auth.
  - `rate-limits.ts` — cost tracking against the API.
- `packages/mcp-server/src/index.ts` — standalone MCP server exposing
  `list_sessions`, `send_message`, `wait_until_idle`, `get_recent_messages`,
  `get_session_status`, `add_watch`, `list_watches`, `remove_watch`,
  `update_watch`. Stdio transport; talks to the main server over HTTP + WS.
- `packages/client/src/components/` — React components: `Dashboard.tsx`,
  `SessionView.tsx`, `SessionCard.tsx`, `MessageBubble.tsx`,
  `ToolUseAccordion.tsx`, `FileBrowser.tsx`, `WatchPanel.tsx`,
  `SchedulerModal.tsx`, `WakeupBanner.tsx`, `NotificationToggle.tsx`,
  `EffortSelector.tsx`, `ModelSelector.tsx`.
- `packages/client/src/lib/notifications.ts` — browser Notification API
  wrapper + unread badge tracking.
- `~/.clauder/` (outside repo) — runtime state: `auth-token`, `sessions.json`,
  `triggers.json`, `start-clauder.sh`, `clauder.log`, `backups/`,
  `mcp-configs/` (per-session MCP configs written at startup).

## How sessions work (non-obvious)

- A new session spawns the Claude CLI as a child process. **The CLI binary
  location is auto-discovered** by walking up from `session.ts` looking for
  either `node_modules/@anthropic-ai/claude-code/bin/claude.exe` (native,
  v2.1.120+) or `cli.js` (legacy).
- VS Code sessions can be **adopted** via `resumeSessionId`. When adopted,
  the session is **forked** (`needsFork = true`) so the original session
  file isn't mutated.
- All messages broadcast through a single `broadcast(msg)` callback set in
  the constructor — every session's events fan out to every connected WS
  client.
- **Controller mode** (`config.controllerMode`) writes an MCP config file
  to `~/.clauder/mcp-configs/{sessionId}.json` and passes `--mcp-config` to
  the CLI. The controller session can then call `clauder.*` MCP tools to
  manage workers.

## State-machine flags — `pending*` convention

Multiple async states are tracked via nullable fields on `ManagedSession`:

- `pendingPermission: PendingPermission | null` — CLI requested a permission;
  UI must answer.
- `pendingWakeup: PendingWakeup | null` — scheduled wakeup with timer;
  cancelled when user sends new input.
- `pendingQuestion` (client-side, `SessionContext.tsx`) — AskUserQuestion
  awaiting answer.

**New flags should follow this pattern.** Leaving a `pending*` field
non-null with no path to clear it = stuck session.

## Hard rules

1. **`session.ts` is the load-bearing file.** A bug here breaks every
   workflow Jonathan has. Read it whole before touching it. Don't refactor
   defensively — every existing branch was added for a real failure.

2. **Permission flow is a state machine.** `pendingPermission` is set when
   the CLI requests a permission and the UI must answer. Don't add code
   paths that leave it stuck non-null — that hangs the session.

3. **Tool result content is truncated at `MAX_TOOL_RESULT_LENGTH` (10,000
   chars).** Don't raise this without considering WS message size and
   client render perf — bumping it has caused renderer freezes before.

4. **Persistence is best-effort on shutdown.** Don't assume every in-memory
   state survives a server restart — design new state to be reconstructable
   from disk + the next CLI message. `pendingWakeup` is the model:
   persisted to disk, timer rescheduled on restore.

5. **The `--dangerouslySkipPermissions` / `bypassPermissions` default
   mode** is what makes this productive at 18 sessions. Removing it would
   mean prompting on every tool call. If a security concern surfaces,
   harden in `auth.ts` rather than removing bypass.

6. **`~/.clauder/sessions/` is the persistence root.** Don't change the
   schema without a migration — losing all session history would erase
   weeks of context across every business.

7. **Triggers and wakeups fire programmatic messages through
   `sendMessage()`.** Any new logic in `sendMessage()` that assumes "this
   came from a human typing" is wrong. Use an `internal` flag (added to
   `sendMessage` signature) to distinguish programmatic from user input.

8. **Controller mode writes per-session MCP configs.** When a session is
   destroyed, its MCP config file in `~/.clauder/mcp-configs/` is
   orphaned. Cleanup is best-effort — not a bug worth chasing unless disk
   fills up.

9. **Build before restart.** The launchctl service runs the compiled
   `dist/index.js`. After editing TS, run `npm run build` (or per-package
   build) before `launchctl kickstart -k gui/$(id -u)/com.jsweet.clauder`.

## Common commands

```bash
# Dev (concurrently runs server + client)
npm run dev

# Build all packages (must run before restart)
npm run build

# Type check (workspaces separately — top-level tsc won't traverse refs)
npx tsc --noEmit -p packages/shared/tsconfig.json
npx tsc --noEmit -p packages/server/tsconfig.json
npx tsc --noEmit -p packages/client/tsconfig.json
npx tsc --noEmit -p packages/mcp-server/tsconfig.json

# Restart the launchctl-managed service after a build
launchctl kickstart -k gui/$(id -u)/com.jsweet.clauder

# Check service status
launchctl list | grep clauder

# Find / kill stuck dev servers
lsof -iTCP -sTCP:LISTEN -P | grep -E '3001|5173|5174'

# Tail the production log
tail -f ~/.clauder/clauder.log
```

## Related

- `~/Documents/Clauder Controller/` — separate companion project.
- `~/Documents/Clauder/` — **stale fork**. Do not edit. Slated for deletion.
- `~/.clauder/` — runtime state (not in repo).
- Underlying Claude Code CLI: `@anthropic-ai/claude-code` (in `node_modules`).
