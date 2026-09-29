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
  - `client-view.ts` — what the browser gets, as opposed to what the server holds:
    `toClientState()` trims each session to its last `LIST_MESSAGE_TAIL` messages (+ real
    `messageCount`), swaps attachment blobs for `/api/attachments/...` URLs, and leaves out debug
    logs (a session's Debug tab fetches its own with `request_debug_log`). The connect
    payload was **66 MB** before this. Full history arrives via the `request_history` WS
    message when a session is opened. `getAllSessions()` stays full-fidelity — server-side
    search and the MCP endpoints read it.
  - `task-roster.ts` — tasks (the task selector; server-side these are parked threads): each
    task is its own CLI conversation carrying its own model/effort, restored on switch-back so
    it keeps its prompt cache. Tasks are only *lightly* aware of each other: one fixed
    system-prompt sentence points at `~/.clauder/task-rosters/<sessionId>.md`, rewritten on every
    task change; Claude reads it on demand. Never push task info into a conversation or edit the
    system prompt per switch — either would invalidate the prompt cache.
  - `tags.ts` — `TagManager`: the registry of user-defined colored session tags
    (`{id,label,color}`), persisted to `~/.clauder/tags.json` (atomic write,
    TriggerManager-style). Broadcasts the full snapshot on any CRUD. Sessions
    reference tags by id in `SessionConfig.tags`; deleting a tag cascades via
    `SessionManager.removeTagFromAllSessions`.
  - `projects.ts` — the new-session form's **New project** option: `ensureProjectFolder()` creates
    (or reuses) a folder by name directly inside the dev root (`~/development`; override with
    `CLAUDER_DEV_ROOT`), and `GET /api/projects` lists what's already there. The client sends only
    a name (`create_session.projectFolder`) and the server picks the path. The name rules live in
    shared `project-folder.ts` so the form and the server agree.
  - `ui-state.ts` — `UiStateManager`: view state that follows Jonathan across devices — when each
    session was last read, tabs closed from the tab menu, and pinned-tab order — persisted to
    `~/.clauder/ui-state.json` (TagManager-style, saves debounced 1s) and broadcast as a full
    `ui_state` snapshot on every change. Times use the server clock so they compare cleanly with
    `lastActiveAt`. Each browser merges its old localStorage copy up once (`merge_ui_state`), and
    keeps using it until a syncing server sends its first snapshot.
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
  `sessions.json.bak`, `project-runs.json`, `triggers.json`, `tags.json`, `ui-state.json`,
  `task-rosters/`, `clauder.log`, `backups/`, `mcp-configs/`.

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

10. **Upgrading a model is a three-part change — never just swap the
    picker.** A session persists the model ID it was configured with, so an
    ID dropped from `MODELS` keeps running in every session already pinned to
    it while the UI shows something else. Always: (a) add the new ID to
    `MODELS` in `ModelEffortSelector.tsx` and to `session.ts`'s two guidance
    blocks, and if it's the new default, `DEFAULT_MODEL` in both `models.ts`
    and `ModelEffortSelector.tsx`; (b) map **every** ID it replaces to it in
    `RETIRED_MODELS` (`models.ts`) — `ManagedSession.restore` rewrites session
    config, parked tasks, and pinned model-plan steps on load; (c) leave the
    old labels in the label maps (`SessionView.tsx`, `RateLimitBar.tsx`,
    `PlanBanner.tsx`) so past cost rows and plan banners still read right.
    Then check `~/.clauder/sessions.json` for IDs no longer in `MODELS` and
    map those too. The picker shows an unmapped ID greyed, as itself — it must
    never name a model the session isn't running.

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
- Underlying Claude Code CLI: `@anthropic-ai/claude-code` v2.1.284.

## Discovered during sessions
- Headless `--print` mode disables AskUserQuestion and ExitPlanMode: sessions must ask questions in plain text (answers to already-pending questions are delivered as queue-jumping messages, not stdin tool_results), and plans are detected via the clauder-steps text block, not the tool call.
- Claude Code sessions run as child processes of the Clauder server, so `launchctl kickstart -k` kills the server *and* any session running inside it mid-turn (looks like a random "interruption") — always restart from a standalone terminal, never from inside a Clauder session.
- ANTHROPIC_API_KEY is unset in prod; task-classifier.ts auto-compact silently no-ops — use CLI-subprocess pattern, not the API, for out-of-band LLM calls.
- Model choice: **Opus 5.5 (`claude-opus-5-5`) is the only Opus on offer** — $4/$20 per Mtok with $0.20/Mtok cache reads, against Opus 5's $5/$25 and ~$0.50 cache reads. That gap matters because re-reading context dominates long agentic turns (a measured AutoEdit turn: 10.8M cache-read tokens, 63% of its cost). Opus 5 and Opus 4.8 were retired from the picker, along with the older `claude-opus-4-6` / `claude-sonnet-4-6` / `claude-fable-5` pins and the bare `opus` / `sonnet` / `haiku` aliases — all mapped forward in `models.ts`. See hard rule 10 for the checklist. Session default is Sonnet 5.5 (`claude-sonnet-5-5`, `DEFAULT_MODEL` in `models.ts` and `ModelEffortSelector.tsx`): it replaced Sonnet 5 on Sep 29, 2026 at the same $2/$10 price, and `claude-sonnet-5` maps forward to it.
- Steer sessions to Clauder-native scheduling and monitoring: <<schedule_trigger>> + ScheduleWakeup instead of CLI/cron, and the <<monitor>> sentinel (MonitorController) instead of the headless-broken CLI Monitor tool. --append-system-prompt reaches only the top-level session, not Task sub-agents, so the parent session must own all scheduling/monitoring.
- Hover-only controls (`opacity-0 group-hover:opacity-100`) are invisible on phones — gate the hiding behind Tailwind's `[@media(hover:hover)]:` variant so touch devices still see them.
- Phone and browser JS crashes are logged in ~/.clauder/clauder.log on lines containing client:mobile — check there first.
- CLAUDE.md candidate text must not contain a closing square bracket; the extractor truncates at the first one.
- Per-model cost comparisons come from ~/.clauder/cost-ledger.json — there is no local price table
- To re-price cost-ledger turns from tokens, charge cache writes at 2x input and count thinking inside output
- Older clauder.log lines lack timestamps; bound log searches by line number from a known timestamp, not string comparison
- The CLI deletes transcripts idle past cleanupPeriodDays, default 30; resuming then fails with No conversation found
- Opus 5.5 and Sonnet 5.5 send between-tool progress notes as thinking blocks, not text blocks
- When changing a model ID, grep for the old ID; SCRATCH_MODEL, DEFAULT_EXECUTOR_MODEL, CLAUDE_CODE_SUBAGENT_MODEL and TaskSelector hardcode it too
- Every session gets a model: createSession and restore() fill in DEFAULT_MODEL, since with no --model flag the CLI runs its own default while the picker shows Clauder's
- Clauder shows thinking-block text as muted progress notes (UIMessage.thinking); sentinels, CLAUDE.md candidates and error sniffs read text blocks only
- CLAUDE_CODE_SUBAGENT_MODEL only covers sub-agents launched without a model; named models and built-in Explore bypass it
- Context-error auto-recovery must react only to CLI-written messages (is_api_error_message, model <synthetic>); matching Claude's own prose made a reply about the error loop
- Client re-renders: per-message and per-card components use useSessionActions()/useTagRegistry() plus React.memo; any useSessions() inside re-renders them on every WS message
- Animate only transform or opacity: the width/margin progress bar forced 60-120 page layouts a second, ~15% of the tab's CPU
