import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { WsInboundMessage, WsOutboundMessage } from '@clauder/shared';
import { SessionManager } from './session-manager.js';
import { discoverSessions } from './discovery.js';
import { getRateLimitInfo } from './rate-limits.js';
import { isAuthenticated } from './auth.js';

export function setupWebSocket(server: Server, sessionManager: SessionManager) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  // Handle HTTP upgrade manually so we can check auth
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }

    if (!isAuthenticated(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  // Broadcast function that sends to all connected clients
  function broadcast(msg: WsOutboundMessage) {
    const data = JSON.stringify(msg);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  // Wire up the broadcast to the session manager
  // We need to set this via a method since SessionManager was created with a placeholder
  (sessionManager as any).broadcast = broadcast;

  // Ping all clients every 30s to keep connections alive
  const pingInterval = setInterval(() => {
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
  }, 30_000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[WS] Client connected (${clients.size} total)`);

    // Send current sessions list on connect
    const sessionsMsg: WsOutboundMessage = {
      type: 'sessions_list',
      sessions: sessionManager.getAllSessions(),
    };
    ws.send(JSON.stringify(sessionsMsg));

    // Send current rate limit info
    ws.send(JSON.stringify({ type: 'rate_limit_update', rateLimit: getRateLimitInfo() }));

    // Send current pause state
    const pauseUntil = sessionManager.getPauseUntil();
    if (pauseUntil) {
      ws.send(JSON.stringify({ type: 'pause_update', pauseUntil }));
    }

    ws.on('message', async (data) => {
      try {
        const msg: WsInboundMessage = JSON.parse(data.toString());
        await handleMessage(msg, sessionManager, broadcast);
      } catch (err: any) {
        console.error('[WS] Error handling message:', err);
        ws.send(JSON.stringify({
          type: 'error',
          sessionId: '',
          message: err.message || 'Unknown error',
        }));
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS] Client disconnected (${clients.size} total)`);
    });
  });

  return { wss, broadcast };
}

async function handleMessage(
  msg: WsInboundMessage,
  sessionManager: SessionManager,
  broadcast: (msg: WsOutboundMessage) => void,
) {
  switch (msg.type) {
    case 'create_session': {
      try {
        sessionManager.createSession(msg.config);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: '', message: err.message });
      }
      break;
    }

    case 'send_message': {
      try {
        await sessionManager.sendMessage(msg.sessionId, msg.message, msg.images);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'compact_session': {
      try {
        await sessionManager.compactSession(msg.sessionId);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'dequeue_message': {
      try {
        sessionManager.dequeueMessage(msg.sessionId, msg.index);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'interrupt_session': {
      try {
        await sessionManager.interruptSession(msg.sessionId);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'reset_session': {
      try {
        await sessionManager.resetSession(msg.sessionId);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'destroy_session': {
      try {
        await sessionManager.destroySession(msg.sessionId);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'discover_sessions': {
      try {
        const discovered = await discoverSessions();
        broadcast({ type: 'discovered_sessions', sessions: discovered });
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: '', message: `Discovery failed: ${err.message}` });
      }
      break;
    }

    case 'resume_discovered': {
      try {
        sessionManager.createSession({
          name: msg.name,
          cwd: msg.projectPath,
          resumeSessionId: msg.sdkSessionId,
        });
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: '', message: err.message });
      }
      break;
    }

    case 'set_permission_mode': {
      try {
        await sessionManager.setPermissionMode(msg.sessionId, msg.mode);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'rename_session': {
      try {
        sessionManager.renameSession(msg.sessionId, msg.newName);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'set_model': {
      try {
        sessionManager.setModel(msg.sessionId, msg.model);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'generate_summary': {
      try {
        // Fire and forget — summary generation broadcasts when done
        sessionManager.generateSessionSummary(msg.sessionId).catch(err => {
          broadcast({ type: 'error', sessionId: msg.sessionId, message: `Summary failed: ${err.message}` });
        });
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'permission_response': {
      // No-op in v2: permission mode is a CLI startup flag, not an interactive callback.
      // The server never sends permission_request events in v2, so this handler is dead code.
      break;
    }

    case 'pause_sessions': {
      sessionManager.pauseSessions(msg.pauseUntil);
      break;
    }

    case 'resume_sessions': {
      sessionManager.resumeSessions();
      break;
    }

    case 'ping':
      // Client keepalive — no-op
      break;
  }
}
