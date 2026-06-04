import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { WsInboundMessage, WsOutboundMessage } from '@clauder/shared';
import { SessionManager } from './session-manager.js';
import { discoverSessions } from './discovery.js';
import { getRateLimitInfo, resetRateLimit } from './rate-limits.js';
import { applyClaudeMdCandidate } from './claude-md.js';
import { getSkillsForCwd } from './skills.js';
import type { TriggerManager } from './triggers.js';

export function setupWebSocket(server: Server, sessionManager: SessionManager, getTriggers: () => TriggerManager, getProjectRunner: () => import('./project-runner.js').ProjectRunner) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  // Handle HTTP upgrade for WebSocket connections
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws') {
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

    // Send current triggers snapshot
    try {
      ws.send(JSON.stringify({ type: 'triggers_snapshot', triggers: getTriggers().list() }));
    } catch {
      // TriggerManager may not be initialized yet — skip
    }

    // Send current project runs snapshot
    try {
      ws.send(JSON.stringify({ type: 'project_runs_snapshot', runs: getProjectRunner().list() }));
    } catch {
      // ProjectRunner may not be initialized yet — skip
    }

    // Send skill list per session so the dropdown is populated on reconnect
    for (const session of sessionManager.getAllSessions()) {
      try {
        const skills = getSkillsForCwd(session.config.cwd);
        ws.send(JSON.stringify({ type: 'skills_list', sessionId: session.id, skills }));
      } catch {
        // Per-session scan failures are non-fatal — client falls back to empty list
      }
    }

    ws.on('message', async (data) => {
      try {
        const msg: WsInboundMessage = JSON.parse(data.toString());
        await handleMessage(msg, sessionManager, broadcast, getTriggers, getProjectRunner);
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
  getTriggers: () => TriggerManager,
  getProjectRunner: () => import('./project-runner.js').ProjectRunner,
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
        await sessionManager.sendMessage(msg.sessionId, msg.message, msg.images, { planMode: msg.planMode });
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'plan_response': {
      try {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) throw new Error('Session not found');
        // Send the user's decision as a regular message; Claude will see it as a follow-up turn
        const followUp = msg.decision === 'accept'
          ? `Plan approved. Proceed with the plan as described.${msg.feedback ? `\n\nAdditional note: ${msg.feedback}` : ''}`
          : `Plan rejected. ${msg.feedback || 'Please reconsider the approach and propose an alternative.'}`;
        broadcast({ type: 'plan_resolved', sessionId: msg.sessionId, toolUseId: msg.toolUseId });
        await sessionManager.sendMessage(msg.sessionId, followUp);
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
        // Also clean up any triggers tied to this session
        getTriggers().removeSessionTriggers(msg.sessionId);
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

    case 'update_cwd': {
      try {
        sessionManager.updateCwd(msg.sessionId, msg.cwd);
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

    case 'set_effort': {
      try {
        sessionManager.setEffort(msg.sessionId, msg.effort || undefined);
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
      break;
    }

    case 'question_response': {
      try {
        sessionManager.respondToQuestion(msg.sessionId, msg.toolUseId, msg.answer);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
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

    case 'reset_rate_limit': {
      // Zero the usage bar at period rollover. resetRateLimit notifies the listener,
      // which broadcasts a rate_limit_update to all clients.
      resetRateLimit();
      break;
    }

    case 'create_project_run': {
      try {
        getProjectRunner().createRun({
          name: msg.name,
          repoPath: msg.repoPath,
          goal: msg.goal,
          budget: msg.budget,
          executorModel: msg.executorModel,
        });
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: '', message: `Create run failed: ${err.message}` });
      }
      break;
    }

    case 'approve_project_run': {
      try {
        getProjectRunner().approveRun(msg.runId, { budget: msg.budget, verifyCommands: msg.verifyCommands });
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: '', message: `Approve run failed: ${err.message}` });
      }
      break;
    }

    case 'cancel_project_run': {
      try {
        getProjectRunner().cancelRun(msg.runId);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: '', message: `Cancel run failed: ${err.message}` });
      }
      break;
    }

    case 'cancel_wakeup': {
      try {
        sessionManager.cancelWakeup(msg.sessionId);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'apply_claude_md_candidate': {
      try {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) throw new Error('Session not found');
        // Deduping append — same helper used by auto-apply, so manual and automatic stay consistent.
        applyClaudeMdCandidate(session.config.cwd, msg.candidate);
        broadcast({ type: 'claude_md_applied', sessionId: msg.sessionId, candidate: msg.candidate.trim() });
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: `CLAUDE.md update failed: ${err.message}` });
      }
      break;
    }

    case 'list_skills': {
      try {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) throw new Error('Session not found');
        const skills = getSkillsForCwd(session.config.cwd);
        broadcast({ type: 'skills_list', sessionId: msg.sessionId, skills });
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: `Skill discovery failed: ${err.message}` });
      }
      break;
    }

    case 'clear_session': {
      try {
        await sessionManager.clearSession(msg.sessionId);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'ping':
      // Client keepalive — no-op
      break;
  }
}
