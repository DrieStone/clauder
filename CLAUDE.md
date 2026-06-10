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
- Spawns the Claude CLI binary (`bin/claude.exe`, v2.1.162+) per session.
- Persists sessions, triggers, project runs, and debug logs across restarts.

## Layout

- `packages/shared/src/` — shared types (`messages.ts`, `session.ts`,
  `project-run.ts`).
- `packages/server/src/`:
  - `index.ts` — entrypoint; wires TriggerManager + SessionManager +
    ProjectRunner + WS server.
  - `server.ts` — HTTP server (REST endpoints used by MCP server).
  - `ws.ts` — WebSocket inbound/outbound message router.
  - `session.ts` — the `ManagedSession` class. **The heart of the system.**
    Spawns/manages the CLI child process, parses NDJSON stream, tracks tool
    activity, handles question timeouts (`pendingQuestion` gate), wakeups,
    `waitingFor` state, and emits `state_change` broadcasts.
  - `session-manager.ts` — session lifecycle, persistence orchestration.
  - `persistence.ts` — **atomic writes** (temp + rename) + rolling `.bak` +
    timestamped backups to `~/.clauder/backups/`. Refuses to clobber on
    corrupt load — recovers from backup or aborts loudly.
  - `project-runner.ts` — `ProjectRunner`: server-side supervise loop that
    drives autonomous overnight runs. Budget gate, verification gate, restart
    survival.
  - `project-runs.ts` — persistence for `ProjectRun` records at
    `~/.clauder/project-runs.json`.
  - `claude-md.ts` — `extractClaudeMdCandidates` + `applyClaudeMdCandidate`
    (deduplicating append). Auto-called on every assistant message.
  - `discovery.ts` — finds existing Claude CLI sessions from
    `~/.claude/projects/` for adoption.
  - `triggers.ts` — `TriggerManager`: scheduled and recurring message fires.
    Persists to `~/.clauder/triggers.json`. Supports both `'once'` and
    `'recurring'` schedules. Has a `sessionExists` guard to disable orphaned
    triggers.
  - `auth.ts` — token-based auth.
  - `rate-limits.ts` — dual tracking: $-cost proxy (always available) +
    real subscription windows parsed from the CLI's `rate_limit_event`
    (`five_hour` / `seven_day` utilization + `resetsAt`).
  - `task-classifier.ts` — out-of-band Haiku call to detect new-task context
    switches (for auto-compact).
- `packages/mcp-server/src/index.ts` — MCP tools for controller sessions:
  `list_sessions`, `send_message`, `wait_until_idle`, `get_recent_messages`,
  `get_session_status`, `add_watch`, `list_watches`, `remove_watch`,
  `update_watch`, **`get_rate_limit`** (real subscription quota).
- `packages/client/src/components/` — key React components: `Dashboard.tsx`,
  `SessionView.tsx`, `SessionCard.tsx`, `MessageBubble.tsx`,
  `ToolUseAccordion.tsx`, `SchedulerModal.tsx` (two tabs: Scheduled Tasks +
  Overnight Runs), `StatusBadge.tsx` (includes "Waiting" variant),
  `RateLimitBar.tsx` (real subscription %).
- `packages/client/src/lib/notifications.ts` — browser Notification API.
- `~/.clauder/` (outside repo) — runtime state: `auth-token`, `sessions.json`,
  `sessions.json.bak`, `project-runs.json`, `triggers.json`, `clauder.log`,
  `backups/`, `mcp-configs/`.

## How sessions work (non-obvious)

- A new session spawns the CLI as a child process. **Auto-discovered** by
  walking up from `session.ts` looking for `bin/claude.exe` (v2.1.120+).
- VS Code sessions can be **adopted** via `resumeSessionId` — forked so the
  original session file isn't mutated.
- All messages fan out via a single `broadcast(msg)` callback. `ProjectRunner`
  is also wired into this broadcast to observe executor session events.
- **Controller mode** (`config.controllerMode`) writes an MCP config to
  `~/.clauder/mcp-configs/{sessionId}.json`. Cleaned up on session destroy.

## State-machine flags — `pending*` convention

Multiple async states are tracked via nullable fields on `ManagedSession`:

- `pendingPermission: PendingPermission | null` — CLI requested a permission.
- `pendingWakeup: PendingWakeup | null` — scheduled wakeup with timer;
  persisted to disk, rescheduled on restart.
