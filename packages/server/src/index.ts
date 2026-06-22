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
import { ProjectRunner } from './project-runner.js';
import type { WsOutboundMessage } from '@clauder/shared';

const PORT = parseInt(process.env.PORT || '3001', 10);

/** Model used for the auto-created scratch session. Cheap enough for quick lookups, capable enough for code questions. */
const SCRATCH_MODEL = 'claude-sonnet-4-6';

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

// Create session manager with a placeholder broadcast (wired up in setupWebSocket)
const sessionManager = new SessionManager(() => {});

// Trigger manager — fires messages to sessions on schedule. Wired up post-WS.
let triggerManager: TriggerManager;
// Project Runner — drives overnight autonomous runs. Wired up post-WS.
let projectRunner: ProjectRunner;

// Broadcast placeholder — replaced once WebSocket is set up (createApp needs it before WS init)
let broadcastFn: (msg: WsOutboundMessage) => void = () => {};

// Create Express app and HTTP server
const app = createApp(sessionManager, () => triggerManager, () => projectRunner, () => broadcastFn);
const server = http.createServer(app);

// Set up WebSocket on the same server
const { broadcast } = setupWebSocket(server, sessionManager, () => triggerManager, () => projectRunner);
broadcastFn = broadcast;

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

// Project Runner — drives overnight autonomous runs. Compose the broadcast so every
// session event also reaches the runner's supervise loop (it filters to its executors).
projectRunner = new ProjectRunner(sessionManager, broadcast);
(sessionManager as any).broadcast = (msg: WsOutboundMessage) => {
  broadcast(msg);
  projectRunner.onEvent(msg);
};

// Back up sessions before restoring — safety net against future corruption
backupSessions();

// Periodic backup every 10 minutes while the server is running
setInterval(backupSessions, 10 * 60 * 1000).unref();

// Restore sessions from disk now that broadcast is wired
sessionManager.restoreFromDisk();

// Restore project runs after their executor sessions are back; re-arm resume timers.
projectRunner.restoreFromDisk();

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

// Prevent unhandled errors from crashing the server
process.on('uncaughtException', (err) => {
  console.error('[Clauder] Uncaught exception (server kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Clauder] Unhandled rejection (server kept alive):', reason);
});

// Graceful shutdown — persist first, then kill child processes without touching persistence
process.on('SIGINT', async () => {
  console.log('\n[Clauder] Shutting down...');
  sessionManager.persistNow();
  sessionManager.clearSummaryTimers(); // stop pending summaries firing into closed sockets post-shutdown
  try { await sessionManager.terminateAll(); } catch (err) {
    console.error('[Clauder] Error during shutdown cleanup:', err);
  }
  server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  sessionManager.persistNow();
  sessionManager.clearSummaryTimers(); // stop pending summaries firing into closed sockets post-shutdown
  try { await sessionManager.terminateAll(); } catch (err) {
    console.error('[Clauder] Error during shutdown cleanup:', err);
  }
  server.close();
  process.exit(0);
});
