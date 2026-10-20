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
  - `auth.ts` — who's connecting (`resolveAccess`), checked on every API request and WebSocket: the
    owner (this Mac; a Tailscale device, both ends on Tailscale addresses; or a device that opened the
    owner link `/owner/<token>` once, which sets a cookie), a share-link guest, or nobody. Being on
    the Wi-Fi isn't owner access: guests are on that network too. `network.ts` classifies addresses.
  - `shares.ts` + `guest-view.ts` — share links: one session per named guest, local network only,
    until revoked (`~/.clauder/shares.json`). A guest connection gets only its session's events
    (`forGuest`) and a sanitized copy of it (`toGuestState`), and may only watch, load history, send
    messages (with attachments, re-checked as untrusted by `guestAttachments`) and stop a turn. Each
    guest message reaches Claude behind `guestNote` (who wrote it and the owner's rules for them),
    sent as the first content block so it covers attachments too; the chat keeps the guest's words
    with `UIMessage.author`. Both composers read files through the client's `lib/attachments.ts`.
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
  - `project.ts` — projects: a main session plus **tasks**, each task a full session of its own
    (`SessionConfig.mainSessionId`) in the main session's folder, free to run alongside it. The
    dashboard shows one card per project ("🧵 N tasks"), the tab bar one tab, and the client's
    `ProjectTasks.tsx` task bar (above the message box) switches between them; a share link covers
    the whole project (guests can switch tasks and write in any). Only the main session commits:
    tasks never touch git state and check finished work in with
    `<<to_main>>{"checkin":true,"summary","files"}<<>>`; sessions message each other by name with
    `<<to_task>>`, and `/task <what>` (a Clauder command in the "/" menu) has the current session
    write a handoff whose `<<new_task>>` starts a task. SessionManager delivers these as internal
    messages with `author.sessionId`, capped at `MAX_RELAYS_WITHOUT_OWNER` (10) until a person writes.
    **Prompt-cache rule:** never change an existing session's system prompt for this — the main
    session keeps its own, reads the task list from its roster file, and gets the commit rules as a
    note on each message (`describeProject`, skipped for slash commands); only a task, being new, has
    rules in its system prompt. Destroying the main destroys its tasks; archive refuses a task.
  - `project-notes.ts` — each project's shared **notes board**: any of its sessions posts with
    `<<note>>{"text"}<<>>`, and a task's `<<to_main>>{"checkin":true,...}` is posted there too, so
    neither wakes anyone. Each session gets the notes it hasn't seen (others' only, newest 25) on its
    next message via `describeProject`, plus `NOTES_REMINDER`; never in the system prompt. Direct
    `<<to_task>>`/`<<to_main>>` messages are kept for what another session must act on now. Measured
    before this (Oct 18): session-to-session turns were 8% of a week's spend, 84 of 111 in one project
    whose check-ins couldn't be acted on (`test-harness/turn-sources.py` re-measures). Saved to
    `~/.clauder/project-notes.json`. **Closing a task** (`SessionManager.closeTask`, the task chip's ✕
    and "Close task…") writes a summary of its work with one Sonnet one-shot on Clauder's copy of the
    chat (plain fallback if that fails), posts it to the board, keeps it for good in `closed` (listed
    under "Closed tasks" in the project's roster file), then deletes the task.
  - `task-roster.ts` — the roster file each session's system prompt already points at
    (`~/.clauder/task-rosters/<sessionId>.md`). For a project's main session it holds the
    project's task list (project.ts). The older parked-thread tasks (`parkThread`/`resumeThread`)
    have no UI any more; leftover parked threads become task sessions at startup.
  - `scratch.ts` — Scratch holds quick **conversations**, each a session of its own: a task of the
    Scratch session with `config.scratchConversation` and no project rules (Opus 5.5 at medium by
    default, named from its first message). The client's `openScratch` (`lib/scratch.ts`) reopens
    the one in use, or a fresh one after 6 hours away. One untouched 30 days is deleted (hourly
    sweep) unless kept (`config.keep`); at most 60. "Make it a session…" (client `ScratchBar.tsx`)
    promotes one where it is, or has Claude write a handoff whose `<<new_task>>` starts a session in
    a new dev-root folder or a task of a project. Scratch's own conversation moved out once
    (`scratchSplitAt`); its chat now holds the scheduled jobs aimed at it, shown as "⏰ Jobs".
  - `folder-notes.ts` — when a session changes files in another session's folder (another project:
    Edit/Write calls exactly, shell commands by a best guess), that session gets a line in its chat
    and, for Claude, a note on its next message (`describeProject`, never the system prompt). Its own
    project, Scratch's folder, and broad folders (home, ~/development) are left out. Pending notes
    persist to `~/.clauder/folder-notes.json`.
  - `api-credits.ts` — when the subscription is out of usage (`subscriptionBlockedUntilMs()` in
    rate-limits.ts: a window `rejected` with its reset still ahead), a session the owner allowed
    (`config.apiCredits`) or approved with "Use API credits now" retries on the owner's Anthropic API
    credit instead of sleeping, via `session.ts`'s `apiPlan` (one per turn, null on ordinary turns).
    Off unless switched on in the usage panel (client `ApiCreditsModal.tsx`); never for a guest's
    message; monthly, daily and per-turn budgets (the CLI enforces the last with `--max-budget-usd`);
    Fable runs as Opus 5.5, effort capped at high. The key is `~/.clauder/api-key` (user-created,
    never in the repo or settings), handed to the CLI as `--settings {"apiKeyHelper": ...}` so it
    never enters the environment every Bash call inherits. A key not tied to a workspace (sk-ant-usr-...) also needs `settings.workspaceId`, sent as `anthropic-workspace-id` through the same `--settings` env block. API turns skip `recordSubscriptionLimits`,
    `recordCostDelta` and the cost ledger (they aren't subscription usage); spend goes to
    `~/.clauder/api-credits.json`. A refused key or empty account pauses it (`problem()`).
  - `background-tasks.ts` — each turn is its own CLI process, so a command or agent started with
    `run_in_background` dies when the turn ends (the next turn's CLI reports "didn't finish before the
    previous session ended"; far more of these than restarts). `BackgroundTracker` reads a turn's tool
    calls; when a turn ends successfully with such work not waited on (TaskOutput/TaskStop) and nothing
    coming back for it (wakeup, `<<monitor>>`, `<<schedule_trigger>>`, watch), the chat gets a ⚠️ line
    and, if no person is queued and the session isn't in goal mode or a model plan, Claude is told to
    redo it with nohup + a monitor. At most 2 such messages in a row until a person writes.
  - Cross-project messages: `<<to_session>>{"session","message"}` sends to another project's session
    by name (`SessionManager.deliverToSession`), only if the sender's main session lists it in
    `config.canMessage` (the ⚙ menu's "Can message…"), or as an answer within a day of being
    messaged by it. Never to or from a project shared with a guest; capped at
    `MAX_RELAYS_WITHOUT_OWNER` per pair of projects until a person writes in either. The receiver
    gets `crossRelayNote` (`author.crossProject`); a whitelisted sender gets `canMessageNote` on each
    message, never in its system prompt.
  - `keep-warm.ts` — keeps prompt caches from expiring (a cold resume re-sends the whole
    conversation: $6-12 on big Opus sessions, 266 times in Oct 1-20). A project is warm automatically
    for 3h after the owner writes in it while they're "around" (any non-heartbeat WS message in the
    last 2h), or by hand via the header's 🔥 (3h default, 1h, until 11 PM). Each still-warm session in
    it (last call 54-60 min ago) gets `ManagedSession.keepWarmPing`: a low-effort turn on its own model
    and conversation, run with broadcast silenced and the chat, lastActiveAt, status and any wakeup put
    back, so it leaves no trace; already-cold sessions aren't pinged. Never on API credits, never at
    90%+ of the 5-hour window. Saved to `~/.clauder/keep-warm.json`. Pings assume the CLI reuses the
    cache on a low-effort turn: true on 2.1.286, NOT on 2.1.288+ until #100065 is fixed.
  - `tags.ts` — `TagManager`: the registry of user-defined colored session tags
    (`{id,label,color}`), persisted to `~/.clauder/tags.json` (atomic write,
    TriggerManager-style). Broadcasts the full snapshot on any CRUD. Sessions
    reference tags by id in `SessionConfig.tags`; deleting a tag cascades via
    `SessionManager.removeTagFromAllSessions`.
  - `folders.ts` — `FolderManager`: dashboard folders, named groups of sessions that only tidy the
    dashboard (client `Folders.tsx`). TagManager-style, persisted to `~/.clauder/folders.json`, full
    `folders_registry` snapshot on any change (owners only). Membership lives in the folder, not on
    SessionConfig, so sessions.json is untouched; a session is in at most one folder, Scratch in none.
    A closed folder's header names any session inside that needs you, is working, or is unread.
  - `status-reports.ts` — `StatusReportManager`: once a session has been idle `STATUS_IDLE_DAYS`
    (15), an hourly sweep writes a status note (where it stands, last worked on, open threads) with
    one tool-less `runClaudeOneShot` call (Sonnet, low effort, in the project's folder) on Clauder's
    own copy of the chat plus git state. It never runs a turn in the session or touches its
    lastActiveAt. One at a time, a minute apart, skipped while paused or when the 5-hour window is
    75%+ (weekly 85%+). Replies without the asked-for headings are dropped, which also keeps CLI
    error text out. Shown at the end of the chat (client `StatusNote.tsx`), in the Summary tab, and
    as the ⓘ preview on cards. Persisted to `~/.clauder/status-reports.json`; owners only.
  - `projects.ts` — the new-session form's **New project** option: `ensureProjectFolder()` creates
    (or reuses) a folder by name directly inside the dev root (`~/development`; override with
    `CLAUDER_DEV_ROOT`), and `GET /api/projects` lists what's already there. The client sends only
    a name (`create_session.projectFolder`) and the server picks the path. The name rules live in
    shared `project-folder.ts` so the form and the server agree.
  - `git-status.ts` — the session header's repo indicator (`GET /api/sessions/:id/git`, drawn by the
    client's `GitIndicator.tsx`): branch, last commit, uncommitted files, commits no remote has. Runs
    git in the session's own folder (never a client-supplied path) with `GIT_OPTIONAL_LOCKS=0` so it
    can't collide with a session's commit, caches 10s, and strips credentials from remote URLs.
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
- `packages/client/src/components/` — key React components: `Dashboard.tsx`, `ProjectTasks.tsx`, `ScratchBar.tsx`,
  `SessionView.tsx`, `SessionCard.tsx`, `MessageBubble.tsx`,
  `ToolUseAccordion.tsx`, `ApiCreditsModal.tsx`, `SchedulerModal.tsx` (two tabs: Scheduled Tasks +
  Overnight Runs), `StatusBadge.tsx` (includes "Waiting" variant),
  `RateLimitBar.tsx` (real subscription %).
- `packages/client/src/lib/notifications.ts` — browser Notification API.
- `~/.clauder/` (outside repo) — runtime state: `auth-token`, `sessions.json`,
  `sessions.json.bak`, `project-runs.json`, `triggers.json`, `tags.json`, `folders.json`, `status-reports.json`, `ui-state.json`, `folder-notes.json`, `api-key` (mode 600), `api-credits.json`, `keep-warm.json`, `project-notes.json`,
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
- Underlying Claude Code CLI: `@anthropic-ai/claude-code` v2.1.286.

## Discovered during sessions
- Headless `--print` mode disables AskUserQuestion and ExitPlanMode and leaves the CLI Monitor tool silently broken, so sessions are steered to Clauder-native substitutes: plain-text questions (answers to already-pending ones arrive as queue-jumping messages, not stdin tool_results), plans detected via the clauder-steps text block, <<schedule_trigger>> + ScheduleWakeup instead of CLI/cron, and the <<monitor>> sentinel (MonitorController). --append-system-prompt reaches only the top-level session, not Task sub-agents, so the parent session must own all scheduling/monitoring.
- Sentinels, CLAUDE.md candidates and error sniffs read text blocks only, but Opus 5.5 and Sonnet 5.5 send between-tool progress notes as thinking blocks (shown muted via UIMessage.thinking). Candidate text must not contain a closing square bracket; the extractor truncates at the first one.
- Context-error auto-recovery must react only to CLI-written messages (is_api_error_message, model <synthetic>); matching Claude's own prose made a reply about the error loop
- Any path that re-sends a stored user message must pass its author, or a guest's words reach Claude as the owner's; the pause/resume drain once dropped it
- The CLI deletes transcripts idle past cleanupPeriodDays (default 30; ~/.claude/settings.json sets 90); resuming one then fails with No conversation found
- ANTHROPIC_API_KEY is unset in prod, so task-classifier.ts auto-compact (a direct API call) silently no-ops; make out-of-band LLM calls through the CLI instead (runClaudeOneShot in claude-oneshot.ts)
- With an API key active the CLI disables claude.ai connectors, and a refused key makes it retry for minutes emitting api_retry events
- Beyond hard rule 10's files, model IDs are hardcoded in SCRATCH_MODEL (index.ts), SCRATCH_CONVERSATION_MODEL (shared session.ts), DEFAULT_EXECUTOR_MODEL (project-runner.ts), CLAUDE_CODE_SUBAGENT_MODEL (session.ts) and ProjectTasks.tsx, so grep for the old ID when changing one. CLAUDE_CODE_SUBAGENT_MODEL only covers sub-agents launched without a model; named models and built-in Explore bypass it
- There is no local price table: per-model cost comparisons come from ~/.clauder/cost-ledger.json, and to re-price its turns from tokens, charge cache writes at 2x input and count thinking inside output. Per Mtok, Opus 5.5 is $4/$20 with $0.20 cache reads and Sonnet 5.5 is $2/$10; cache reads dominate long agentic turns
- Sessions are child processes of the Clauder server, so restarting it from inside one kills that session mid-turn (looks like a random "interruption"). Test on a throwaway server instead: HOME=/tmp/x PORT=3999 node packages/server/dist/index.js. Its CLI isn't logged in (replies Not logged in, model synthetic), so it makes no real Claude calls; before copying sessions.json into its HOME, strip goal, modelPlan, pendingWakeup and monitors so restore can't start turns. lsof can't see listeners from inside a session, and a grep-based kill can match your own shell
- To test without a real CLI: fake-CLI harnesses live in packages/server/test-harness (run with node after npm run build; keep them there, since macOS cleanup wipes /tmp), and UI states can be faked by wrapping window.WebSocket via CDP addScriptToEvaluateOnNewDocument and dispatching fake MessageEvents
- clauder.log: browser JS crashes are on client:mobile or client:desktop lines (tagged by user agent; check there first); older lines lack timestamps, so bound searches by line number from a known timestamp, not string comparison
- Never expose Clauder through a tunnel or reverse proxy: proxied requests arrive from loopback, which auth.ts treats as owner
- Pushes to GitHub can drop with unexpected disconnect while reading sideband packet; retry with git -c http.version=HTTP/1.1 push
- Client performance: per-message and per-card components use useSessionActions()/useTagRegistry() plus React.memo, because any useSessions() inside re-renders them on every WS message; animate only transform or opacity (a width/margin progress bar forced 60-120 page layouts a second, ~15% of the tab's CPU)
- Hover-only controls (`opacity-0 group-hover:opacity-100`) are invisible on phones — gate the hiding behind Tailwind's `[@media(hover:hover)]:` variant so touch devices still see them.
- Popover Escape handlers listen on document and call preventDefault; App.tsx leaves the session on unhandled Escape