- `pendingQuestion: { toolUseId, askedAt } | null` — server-side
  AskUserQuestion gate. Arms a `questionTimeoutSeconds` timer (default 5 min)
  that auto-proceeds with best-judgment if no answer arrives. Also sets
  `waitingFor = 'question'` and broadcasts it.
- `waitingFor: string | null` — what the session is currently blocked on.
  Drives the amber "Needs you" card indicator and floats the session to the
  top of the Active tier on the Dashboard.

**New flags must follow this pattern.** Leaving a `pending*` field non-null
with no path to clear it = stuck session.

## Data safety rules (hard-won)

- **`saveSessions()` uses atomic writes** (temp file + rename). A crash
  mid-write leaves either the old complete file or a stray `.tmp` — never a
  truncated `sessions.json`.
- **On corrupt load**, the server copies the bad file aside, recovers from
  `.bak` or a timestamped backup, and throws if nothing is usable (instead of
  starting empty and overwriting with `[]`).
- **Periodic backups** every 10 min while running; startup backup before
  restore. Max 48 backups kept (~8 hours).
- **`terminateAll()` on shutdown** — kills CLI child processes without touching
  the session map or re-persisting. `persistNow()` runs first; the final save
  is never overwritten.
- Same atomic-write + `.bak` pattern applies to `triggers.json` and
  `project-runs.json`.

## Hard rules

1. **`session.ts` is the load-bearing file.** Read it whole before touching
   it. Don't refactor defensively — every branch was added for a real failure.

2. **Permission flow is a state machine.** `pendingPermission` set with no
   path to clear it = hung session.

3. **Tool result content is truncated at `MAX_TOOL_RESULT_LENGTH` (10,000
   chars).** Raising this has caused renderer freezes.

4. **Persistence is best-effort on shutdown.** Design new state to be
   reconstructable from disk + the next CLI message. `pendingWakeup` is the
   model.

5. **`bypassPermissions` default mode** is what makes 18 parallel sessions
   productive. Harden in `auth.ts` rather than removing bypass.

6. **`~/.clauder/sessions.json` is the persistence root.** Don't change the
   schema without a migration.

7. **Triggers and wakeups fire through `sendMessage()` with `internal: true`.**
   Any new logic in `sendMessage()` that assumes "this came from a human" is
   wrong.

8. **Controller mode MCP configs are cleaned up on `destroy()`.**

9. **Build before restart.** After editing TS, run `npm run build` before
   `launchctl kickstart -k gui/$(id -u)/com.jsweet.clauder`.

## Overnight Project Runner

`ProjectRunner` (`project-runner.ts`) drives autonomous coding runs:

1. **Negotiation phase** — executor inspects the repo, asks the human about
   every foreseeable blocker (credentials, ambiguities, destructive ops),
   writes `CONTRACT.md` with scope / done-criteria / budget / decision
   authority / anticipated blockers & resolutions. Emits a machine-readable
   `<<contract>>{...}<<>>` sentinel. Human approves via the "Automation" modal.
2. **Autonomous phase** — server-side supervise loop fires on every
   executor-idle event: budget gate (checks real subscription limits) →
   deadline gate → verification gate (`execFile` runs `verifyCommands`) →
   re-prompt or finish.
3. **Sleep/resume** — on `rejected` status, schedules a `TriggerManager`
   `'once'` trigger at `resetsAt` (from the real rate-limit data) to resume
   automatically.
4. **Ledger** lives on disk in the repo (`PLAN.md`, `STATE.json`,
   `DECISIONS.md`, `REPORT.md`). Survives context compaction, restarts, and
   sleep/resume cycles.
5. **Never stalls** — executor sessions use `questionTimeoutSeconds: 45`.

Executor sessions are `bypassPermissions`, run in the repo's `cwd`, and
auto-pick up the project's `CLAUDE.md`.

## Common commands

```bash
# Dev (concurrently runs server + client)
npm run dev

# Build all packages (must run before restart)
npm run build

# Install deps (server runs with NODE_ENV=production — must pass --include=dev)
npm install --include=dev

# Restart the launchctl-managed service (DO NOT run from inside a Clauder session)
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
- Underlying Claude Code CLI: `@anthropic-ai/claude-code` v2.1.162.

## Discovered during sessions
- AskUserQuestion auto-fails in headless CLI mode; deliver answers as queue-jumping messages, not stdin tool_results.
- Claude Code sessions run AS CHILD PROCESSES of Clauder. Running `launchctl kickstart -k` from inside a Clauder session kills the server, which kills the session mid-turn — causing an apparent "interruption". Never attempt a kickstart from within Clauder; instruct Jonathan to run it in a standalone terminal instead.
