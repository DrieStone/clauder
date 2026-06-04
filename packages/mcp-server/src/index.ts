#!/usr/bin/env node
/**
 * Clauder MCP Server
 *
 * Exposes Clauder operations as MCP tools so a "controller" Claude session
 * can orchestrate other (pre-created) worker sessions.
 *
 * Communicates with the running Clauder server over its HTTP API.
 * Configured via env vars:
 *   CLAUDER_URL          — base URL (default http://localhost:3001)
 *   CLAUDER_CONTROLLER_ID — sessionId of the controller (to exclude from list_sessions)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';

const CLAUDER_URL = process.env.CLAUDER_URL || 'http://localhost:3001';
const CONTROLLER_ID = process.env.CLAUDER_CONTROLLER_ID || '';

function formatResetsIn(resetsAt: string): string {
  const diffMs = new Date(resetsAt).getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const totalSec = Math.floor(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const server = new Server(
  { name: 'clauder', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

interface SessionSummary {
  id: string;
  name: string;
  cwd: string;
  status: string;
  totalCostUsd: number;
  lastActiveAt: string;
  error: string | null;
}

interface SessionMessage {
  id: string;
  role: string;
  content: string;
  timestamp: string;
}

async function fetchSessions(): Promise<SessionSummary[]> {
  const res = await fetch(`${CLAUDER_URL}/api/sessions`);
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
  const data = await res.json() as any[];
  return data.map(s => ({
    id: s.id,
    name: s.config?.name || 'Unnamed',
    cwd: s.config?.cwd || '',
    status: s.status,
    totalCostUsd: s.totalCostUsd || 0,
    lastActiveAt: s.lastActiveAt,
    error: s.error,
  }));
}

async function fetchSession(sessionId: string): Promise<any> {
  const res = await fetch(`${CLAUDER_URL}/api/sessions/${sessionId}`);
  if (!res.ok) throw new Error(`Session ${sessionId} not found`);
  return await res.json();
}

/** Send a WS command to Clauder and resolve when the socket closes. */
async function sendWsCommand(message: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const wsUrl = CLAUDER_URL.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    let sent = false;
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WS command timed out'));
    }, 10000);
    ws.on('open', () => {
      ws.send(JSON.stringify(message));
      sent = true;
      // Give the server a moment to process before closing
      setTimeout(() => ws.close(), 200);
    });
    ws.on('close', () => {
      clearTimeout(timeout);
      if (sent) resolve();
      else reject(new Error('WS closed before sending'));
    });
    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_sessions',
      description:
        'List all available Clauder sessions (workers). Returns id, name, status (idle/working/error), working directory, total cost, last activity, and any error. Use this to see what workers are available to dispatch tasks to.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'send_message',
      description:
        'Send a message to a worker session. The message is delivered to that session\'s Claude instance as if you (the user) typed it. If the worker is currently busy, the message is queued and processed when it finishes. Returns immediately — use wait_until_idle to wait for the worker to finish processing.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The worker session ID (from list_sessions)' },
          message: { type: 'string', description: 'The instruction/message to send to the worker' },
        },
        required: ['sessionId', 'message'],
      },
    },
    {
      name: 'wait_until_idle',
      description:
        'Block until a worker session finishes its current turn (returns to idle status). Polls every few seconds. Returns the session\'s final status, recent message count, and whether it has an error. Use this after send_message to wait for the worker to finish before reading its output.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The worker session ID' },
          timeoutSec: { type: 'number', description: 'Max time to wait (default 1800 = 30min)' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'get_recent_messages',
      description:
        'Read the most recent messages from a worker session. Returns role (user/assistant), text content, and timestamp for each. Use this after wait_until_idle to see what the worker did and decide next steps.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The worker session ID' },
          count: { type: 'number', description: 'How many recent messages to fetch (default 10)' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'get_session_status',
      description: 'Get the current status of a worker session (status, cost, error). Lightweight check; for full message history use get_recent_messages.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The worker session ID' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'add_watch',
      description:
        'Add a recurring self-check-in. The Clauder server will send you the given message every intervalSeconds (minimum 30). Use this to schedule periodic check-ins on long-running work — e.g., "every 20 minutes, check on the Wedding Website worker." When the check-in fires, you receive the message as if the user typed it, so phrase it as an instruction to yourself. Returns the watch ID so you can remove or update it later.',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Short human-readable label shown in the UI (e.g. "Check on Wedding Website")' },
          intervalSeconds: { type: 'number', description: 'How often to fire, in seconds. Minimum 30. Typical: 300 (5min), 1200 (20min), 3600 (1hr).' },
          message: { type: 'string', description: 'The instruction to send to yourself when it fires (e.g. "Check on the Wedding Website worker. If it\'s idle, review its recent messages and decide next steps.")' },
        },
        required: ['description', 'intervalSeconds', 'message'],
      },
    },
    {
      name: 'list_watches',
      description: 'List all your active recurring self-check-ins. Returns id, description, intervalSeconds, nextAt, message for each.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'remove_watch',
      description: 'Stop a recurring self-check-in. Use when a task is done or no longer needs monitoring.',
      inputSchema: {
        type: 'object',
        properties: {
          watchId: { type: 'string', description: 'The watch ID (from add_watch or list_watches)' },
        },
        required: ['watchId'],
      },
    },
    {
      name: 'update_watch',
      description: 'Change the interval, description, or message of an existing watch.',
      inputSchema: {
        type: 'object',
        properties: {
          watchId: { type: 'string', description: 'The watch ID' },
          intervalSeconds: { type: 'number', description: 'New interval in seconds (optional)' },
          description: { type: 'string', description: 'New description (optional)' },
          message: { type: 'string', description: 'New check-in message (optional)' },
        },
        required: ['watchId'],
      },
    },
    {
      name: 'get_rate_limit',
      description:
        'Get the current Claude subscription usage for the active session window. ' +
        'Returns status ("allowed" | "allowed_warning" | "rejected"), the reset timestamp, ' +
        'and utilization (0–100, or null if below the reporting threshold ~90%). ' +
        'Use this before dispatching expensive work to check headroom, and to get the exact ' +
        'resetsAt time so you can schedule a wakeup and resume after the window rolls over.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args || {}) as Record<string, any>;

  try {
    switch (name) {
      case 'list_sessions': {
        const sessions = await fetchSessions();
        // Hide the controller itself from the list so it doesn't try to message itself
        const workers = sessions.filter(s => s.id !== CONTROLLER_ID);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(workers, null, 2),
          }],
        };
      }

      case 'send_message': {
        if (a.sessionId === CONTROLLER_ID) {
          throw new Error('Cannot send_message to the controller session itself');
        }
        await sendWsCommand({
          type: 'send_message',
          sessionId: a.sessionId,
          message: a.message,
        });
        return {
          content: [{ type: 'text', text: `Message sent to ${a.sessionId}. Use wait_until_idle to wait for completion.` }],
        };
      }

      case 'wait_until_idle': {
        const timeoutSec = Math.max(10, Math.min(7200, a.timeoutSec || 1800));
        const deadline = Date.now() + timeoutSec * 1000;
        let lastStatus = '';
        while (Date.now() < deadline) {
          const s = await fetchSession(a.sessionId);
          lastStatus = s.status;
          if (s.status === 'idle' || s.status === 'error') {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: s.status,
                  totalCostUsd: s.totalCostUsd,
                  messageCount: s.messages?.length || 0,
                  error: s.error,
                }, null, 2),
              }],
            };
          }
          await new Promise(r => setTimeout(r, 5000));
        }
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'timeout', lastStatus, timeoutSec }, null, 2),
          }],
        };
      }

      case 'get_recent_messages': {
        const count = Math.max(1, Math.min(50, a.count || 10));
        const s = await fetchSession(a.sessionId);
        const messages: SessionMessage[] = (s.messages || []).slice(-count).map((m: any) => ({
          id: m.id,
          role: m.role,
          // Truncate very long messages to keep controller context manageable
          content: typeof m.content === 'string' && m.content.length > 4000
            ? m.content.slice(0, 4000) + `\n…[truncated ${m.content.length - 4000} chars]`
            : m.content,
          timestamp: m.timestamp,
        }));
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(messages, null, 2),
          }],
        };
      }

      case 'get_session_status': {
        const s = await fetchSession(a.sessionId);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              id: s.id,
              name: s.config?.name,
              status: s.status,
              totalCostUsd: s.totalCostUsd,
              error: s.error,
              lastActiveAt: s.lastActiveAt,
            }, null, 2),
          }],
        };
      }

      case 'add_watch': {
        if (!CONTROLLER_ID) throw new Error('CLAUDER_CONTROLLER_ID not set — cannot add watch');
        const intervalSec = Math.max(30, Number(a.intervalSeconds) || 300);
        const res = await fetch(`${CLAUDER_URL}/api/triggers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: CONTROLLER_ID,
            message: a.message,
            description: a.description,
            schedule: {
              type: 'recurring',
              intervalSeconds: intervalSec,
              nextAt: new Date(Date.now() + intervalSec * 1000).toISOString(),
            },
            source: 'watch',
          }),
        });
        if (!res.ok) throw new Error(`Failed to add watch: ${res.status} ${await res.text()}`);
        const trigger = await res.json();
        return {
          content: [{
            type: 'text',
            text: `Watch added (id: ${trigger.id}). Will fire every ${intervalSec}s. Next fire: ${trigger.schedule.nextAt}`,
          }],
        };
      }

      case 'list_watches': {
        if (!CONTROLLER_ID) throw new Error('CLAUDER_CONTROLLER_ID not set');
        const res = await fetch(`${CLAUDER_URL}/api/triggers?sessionId=${CONTROLLER_ID}&source=watch`);
        if (!res.ok) throw new Error(`Failed to list watches: ${res.status}`);
        const watches = await res.json() as any[];
        const simplified = watches.map(w => ({
          id: w.id,
          description: w.description,
          intervalSeconds: w.schedule.intervalSeconds,
          nextAt: w.schedule.nextAt,
          lastFiredAt: w.lastFiredAt,
          message: w.message,
          enabled: w.enabled,
        }));
        return {
          content: [{ type: 'text', text: JSON.stringify(simplified, null, 2) }],
        };
      }

      case 'remove_watch': {
        const res = await fetch(`${CLAUDER_URL}/api/triggers/${a.watchId}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`Failed to remove watch: ${res.status}`);
        return {
          content: [{ type: 'text', text: `Watch ${a.watchId} removed.` }],
        };
      }

      case 'update_watch': {
        const updates: any = {};
        if (a.intervalSeconds !== undefined) updates.intervalSeconds = Math.max(30, Number(a.intervalSeconds));
        if (a.description !== undefined) updates.description = a.description;
        if (a.message !== undefined) updates.message = a.message;
        const res = await fetch(`${CLAUDER_URL}/api/triggers/${a.watchId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        });
        if (!res.ok) throw new Error(`Failed to update watch: ${res.status}`);
        const trigger = await res.json();
        return {
          content: [{ type: 'text', text: `Watch updated. Next fire: ${trigger.schedule.nextAt}` }],
        };
      }

      case 'get_rate_limit': {
        const res = await fetch(`${CLAUDER_URL}/api/rate-limit`);
        if (!res.ok) throw new Error(`Failed to get rate limit: ${res.status}`);
        const info = await res.json() as any;
        // Surface the real subscription windows when available; fall back to the cost proxy summary.
        const session = info.session;
        const weekly = info.weekly;
        const result = {
          // Real subscription data (null until first rate_limit_event fires at ~90% usage)
          session: session ? {
            status: session.status,
            usedPercent: session.usedPercent,  // null = below reporting threshold
            resetsAt: session.resetsAt,
            resetsIn: session.resetsAt ? formatResetsIn(session.resetsAt) : null,
          } : null,
          weekly: weekly ? {
            status: weekly.status,
            usedPercent: weekly.usedPercent,
            resetsAt: weekly.resetsAt,
            resetsIn: weekly.resetsAt ? formatResetsIn(weekly.resetsAt) : null,
          } : null,
          // Cost proxy (always available, less accurate)
          proxy: {
            budgetUsed: info.budgetUsed,
            budgetLimit: info.budgetLimit,
            windowResetAt: info.windowResetAt,
          },
        };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Don't log to stdout — MCP uses stdio for JSON-RPC
  console.error('[clauder-mcp] Server started, waiting for requests...');
}

main().catch((err) => {
  console.error('[clauder-mcp] Fatal error:', err);
  process.exit(1);
});
