import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { WsInboundMessage, WsOutboundMessage, ShareLink } from '@clauder/shared';
import { SessionManager } from './session-manager.js';
import { discoverSessions } from './discovery.js';
import { getRateLimitInfo, resetRateLimit } from './rate-limits.js';
import { applyClaudeMdCandidate } from './claude-md.js';
import { getSkillsForCwd } from './skills.js';
import { toClientState, toClientHistory } from './client-view.js';
import type { TriggerManager } from './triggers.js';
import type { TagManager } from './tags.js';
import type { UiStateManager } from './ui-state.js';
import { logUsage } from './usage-log.js';
import { ensureProjectFolder } from './projects.js';
import { resolveAccess, type Access } from './auth.js';
import { normalizeIp } from './network.js';
import { shareBaseUrl, type ShareManager } from './shares.js';
import { forGuest, toGuestState, guestMessages } from './guest-view.js';

/** Pull a few known-safe scalar fields off an inbound WS message for the usage log. Never
 *  includes free-text fields that may carry conversation/note/goal content (message, notes,
 *  goal.text, candidate, feedback, answer, newName, cwd) — only structural metadata. */
function safeDetail(msg: any): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (typeof msg.sessionId === 'string') out.sessionId = msg.sessionId;
  if (typeof msg.model === 'string') out.model = msg.model;
  if (typeof msg.effort === 'string') out.effort = msg.effort;
  if (typeof msg.mode === 'string') out.mode = msg.mode;
  if (typeof msg.decision === 'string') out.decision = msg.decision;
  if (typeof msg.pinned === 'boolean') out.pinned = msg.pinned;
  if (typeof msg.planMode === 'boolean') out.planMode = msg.planMode;
  if (msg.goal !== undefined) out.hasGoal = msg.goal !== null;
  if (msg.notes !== undefined) out.hasNotes = msg.notes !== null;
  return Object.keys(out).length ? out : undefined;
}

