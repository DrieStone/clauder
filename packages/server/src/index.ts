import http from 'http';
import { createApp } from './server.js';
import { SessionManager } from './session-manager.js';
import { setupWebSocket } from './ws.js';
import { onRateLimitUpdate } from './rate-limits.js';
import { initAuth } from './auth.js';

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

// Initialize auth token (load or generate)
const authToken = initAuth();

// Create session manager with a placeholder broadcast (wired up in setupWebSocket)
const sessionManager = new SessionManager(() => {});

// Create Express app and HTTP server
const app = createApp(sessionManager);
const server = http.createServer(app);

// Set up WebSocket on the same server
const { broadcast } = setupWebSocket(server, sessionManager);

// Broadcast rate limit updates to all clients
onRateLimitUpdate((rateLimit) => {
  broadcast({ type: 'rate_limit_update', rateLimit });
});

// Restore sessions from disk now that broadcast is wired
sessionManager.restoreFromDisk();

// Start listening
server.listen(PORT, () => {
  console.log(`[Clauder] Server running on http://localhost:${PORT}`);
  console.log(`[Clauder] WebSocket available at ws://localhost:${PORT}/ws`);
  console.log(`[Clauder] Auth token: ${authToken}`);
  console.log(`[Clauder] Token stored in ~/.clauder/auth-token`);
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
