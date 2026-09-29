import './log-setup.js'; // MUST be first — stamps + trims the log before other modules' import-time logging
import http from 'http';
import { homedir } from 'os';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createApp } from './server.js';
import { backupSessions } from './persistence.js';
import { SessionManager } from './session-manager.js';
import { setupWebSocket } from './ws.js';
import { onRateLimitUpdate } from './rate-limits.js';
import { TriggerManager } from './triggers.js';
import { TagManager } from './tags.js';
import { UiStateManager } from './ui-state.js';
import { initAuth } from './auth.js';
import { ShareManager, shareBaseUrl, guestNote, revokedGuestNote } from './shares.js';
import { ProjectRunner } from './project-runner.js';
import { GoalSupervisor } from './goal-supervisor.js';
import { ModelPlanRunner } from './model-plan-runner.js';
import { purgeOldUploads } from './uploads.js';
import { trimUsageLog } from './usage-log.js';
import type { WsOutboundMessage } from '@clauder/shared';

const PORT = parseInt(process.env.PORT || '3001', 10);

/** Model used for the auto-created scratch session. Cheap enough for quick lookups, capable enough for code questions. */
const SCRATCH_MODEL = 'claude-sonnet-5-5';

// Ensure node is findable when the server is started without a full shell PATH
// (e.g. via nohup). Prepend the directory of the current node binary and common locations.
{
  const nodeBinDir = process.execPath.replace(/\/node$/, '');
  const extraPaths = [nodeBinDir, '/opt/homebrew/bin', '/usr/local/bin'];
  const current = process.env.PATH ?? '';
  const missing = extraPaths.filter(p => !current.split(':').includes(p));
  if (missing.length) {
    process.env.PATH = [...missing, current].join(':');
  }
}

// The owner token behind the owner link and its cookie (auth.ts). Loaded before anything serves.
initAuth();

// Create session manager with a placeholder broadcast (wired up in setupWebSocket)
const sessionManager = new SessionManager(() => {});

// Trigger manager — fires messages to sessions on schedule. Wired up post-WS.
let triggerManager: TriggerManager;
// Tag registry — user-defined colored session tags. Wired up post-WS.
let tagManager: TagManager;
// Cross-device view state — read status, closed tabs, pinned-tab order. Wired up post-WS.
let uiStateManager: UiStateManager;
// Share links — one session per named guest on the local network. Wired up post-WS.
let shareManager: ShareManager;
// Project Runner — drives overnight autonomous runs. Wired up post-WS.
let projectRunner: ProjectRunner;
// Model Plan Runner — drives multi-step plans. Constructed post-WS (needs `broadcast`);
// the getter pattern lets ws.ts reference it before it exists.
let modelPlanRunner: ModelPlanRunner;

// Broadcast placeholder — replaced once WebSocket is set up (createApp needs it before WS init)
let broadcastFn: (msg: WsOutboundMessage) => void = () => {};

// Create Express app and HTTP server
const app = createApp(sessionManager, () => triggerManager, () => projectRunner, () => broadcastFn, () => shareManager);
const server = http.createServer(app);

// Set up WebSocket on the same server
const { broadcast, getClientCount, disconnectShare } = setupWebSocket(server, sessionManager, () => triggerManager, () => projectRunner, () => modelPlanRunner, () => tagManager, () => uiStateManager, () => shareManager);
broadcastFn = broadcast;

// Tag registry — broadcast the full snapshot to all clients after any CRUD.
tagManager = new TagManager((tags) => broadcast({ type: 'tags_registry', tags }));
tagManager.load();

// Read status and tab state, synced across devices — full snapshot to all clients on any change.
uiStateManager = new UiStateManager((state) => broadcast({ type: 'ui_state', state }), (id) => !!sessionManager.getSession(id));
uiStateManager.load();

// Share links. Owners get the full list after any change (a guest's connection filters it out); a
// revoked link's open connections are dropped at once. Each guest message reaches Claude behind a
// note naming the guest and the owner's rules for them, and a destroyed session takes its links.
shareManager = new ShareManager(
  (shares) => broadcast({ type: 'shares_snapshot', shares, baseUrl: shareBaseUrl() }),
  (share) => disconnectShare(share.id),
);
shareManager.load();
sessionManager.setAuthorDescriber((author) => {
  const share = shareManager.get(author.shareId);
  return share ? guestNote(share) : revokedGuestNote(author.name);
});
sessionManager.onSessionDestroyed((id) => shareManager.revokeForSession(id));