export function setupWebSocket(server: Server, sessionManager: SessionManager, getTriggers: () => TriggerManager, getProjectRunner: () => import('./project-runner.js').ProjectRunner, getModelPlanRunner: () => import('./model-plan-runner.js').ModelPlanRunner, getTags: () => TagManager, getUiState: () => UiStateManager, getShares: () => ShareManager) {
  // permessage-deflate cuts the initial sessions_list payload from ~3MB to ~500KB.
  // Without it, the client can't finish processing before the server sends its next
  // message, and browsers disconnect+reconnect in a tight loop.
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      // Only compress messages >= 8KB — small messages aren't worth the CPU
      threshold: 8 * 1024,
    },
  });
  /** Every open connection and who it is: the owner (everything) or a guest (one session). */
  const clients = new Map<WebSocket, Access>();

  // Handle HTTP upgrade for WebSocket connections. Each is classified first (auth.ts): the owner,
  // a share-link guest, or nobody. A refusal still completes the upgrade, then closes with a code
  // the page can read (4401 not signed in, 4403 invalid or revoked link): a refused HTTP upgrade
  // just looks like a network error, and the page would retry forever.
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://clauder');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const access = resolveAccess(req, url.searchParams.get('share'), (token) => getShares().findByToken(token));
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (access.role === 'none') {
        console.log(`[WS] Refused (${access.reason}) — ${normalizeIp(req.socket.remoteAddress)}`);
        ws.close(access.reason === 'not-signed-in' ? 4401 : 4403, access.reason);
        return;
      }
      wss.emit('connection', ws, req, access);
    });
  });

  // Broadcast: the owner gets everything; a guest only its own session's events (guest-view.ts).
  function broadcast(msg: WsOutboundMessage) {
    const data = JSON.stringify(msg);
    for (const [client, access] of clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      if (access.role === 'owner') {
        client.send(data);
      } else if (access.role === 'guest') {
        const out = forGuest(msg, access.share);
        if (out) client.send(JSON.stringify(out));
      }
    }
  }

  /** Drop every connection using a share link, the moment it's revoked. */
  function disconnectShare(shareId: string) {
    for (const [client, access] of clients) {
      if (access.role === 'guest' && access.share.id === shareId) client.close(4403, 'revoked');
    }
  }

  // Wire up the broadcast to the session manager
  // We need to set this via a method since SessionManager was created with a placeholder
  (sessionManager as any).broadcast = broadcast;

  // Ping all clients every 30s to keep connections alive
  const pingInterval = setInterval(() => {
    for (const client of clients.keys()) {
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    }
  }, 30_000);

  wss.on('close', () => {
    clearInterval(pingInterval);
  });

  function sendOwnerSnapshot(ws: WebSocket) {
    // Send current sessions list on connect
    const sessionsMsg: WsOutboundMessage = {
      type: 'sessions_list',
      sessions: sessionManager.getAllSessions().map(toClientState),
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

    // Send current tag registry snapshot
    try {
      ws.send(JSON.stringify({ type: 'tags_registry', tags: getTags().list() }));
    } catch {
      // TagManager may not be initialized yet — skip
    }

    // Cross-device view state: read status, closed tabs, pinned-tab order
    try {
      ws.send(JSON.stringify({ type: 'ui_state', state: getUiState().snapshot() }));
    } catch {
      // UiStateManager may not be initialized yet — skip
    }

    // Share links (tokens included): owner connections only.
    try {
      ws.send(JSON.stringify({ type: 'shares_snapshot', shares: getShares().list(), baseUrl: shareBaseUrl() }));
    } catch {
      // ShareManager may not be initialized yet — skip
    }

    // Skills are NOT sent for every session here any more: that was one message and one disk
    // scan per session on every connect. SessionView asks for the session you open instead.
  }

  /** A guest's whole world: its one session, stripped of the owner's private state, and its name. */
  function sendGuestSnapshot(ws: WebSocket, share: ShareLink) {
    const session = sessionManager.getSession(share.sessionId);
    const sessions = session ? [toGuestState(toClientState(session.getState()), share)] : [];
    ws.send(JSON.stringify({ type: 'sessions_list', sessions }));
    ws.send(JSON.stringify({ type: 'guest_info', sessionId: share.sessionId, guestName: share.guestName }));
  }

  wss.on('connection', (ws: WebSocket, req: import('http').IncomingMessage, access: Access) => {
    clients.set(ws, access);
    // Identify the client so a phone reconnect-loop is distinguishable from the desktop:
    // remote IP + a short user-agent tag on both connect and disconnect lines.
    const ip = normalizeIp(req?.socket?.remoteAddress) || '?';
    const ua = String(req?.headers?.['user-agent'] ?? '');
    const uaTag = /iPhone|iPad|Android|Mobile/i.test(ua) ? 'mobile' : /Macintosh|Windows|X11/i.test(ua) ? 'desktop' : 'other';
    const who = access.role === 'guest' ? `guest "${access.share.guestName}"` : access.role === 'owner' ? `owner via ${access.via}` : '';
    console.log(`[WS] Client connected (${clients.size} total) — ${ip} ${uaTag} ${who}`);

    if (access.role === 'guest') {
      sendGuestSnapshot(ws, access.share);
      getShares().touch(access.share.id);
    } else {
      sendOwnerSnapshot(ws);
    }

    ws.on('message', async (data) => {
      try {
        const msg: WsInboundMessage = JSON.parse(data.toString());
        const reply = (out: WsOutboundMessage) => { try { ws.send(JSON.stringify(out)); } catch { /* client went away */ } };
        if (access.role === 'guest') {
          await handleGuestMessage(msg, access.share.id, sessionManager, getShares(), reply, () => ws.close(4403, 'revoked'));
        } else {
          await handleMessage(msg, sessionManager, broadcast, getTriggers, getProjectRunner, getModelPlanRunner, getTags, getUiState, getShares, reply);
        }
      } catch (err: any) {
        console.error('[WS] Error handling message:', err);
        ws.send(JSON.stringify({
          type: 'error',
          sessionId: '',
          // A guest gets no internals.
          message: access.role === 'guest' ? 'Something went wrong' : err.message || 'Unknown error',
        }));
      }
    });

    ws.on('close', (code: number) => {
      clients.delete(ws);
      console.log(`[WS] Client disconnected (${clients.size} total) — ${ip} ${uaTag} code=${code}`);
    });
  });

  // getClientCount feeds the hourly health snapshot in index.ts.
  return { wss, broadcast, disconnectShare, getClientCount: () => clients.size };
}

/** A guest may watch its session, load its history, send messages and stop a turn: nothing else,
 *  and only for its own session. Anything else is ignored without an answer. The link is looked up
 *  fresh each time, so a renamed guest or new rules apply at once and a revoked link stops working
 *  even on an open connection. */
