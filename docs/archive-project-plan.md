# Implementation Plan: Archive Project

**Status:** Ready to implement. **Author context:** written by a session that knows this codebase well; another model should be able to implement it cold by following this doc + reading the referenced files.

## Goal

Add an "Archive project" action to a session. It wraps a finished project up and shelves it:

1. Generates an **AI-written wrap-up** (what was accomplished / how to resume).
2. Zips the project directory + a manifest (metadata, transcript, notes, summary, wrap-up) into `~/Documents/Clauder Archive/<name>-<timestamp>.zip`.
3. **Moves the project directory to the Trash** (recoverable — NOT a hard delete).
4. Destroys the session (removes it from the list; cleans up triggers/wakeups).

Un-archive (restore) is **out of scope for this pass** — see "Future: Un-archive" at the end; leave a clean seam for it.

## Locked decisions

- **Removal = move to Trash**, via Finder/`osascript`. Never `rm -rf`.
- **Wrap-up = AI-written**, via the CLI-subprocess pattern (runs on the subscription; NO `ANTHROPIC_API_KEY`). Falls back to a mechanical manifest if the AI step fails — archiving must not be blocked by it.
- **Un-archive:** deferred; design the zip layout + manifest so restore is feasible later.

## THE SAFETY INVARIANT (read this twice)

> The project directory is moved to Trash **only after** the zip has been created **and verified**. If *anything* fails before that point, abort and leave the directory completely untouched. Order is: validate → summarize → write manifest → zip → **verify** → (only now) trash → destroy session.

A bug here deletes someone's work. Treat the ordering and the path guards as the highest-risk part of the change. (`packages/server/src/session.ts` is the load-bearing file per `CLAUDE.md` hard rule #1 — read it whole before touching it; you'll only add a method to it, not restructure.)

---

## Phase 1 — Shared types & message wiring  (model: Haiku/Sonnet — mechanical)

`packages/shared/src/messages.ts`:

- Inbound union: `| { type: 'archive_session'; sessionId: string }`
- Outbound union:
  - `| { type: 'archive_status'; sessionId: string; stage: 'summarizing' | 'zipping' | 'verifying' | 'trashing' | 'done' | 'error'; message: string }`
  - `| { type: 'archive_complete'; sessionId: string; zipPath: string }`

Errors reuse the existing `{ type: 'error'; sessionId; message }` outbound.

---

## Phase 2 — Server archive module  (model: Opus / strongest available — SAFETY-CRITICAL)

New file `packages/server/src/archive.ts`. This owns everything destructive. Export one function:

```ts
export async function archiveSession(
  session: ManagedSession,
  onStage: (stage: string, message: string) => void,
): Promise<{ zipPath: string }>
```

### 2a. Path-safety guard — `assertSafeToArchive(cwd, allSessionCwds)`

Throw a descriptive Error (which becomes the UI message) if ANY of these hold. Resolve `cwd` to an absolute, symlink-free real path first (`fs.realpath`), then check:

- Path does not exist (`!existsSync`). → allow "manifest-only" archive instead (see 2e note) rather than erroring; decide per taste, but do NOT trash a non-existent path.
- `resolved === homedir()` (the home dir itself).
- `resolved === '/'` or is a system root: starts with any of `/System`, `/Library`, `/usr`, `/bin`, `/sbin`, `/etc`, `/var`, `/private`, `/Applications`, `/opt`, `/tmp`, `/cores`, or `/Volumes` top-level.
- NOT nested under `homedir()` (must start with `homedir() + path.sep`). Rationale: only archive things inside the user's home.
- **Too shallow:** fewer than 2 path segments below home (e.g. `~/foo` is depth 1 — reject; `~/dev/foo` is depth 2 — allow). Prevents trashing `~/Documents`, `~/Desktop`, `~/dev`, etc.
- Is (or contains) **the Clauder repo itself** — compute the repo root by walking up from `import.meta.url` to the dir containing `package.json` with name `clauder` (or reuse the CLI-discovery walk in `session.ts`). Reject if `resolved` is an ancestor-or-equal of, or equal to, the Clauder repo.
- Is the **Documents/Clauder Archive** dir or an ancestor of it.
- Contains a `"` or newline character (would break the `osascript` path handling / is pathological). Reject.
- **In use by another active session:** `allSessionCwds` (every OTHER session's resolved cwd) contains `resolved`. Reject with a message naming the conflict — don't trash a directory another session is actively working in.
- The **scratch** session (`session.config.isScratch`) — reject entirely (its cwd is home anyway, but be explicit).

Write focused unit-style checks; this list is the spec.

### 2b. AI wrap-up

Call `await session.generateArchiveSummary()` (added in Phase 3). Wrap in try/catch — on failure, use a mechanical fallback string ("Wrap-up unavailable; see transcript below."). `onStage('summarizing', ...)` before.

### 2c. Build the manifest

Markdown string:
- `# Archive: <session name>`
- Metadata table: cwd, created, last active, model/effort, total cost USD, message count, archived-at timestamp.
- `## Wrap-up` — the AI summary.
- `## Notes` — `session.notes` if present.
- `## Summary` — `session.summary` if present.
- `## Full transcript` — iterate `session.messages`, render `**role** (timestamp): content`. Include tool uses compactly (name + short input). This is the ONLY record of the conversation once the session is destroyed, so don't trim it here.

Write it to `<cwd>/CLAUDER-ARCHIVE.md` (the dir is going to Trash anyway, so mutating it is fine, and it gets captured in the zip). If cwd doesn't exist (manifest-only path), write the manifest into a temp dir and zip that instead.

### 2d. Ensure archive dir

`const ARCHIVE_DIR = path.join(homedir(), 'Documents', 'Clauder Archive')` — `mkdir -p`.

### 2e. Zip  → verify

- Zip name: `<safeName>-<YYYYMMDD-HHMMSS>.zip` where `safeName` = session name lowercased, non-alphanumerics → `-`, capped ~40 chars. HHMMSS avoids collisions.
- Write to a temp path first (`<final>.tmp.zip`), then rename to final after verify — mirrors the atomic-write ethos in `persistence.ts`.
- Command (macOS native, preserves the folder as top-level entry):
  `execFile('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', cwd, tmpZipPath])`
- `onStage('zipping', ...)` before, `onStage('verifying', ...)` after.
- **Verify:** (1) `ditto` exited 0; (2) `fs.stat(tmpZipPath).size > 0` (sanity floor, e.g. > 100 bytes); (3) `execFile('unzip', ['-t', tmpZipPath])` exits 0 (archive integrity). Only if all pass → `fs.rename(tmp → final)`. Otherwise throw (and `unlink` the temp).

### 2f. Trash the directory  (only reached if verify passed)

`onStage('trashing', ...)`. Move to Trash via `osascript`, passing the path as an argv item (NOT string-interpolated into the AppleScript — avoids quoting/injection issues):

```ts
await execFileP('osascript', [
  '-e', 'on run argv',
  '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
  '-e', 'end run',
  resolvedCwd,
]);
```

If cwd was the manifest-only case (dir didn't exist), skip this.

### 2g. Return

Return `{ zipPath: final }`. The caller (Phase 4/session-manager) destroys the session and broadcasts `archive_complete` + `archive_status: 'done'`.

Use `execFile` promisified (`util.promisify`) throughout; give `ditto`/`unzip` generous timeouts (e.g. 10 min) since a large repo can take a while — this is server-side `execFile`, so it is NOT subject to the CLI Bash-tool 10-min ceiling, but set an explicit timeout anyway.

---

## Phase 3 — AI wrap-up method on ManagedSession  (model: Sonnet)

`packages/server/src/session.ts` — add `async generateArchiveSummary(): Promise<string>`, modeled almost exactly on the existing `generateSummary()` (find it in the file). Differences:
- Prompt: ask for a project wrap-up in markdown — "What was accomplished, key decisions made, current state, and how someone would pick this project back up later. Be concrete. Do NOT use tools."
- Same subprocess flags as `generateSummary` (`--permission-mode plan`, `--no-session-persistence`, `--disallowed-tools ...`), same NDJSON drain + 2-min kill timeout.
- Return the assistant text; on any error return `''` (caller handles fallback).

This reuses the subscription auth (no API key) — same rationale documented on `reviewGoalMet`/`generateSummary`.

---

## Phase 4 — SessionManager + WS glue  (model: Haiku/Sonnet — mechanical)

`packages/server/src/session-manager.ts`:

```ts
async archiveSession(sessionId, broadcast): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  const others = [...this.sessions.values()].filter(s => s.id !== sessionId);
  const { zipPath } = await archiveModule.archiveSession(session, others, (stage, msg) =>
    broadcast({ type: 'archive_status', sessionId, stage, message: msg }));
  await this.destroySession(sessionId);          // existing method — cleans triggers/wakeups
  broadcast({ type: 'archive_complete', sessionId, zipPath });
}
```

(Thread the resolved cwds of `others` into `assertSafeToArchive`.) `persist()` is handled by `destroySession`. Do NOT `persistNow` mid-archive.

`packages/server/src/ws.ts` — add a `case 'archive_session':` mirroring existing cases; it `await`s `sessionManager.archiveSession(...)` and routes thrown errors to `broadcast({ type: 'error', ... })`. Log a `logUsage('archive_session', { sessionId })` (usage-log pattern already in `ws.ts`).

---

## Phase 5 — Client UI  (model: Sonnet)

`packages/client/src/context/SessionContext.tsx`:
- Action type + reducer entries for `ARCHIVE_STATUS` and `ARCHIVE_COMPLETE` (store a per-session `archiveStatus` string in state, or a small map). On `archive_complete`, clear it.
- WS dispatch: `case 'archive_status'` / `case 'archive_complete'`.
- Sender `archiveSession(sessionId)` → `wsRef.current?.send({ type: 'archive_session', sessionId })`. Add to context value + type (mirror `restartServer`/`setPinned`).

`packages/client/src/components/SessionView.tsx` — in `SessionSettingsMenu` (the ⚙️ dropdown), add **"📦 Archive project…"** (hidden for `session.config.isScratch`), placed above/near Destroy. Clicking opens a confirm modal (reuse the modal styling used by `QuickScheduleModal`):

- Modal shows: project **name**, the **directory that will move to Trash** (`session.config.cwd`), and the **zip destination** (`~/Documents/Clauder Archive/`). Copy: "This moves the project folder to the Trash (recoverable) and archives a zip. The session will be removed from Clauder."
- Confirm → call `archiveSession(session.id)`; show a progress line driven by `archive_status` (`Summarizing… → Zipping… → Verifying… → Moving to Trash…`).
- On `archive_complete`: call `onBack()` to return to the Dashboard; surface a brief notice with the zip path (e.g. a toast or a Dashboard system line). On `error`: show it in the modal, leave the session intact.

Keep buttons ≥44px touch targets (project convention). No horizontal-overflow regressions.

---

## Phase 6 — Verification  (model: Opus / strongest — verify the destructive path)

Before wiring the UI to a real project, prove the server path on a **throwaway directory**:

1. Create `~/dev/_archive_test/hello/` with a couple of files.
2. Point a scratch/test session's cwd at it (or unit-test `archiveSession` directly with a fake session object exposing `config.cwd`, `messages`, `notes`, `summary`, `generateArchiveSummary`).
3. Run archive. Assert: zip exists in `~/Documents/Clauder Archive/`, `unzip -t` passes, the zip contains `CLAUDER-ARCHIVE.md` + the files, and the original dir is now in **Trash** (not gone).
4. Run the path guards against a table of inputs and assert each dangerous one throws: `~`, `~/Documents`, `~/dev` (depth 1), `/`, `/usr`, the Clauder repo root, a dir used by another session, a path with a `"` in it.
5. Failure-injection: temporarily make `ditto` fail (e.g. unwritable archive dir) and assert the original dir is **untouched** and a clear error surfaces.

Then `npm run build` (must pass before any restart — `CLAUDE.md` hard rule #9), and hand back for a manual restart (`launchctl kickstart -k ...` from a standalone terminal — never from inside Clauder).

---

## Future: Un-archive (do NOT build now — leave the seam)

Design the zip so restore is a straightforward v2:
- The zip already contains `CLAUDER-ARCHIVE.md` with cwd + metadata + transcript.
- v2 "Restore from archive" (Dashboard action): list zips in `~/Documents/Clauder Archive/`, let the user pick one + a destination dir, extract (`ditto -x -k`), parse the manifest header for the original name/model, and `createSession({ name, cwd: <extracted path>, model })`. Optionally re-seed context from the transcript via the existing reset-priming path. No schema changes needed for that later.

---

## Gotchas / conventions for the implementer

- `packages/shared` builds first; its `package.json` `main` must point at `dist` (already fixed). Build order: shared → server → client.
- Follow the existing sentinel/broadcast/reducer patterns already in the repo (e.g. how `goal`/`notes`/`pinned` thread shared type → session method → session-manager → ws → context reducer → component). Archive is the same shape minus a persisted config field.
- All new `execFile` calls: use args arrays (never a shell string) to avoid injection; the path guard already rejects quotes/newlines as defense-in-depth.
- Don't block on the AI wrap-up; don't ever trash before verify. If in doubt, abort and keep the directory.