// Hourly health snapshot — one line so slow leaks and stuck sessions are visible in the log
// (the server runs for weeks; without this, a session wedged in "working" for two days or
// creeping RSS growth left no trace). ~24 lines/day against a 15MB log cap.
function logHealthSnapshot(): void {
  try {
    const sessions = sessionManager.getAllSessions();
    const byStatus: Record<string, number> = {};
    let queued = 0, monitors = 0;
    for (const s of sessions) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      queued += s.queuedMessages.length;
      monitors += s.monitors.length;
    }
    const statusStr = Object.entries(byStatus).map(([k, v]) => `${v} ${k}`).join(', ') || 'none';
    const rssMb = (process.memoryUsage().rss / 1e6).toFixed(0);
    console.log(`[Health] sessions: ${sessions.length} (${statusStr}) | ws clients: ${getClientCount()} | monitors: ${monitors} | queued msgs: ${queued} | rss: ${rssMb}MB | uptime: ${(process.uptime() / 3600).toFixed(1)}h`);
  } catch (err) {
    console.error('[Health] snapshot failed:', err);
  }
}
setInterval(logHealthSnapshot, 60 * 60 * 1000).unref();
setTimeout(logHealthSnapshot, 60 * 1000).unref(); // first snapshot shortly after startup settles

// Broadcast rate limit updates to all clients
onRateLimitUpdate((rateLimit) => {
  broadcast({ type: 'rate_limit_update', rateLimit });
});

// Initialize triggers (fire messages via sessionManager, broadcast events to clients)
triggerManager = new TriggerManager(
  (sessionId, message) => {
    // internal: true — trigger-fired messages are programmatic, so task-switch
    // classification and wakeup-cancellation should skip them
    sessionManager.sendMessage(sessionId, message, [], { internal: true }).catch((err: any) => {
      console.error(`[TriggerManager] sendMessage failed for ${sessionId}:`, err.message);
    });
  },
  (event, trigger) => {
    switch (event) {
      case 'created': broadcast({ type: 'trigger_created', trigger }); break;
      case 'updated': broadcast({ type: 'trigger_updated', trigger }); break;
      case 'deleted': broadcast({ type: 'trigger_deleted', triggerId: trigger.id }); break;
      case 'fired':   broadcast({ type: 'trigger_fired', trigger }); break;
    }
  },
  // Lets the manager disable/drop triggers whose target session no longer exists
  (sessionId) => !!sessionManager.getSession(sessionId),
);
triggerManager.load();

// Let sessions create TriggerManager entries via <<schedule_trigger>> sentinels
sessionManager.setTriggerCreator(({ sessionId, message, description, at }) => {
  triggerManager.create({ sessionId, message, description, schedule: { type: 'once', at }, source: 'scheduled' });
});

// Project Runner — drives overnight autonomous runs. Compose the broadcast so every
// session event also reaches the runner's supervise loop (it filters to its executors).
projectRunner = new ProjectRunner(sessionManager, broadcast);
// Goal Supervisor — keeps goal-mode sessions working toward their goal on every idle.
const goalSupervisor = new GoalSupervisor(sessionManager, () => triggerManager, broadcast);
// Model Plan Runner — drives multi-step plans, switching the session's model between steps.
modelPlanRunner = new ModelPlanRunner(sessionManager, broadcast);
(sessionManager as any).broadcast = (msg: WsOutboundMessage) => {
  broadcast(msg);
  projectRunner.onEvent(msg);
  goalSupervisor.onEvent(msg);
  modelPlanRunner.onEvent(msg);
};

// Purge uploads older than 7 days
purgeOldUploads(7).catch(err => console.error('[uploads] Purge error:', err));

// Keep the feature-usage log from growing forever across months of daily use
trimUsageLog();

// Back up sessions before restoring — safety net against future corruption
backupSessions();

// Periodic backup every 10 minutes while the server is running
setInterval(backupSessions, 10 * 60 * 1000).unref();

// Restore sessions from disk now that broadcast is wired
sessionManager.restoreFromDisk();

// Restore project runs after their executor sessions are back; re-arm resume timers.
projectRunner.restoreFromDisk();

