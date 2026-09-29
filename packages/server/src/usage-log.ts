import fs from 'fs';
import path from 'path';
import os from 'os';

// Feature-usage analytics — a plain append-only log of "what did I click/use" so it can be
// reviewed later to see what's actually used vs. never touched. Deliberately separate from
// clauder.log (operational/debug output) and debugLog (per-session SDK trace): this is a
// cross-session, human-reviewable usage record, not a debugging tool.
//
// Never logs message/notes/goal TEXT or file contents — only which feature fired and a few
// safe scalar fields (sessionId, model, effort, etc.) — see safeDetail() call sites.

const CLAUDER_DIR = path.join(os.homedir(), '.clauder');
const LOG_FILE = path.join(CLAUDER_DIR, 'usage-log.jsonl');

/** Keep the log from growing forever across months of daily use. Trimmed at startup, not on
 *  every write — this is a review-later log, not something read continuously. */
const MAX_LINES = 20_000;

export function logUsage(feature: string, detail?: Record<string, unknown>): void {
  try {
    if (!fs.existsSync(CLAUDER_DIR)) fs.mkdirSync(CLAUDER_DIR, { recursive: true });
    const entry = { ts: new Date().toISOString(), feature, ...detail };
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[usage-log] Failed to append:', err);
  }
}

/** Trim to the most recent MAX_LINES entries. Call once at startup. */
export function trimUsageLog(): void {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const lines = fs.readFileSync(LOG_FILE, 'utf-8').split('\n').filter(Boolean);
    if (lines.length > MAX_LINES) {
      fs.writeFileSync(LOG_FILE, lines.slice(-MAX_LINES).join('\n') + '\n');
    }
  } catch (err) {
    console.error('[usage-log] Failed to trim:', err);
  }
}
