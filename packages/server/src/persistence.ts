import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SessionState, SessionOrigin, PendingWakeup } from '@clauder/shared';

const CLAUDER_DIR = path.join(os.homedir(), '.clauder');
const SESSIONS_FILE = path.join(CLAUDER_DIR, 'sessions.json');

export interface PersistedSession {
  id: string;
  config: SessionState['config'];
  origin: SessionOrigin;
  sdkSessionId: string | null;
  totalCostUsd: number;
  contextUsage: SessionState['contextUsage'];
  messages: SessionState['messages'];
  permissionMode?: string;
  summary?: string | null;
  summaryGeneratedAt?: string | null;
  compactedContext?: string | null;
  pendingWakeup?: PendingWakeup | null;
  createdAt: string;
  lastActiveAt: string;
}

function ensureDir() {
  if (!fs.existsSync(CLAUDER_DIR)) {
    fs.mkdirSync(CLAUDER_DIR, { recursive: true });
  }
}

const PERSIST_TOOL_RESULT_MAX = 2_000;

export function saveSessions(sessions: SessionState[]): void {
  ensureDir();
  const persisted: PersistedSession[] = sessions.map((s) => ({
    id: s.id,
    config: s.config,
    origin: s.origin,
    sdkSessionId: s.sdkSessionId,
    totalCostUsd: s.totalCostUsd,
    contextUsage: s.contextUsage,
    messages: s.messages.slice(-50).map((m) => ({
      ...m,
      // Truncate tool result content for persistence
      toolUses: m.toolUses?.map((tu) => ({
        ...tu,
        result: tu.result ? {
          ...tu.result,
          content: tu.result.content.slice(0, PERSIST_TOOL_RESULT_MAX),
          originalLength: tu.result.content.length > PERSIST_TOOL_RESULT_MAX
            ? (tu.result.originalLength ?? tu.result.content.length)
            : tu.result.originalLength,
        } : undefined,
      })),
    })),
    permissionMode: s.permissionMode,
    summary: s.summary,
    summaryGeneratedAt: s.summaryGeneratedAt,
    compactedContext: s.compactedContext,
    pendingWakeup: s.pendingWakeup,
    createdAt: s.createdAt,
    lastActiveAt: s.lastActiveAt,
  }));
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(persisted, null, 2));
}

export function loadSessions(): PersistedSession[] {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return [];
    const data = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (err) {
    console.error('[Persistence] Failed to load sessions:', err);
    return [];
  }
}