// Resume supervision of any goal-mode sessions that were active before the restart.
// Delayed slightly so WS clients and rate-limit state settle first.
setTimeout(() => { goalSupervisor.kickstartActiveGoals(); modelPlanRunner.kickstartActivePlans(); }, 3000).unref();

// Bootstrap the floating scratch session if it doesn't exist yet.
// Always-available, hidden from the main session list, can be cleared but not destroyed.
{
  const hasScratch = sessionManager.getAllSessions().some(s => s.config.isScratch);
  if (!hasScratch) {
    sessionManager.createSession({
      name: 'Scratch',
      cwd: homedir(),
      model: SCRATCH_MODEL,
      isScratch: true,
    });
    console.log('[Clauder] Auto-created scratch session');
  }
}

// Ensure a recurring CLAUDE.md cleanup runs ~weekly: dedupe/consolidate the auto-applied
// "Discovered during sessions" notes so they don't bloat over time. Runs in the scratch
// session (non-disruptive to work sessions) and is visible/editable in the scheduler.
{
  const CLEANUP_DESC = 'CLAUDE.md cleanup (auto)';
  const scratch = sessionManager.getAllSessions().find(s => s.config.isScratch);
  const alreadyScheduled = triggerManager.list().some(t => t.description === CLEANUP_DESC);
  if (scratch && !alreadyScheduled) {
    // Find the Clauder repo's CLAUDE.md by walking up from this compiled module.
    let dir = dirname(fileURLToPath(import.meta.url));
    let claudeMdPath = join(dir, 'CLAUDE.md');
    for (let i = 0; i < 6 && !existsSync(claudeMdPath); i++) {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
      claudeMdPath = join(dir, 'CLAUDE.md');
    }
    const intervalSeconds = 8 * 24 * 60 * 60; // 8 days (within the 7–10 day target)
    triggerManager.create({
      sessionId: scratch.id,
      description: CLEANUP_DESC,
      source: 'scheduled',
      schedule: {
        type: 'recurring',
        intervalSeconds,
        nextAt: new Date(Date.now() + intervalSeconds * 1000).toISOString(),
      },
      message:
        `Maintenance: tidy the CLAUDE.md at ${claudeMdPath}. Only touch the ` +
        `"## Discovered during sessions" section — leave every hand-written section above it ` +
        `unchanged. In that section, remove duplicate or near-duplicate bullets, merge closely ` +
        `related notes into one clear line, and delete anything now obvious, stale, or already ` +
        `covered above. Edit the file in place, then reply with a one-line summary of what you ` +
        `consolidated. If it's already tight, change nothing and say so.`,
    });
    console.log(`[Clauder] Scheduled recurring CLAUDE.md cleanup (every 8 days) for ${claudeMdPath}`);
  }
}

// Start listening on all interfaces (0.0.0.0) for Tailscale/remote access
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[Clauder] Server running on http://0.0.0.0:${PORT}`);
  console.log(`[Clauder] WebSocket available at ws://0.0.0.0:${PORT}/ws`);
});

// Prevent unhandled errors from crashing the server. Log full stacks — a bare message
// ("write EPIPE") gives no clue where it came from, and a non-Error rejection reason
// would print as [object Object].
process.on('uncaughtException', (err) => {
  console.error('[Clauder] Uncaught exception (server kept alive):', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? (reason.stack || reason.message) : JSON.stringify(reason);
  console.error('[Clauder] Unhandled rejection (server kept alive):', detail);
});

// Graceful shutdown — persist first, then kill child processes without touching persistence
process.on('SIGINT', async () => {
  console.log('\n[Clauder] Shutting down...');
  sessionManager.persistNow();
  uiStateManager?.flush();
  sessionManager.clearSummaryTimers(); // stop pending summaries firing into closed sockets post-shutdown
  try { await sessionManager.terminateAll(); } catch (err) {
    console.error('[Clauder] Error during shutdown cleanup:', err);
  }
  server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  sessionManager.persistNow();
  uiStateManager?.flush();
  sessionManager.clearSummaryTimers(); // stop pending summaries firing into closed sockets post-shutdown
  try { await sessionManager.terminateAll(); } catch (err) {
    console.error('[Clauder] Error during shutdown cleanup:', err);
  }
  server.close();
  process.exit(0);
});
