import http from 'http';
import { homedir } from 'os';
import { createApp } from './server.js';
import { SessionManager } from './session-manager.js';
import { setupWebSocket } from './ws.js';
import { onRateLimitUpdate } from './rate-limits.js';
import { TriggerManager } from './triggers.js';

const PORT = parseInt(process.env.PORT || '3001', 10);

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

// Create Express app and HTTP server
const app = createApp(sessionManager, () => triggerManager);
const server = http.createServer(app);

// Set up WebSocket on the same server
const { broadcast } = setupWebSocket(server, sessionManager, () => triggerManager);

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
);
triggerManager.load();

// Restore sessions from disk now that broadcast is wired
sessionManager.restoreFromDisk();

// Bootstrap the floating scratch session if it doesn't exist yet.
// Always-available, hidden from the main session list, can be cleared but not destroyed.
{
  const hasScratch = sessionManager.getAllSessions().some(s => s.config.isScratch);
  if (!hasScratch) {
    sessionManager.createSession({
      name: 'Scratch',
      cwd: homedir(),
      model: 'claude-sonnet-4-6',
      isScratch: true,
    });
    console.log('[Clauder] Auto-created scratch session');
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

// Graceful shutdown - persist before destroying
process.on('SIGINT', async () => {
  console.log('\n[Clauder] Shutting down...');
  sessionManager.persistNow();
  await sessionManager.destroyAll();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  sessionManager.persistNow();
  await sessionManager.destroyAll();
  server.close();
  process.exit(0);
});
