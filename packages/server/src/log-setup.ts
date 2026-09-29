import { existsSync, statSync, openSync, readSync, closeSync, writeFileSync, truncateSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── Log hygiene ──────────────────────────────────────────────────────────────
// launchd redirects stdout/stderr to ~/.clauder/clauder.log with no timestamps and no
// rotation. That made incident forensics near-impossible (a 90k-line log where nothing
// can be dated) and the file grows forever. This module must be imported FIRST in
// index.ts — ESM executes imports in declaration order, so patching here stamps even
// the import-time logs of other modules (e.g. session.ts's "Claude CLI found at").

// 1. Prefix every console line with an ISO timestamp.
for (const level of ['log', 'warn', 'error'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => orig(`[${new Date().toISOString()}]`, ...args);
}

// 2. Size-cap the log: when it exceeds LOG_MAX_BYTES, stash the most recent tail in
// clauder.log.old and truncate the main file. Truncation is safe with launchd's
// append-mode redirection — subsequent writes land at the new end of file.
const LOG_FILE = join(homedir(), '.clauder', 'clauder.log');
const LOG_MAX_BYTES = 15 * 1024 * 1024; // trim threshold
const LOG_KEEP_BYTES = 2 * 1024 * 1024; // recent tail preserved in .old

function trimClauderLog(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const { size } = statSync(LOG_FILE);
    if (size <= LOG_MAX_BYTES) return;
    const fd = openSync(LOG_FILE, 'r');
    const buf = Buffer.alloc(LOG_KEEP_BYTES);
    try {
      readSync(fd, buf, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES);
    } finally {
      closeSync(fd);
    }
    writeFileSync(`${LOG_FILE}.old`, buf);
    truncateSync(LOG_FILE, 0);
    console.log(`[Clauder] Trimmed clauder.log (was ${(size / 1e6).toFixed(1)}MB; last ${(LOG_KEEP_BYTES / 1e6).toFixed(0)}MB kept in clauder.log.old)`);
  } catch (err) {
    console.error('[Clauder] Log trim failed:', err);
  }
}

trimClauderLog();
setInterval(trimClauderLog, 24 * 60 * 60 * 1000).unref();