async function handleGuestMessage(
  msg: WsInboundMessage,
  shareId: string,
  sessionManager: SessionManager,
  shares: ShareManager,
  reply: (msg: WsOutboundMessage) => void,
  disconnect: () => void,
) {
  if (msg.type === 'ping') return;
  const share = shares.get(shareId);
  if (!share) {
    disconnect();
    return;
  }
  const sessionId = share.sessionId;
  switch (msg.type) {
    case 'request_history': {
      const session = sessionManager.getSession(sessionId);
      if (session && msg.sessionId === sessionId) {
        reply({ type: 'session_history', sessionId, messages: guestMessages(toClientHistory(session.getState()), share) });
      }
      return;
    }
    case 'send_message': {
      if (msg.sessionId !== sessionId) return;
      const text = String(msg.message ?? '').trim().slice(0, 20_000);
      if (!text) return;
      logUsage('guest_send_message', { sessionId });
      shares.touch(share.id);
      // Text only, on the session's own model: no attachments, plan mode, or per-turn overrides.
      await sessionManager.sendMessage(sessionId, text, undefined, { author: { name: share.guestName, shareId: share.id } });
      return;
    }
    case 'interrupt_session': {
      if (msg.sessionId !== sessionId) return;
      logUsage('guest_interrupt', { sessionId });
      await sessionManager.interruptSession(sessionId);
      return;
    }
    default:
      return;
  }
}

async function handleMessage(
  msg: WsInboundMessage,
  sessionManager: SessionManager,
  broadcast: (msg: WsOutboundMessage) => void,
  getTriggers: () => TriggerManager,
  getProjectRunner: () => import('./project-runner.js').ProjectRunner,
  getModelPlanRunner: () => import('./model-plan-runner.js').ModelPlanRunner,
  getTags: () => TagManager,
  getUiState: () => UiStateManager,
  getShares: () => ShareManager,
  /** Send to the requesting client only (not a broadcast). */
  reply: (msg: WsOutboundMessage) => void,
) {
  // Single chokepoint for feature-usage logging — every inbound action passes through here.
  // 'ping' is a pure heartbeat with no feature signal, so it's excluded. 'log_event' is the
  // client's generic channel for pure-navigation actions (tab switches, modal opens) that
  // never otherwise reach the server — log under its own feature name, not the literal type.
  if (msg.type === 'log_event') {
    logUsage(String(msg.feature).slice(0, 60), msg.detail);
  } else if (msg.type !== 'ping' && msg.type !== 'mark_read') {
    logUsage(msg.type, safeDetail(msg));
  }

  switch (msg.type) {
    case 'create_session': {
      try {
        // "New project": the client sends only a folder name and the server decides where it
        // goes (the dev root) — config.cwd is replaced on this path, never trusted.
        let config = msg.config;
        if (msg.projectFolder) {
          const folder = ensureProjectFolder(msg.projectFolder);
          if (folder.created) console.log(`[Projects] Created ${folder.path}`);
          config = { ...config, cwd: folder.path };
        }
        sessionManager.createSession(config);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: '', message: err.message });
      }
      break;
    }

    case 'send_message': {
      try {
        await sessionManager.sendMessage(msg.sessionId, msg.message, msg.images, { planMode: msg.planMode, files: msg.files, model: msg.model, effort: msg.effort });
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'set_goal': {
      try {
        sessionManager.setGoal(msg.sessionId, msg.goal);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'set_notes': {
      try {
        sessionManager.setNotes(msg.sessionId, msg.notes);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'set_pinned': {
      try {
        sessionManager.setPinned(msg.sessionId, msg.pinned);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'request_history': {
      // The session list carries only recent messages (client-view.ts); the browser asks for the
      // rest when you actually open a session.
      try {
        const session = sessionManager.getSession(msg.sessionId);
        if (session) reply({ type: 'session_history', sessionId: msg.sessionId, messages: toClientHistory(session.getState()) });
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'request_debug_log': {
      // The session list leaves debug logs out (client-view.ts); a session's Debug tab asks here.
      const session = sessionManager.getSession(msg.sessionId);
      if (session) reply({ type: 'session_debug_log', sessionId: msg.sessionId, entries: session.getState().debugLog });
      break;
    }

    // Cross-device view state (ui-state.ts). Ids of sessions that don't exist are ignored.
    case 'mark_read': {
      if (sessionManager.getSession(msg.sessionId)) getUiState().markRead(msg.sessionId);
      break;
    }

    case 'set_tab_closed': {
      if (sessionManager.getSession(msg.sessionId)) getUiState().setTabClosed(msg.sessionId, !!msg.closed);
      break;
    }

    case 'set_pin_order': {
      if (Array.isArray(msg.ids)) getUiState().setPinOrder(msg.ids);
      break;
    }

    case 'merge_ui_state': {
      getUiState().merge(msg.state);
      break;
    }

    case 'set_tags': {
      try {
        // Drop ids the registry doesn't know about (stale client / deleted tag).
        const valid = msg.tags.filter(id => getTags().has(id));
        sessionManager.setTags(msg.sessionId, valid);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'create_tag': {
      try {
        getTags().create({ label: msg.label, color: msg.color });
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: '', message: err.message });
      }
      break;
    }

    case 'update_tag': {
      try {
        getTags().update(msg.id, { label: msg.label, color: msg.color });
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: '', message: err.message });
      }
      break;
    }

    case 'delete_tag': {
      try {
        if (getTags().delete(msg.id)) {
          // Cascade: strip the deleted tag from every session that carries it.
          sessionManager.removeTagFromAllSessions(msg.id);
        }
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: '', message: err.message });
      }
      break;
    }

    case 'pin_message': {
      try {
        sessionManager.setMessagePinned(msg.sessionId, msg.messageId, msg.pinned);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'stop_model_plan': {
      try {
        sessionManager.stopModelPlan(msg.sessionId);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'plan_response': {
      try {
        const session = sessionManager.getSession(msg.sessionId);
        if (!session) throw new Error('Session not found');

        // Custom Plan: on accept, try to pull the machine-readable clauder-steps block out
        // of the plan text and start a model plan directly — no extra turn on the (expensive)
        // planning model. Any failure to find/parse a valid block degrades to the legacy
        // "Plan approved..." message; an accept must never hard-fail.
        // Clear the pending-plan snapshot state on either decision so the banner drops on
        // every connected client (incl. reconnecting ones) once the plan is resolved.
        session.pendingPlan = null;
        if (msg.decision === 'accept') {
          const planText = session.lastPlanText;
          session.lastPlanText = null;
          const stepsBlock = planText ? /```clauder-steps\s*([\s\S]*?)```/.exec(planText) : null;
          let steps: unknown[] | null = null;
          if (stepsBlock) {
            try {
              const parsed = JSON.parse(stepsBlock[1].trim());
              if (Array.isArray(parsed.steps) && parsed.steps.length > 0) steps = parsed.steps;
            } catch {
              // malformed JSON — fall through to legacy behavior below
            }
          }
          broadcast({ type: 'plan_resolved', sessionId: msg.sessionId, toolUseId: msg.toolUseId });
          if (steps) {
            session.setModelPlan(steps);
            getModelPlanRunner().kickstartActivePlans();
          } else {
            const followUp = `Plan approved. Proceed with the plan as described.${msg.feedback ? `\n\nAdditional note: ${msg.feedback}` : ''}`;
            await sessionManager.sendMessage(msg.sessionId, followUp);
          }
        } else {
          session.lastPlanText = null;
          const followUp = `Plan rejected. ${msg.feedback || 'Please reconsider the approach and propose an alternative.'}`;
          broadcast({ type: 'plan_resolved', sessionId: msg.sessionId, toolUseId: msg.toolUseId });
          await sessionManager.sendMessage(msg.sessionId, followUp);
        }
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

    case 'archive_session': {
      logUsage('archive_session', { sessionId: msg.sessionId });
      try {
        await sessionManager.archiveSession(msg.sessionId);
        // Same cleanup destroy_session does — archiveSession destroys the session internally.
        getTriggers().removeSessionTriggers(msg.sessionId);
      } catch (err: any) {
        broadcast({ type: 'archive_status', sessionId: msg.sessionId, stage: 'error', message: err.message });
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

    case 'stop_monitor': {
      try {
        sessionManager.stopMonitor(msg.sessionId, msg.monitorId);
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

    case 'park_thread': {
      try {
        sessionManager.parkThread(msg.sessionId, msg.name);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'resume_thread': {
      try {
        sessionManager.resumeThread(msg.sessionId, msg.threadId);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'discard_thread': {
      try {
        sessionManager.discardThread(msg.sessionId, msg.threadId);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'start_task': {
      try {
        sessionManager.startTask(msg.sessionId, { name: msg.name, model: msg.model, effort: msg.effort });
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'rename_thread': {
      try {
        sessionManager.renameThread(msg.sessionId, msg.threadId, msg.name);
      } catch (err: any) {
        broadcast({ type: 'error', sessionId: msg.sessionId, message: err.message });
      }
      break;
    }

    case 'log_event':
      // Already logged above — no other action needed
      break;

    // Share links. The manager broadcasts the updated list to owner connections.
    case 'create_share': {
      if (!sessionManager.getSession(msg.sessionId)) throw new Error('Session not found');
      getShares().create({ sessionId: msg.sessionId, guestName: String(msg.guestName ?? ''), rules: String(msg.rules ?? '') });
      break;
    }
    case 'update_share':
      getShares().update(msg.id, { guestName: msg.guestName, rules: msg.rules });
      break;
    case 'revoke_share':
      getShares().revoke(msg.id);
      break;

    case 'ping':
      // Client keepalive — no-op
      break;
  }
}
