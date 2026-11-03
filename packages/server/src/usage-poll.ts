import { execFile } from 'child_process';
import os from 'os';
import type { RateLimitWindow } from '@clauder/shared';
import { CLAUDE_CLI_PATH, CLI_IS_NATIVE } from './session.js';
import { recordUsageReading } from './rate-limits.js';

// The CLI's /usage, read every 15 minutes. It's the only place the separate weekly limit on Fable
// shows ("Current week (Fable): 92% used · resets Nov 3 at 4pm (America/New_York)"): the
// rate_limit_event on each turn carries just the window nearest its limit. Running /usage makes no
// model call, so it costs nothing.

const EVERY_MS = 15 * 60_000;
/** A week at or past this is flagged allowed_warning, as the CLI does at 75%. */
const WARN_AT = 75;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Milliseconds `tz` is ahead of UTC at instant `t`. */
function tzOffset(t: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - t;
}

/** "Nov 3 at 4pm (America/New_York)" or "Nov 3 at 4:30pm (...)" → the instant, or null. */
export function parseReset(text: string, now = Date.now()): string | null {
  const m = /([A-Z][a-z]{2}) (\d{1,2}) at (\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(text);
  if (!m) return null;
  const mon = MONTHS.findIndex(x => x.toLowerCase() === m[1].toLowerCase());
  if (mon < 0) return null;
  let hour = Number(m[3]) % 12;
  if (m[5].toLowerCase() === 'pm') hour += 12;
  const tz = m[6];
  try {
    for (const year of [new Date(now).getUTCFullYear(), new Date(now).getUTCFullYear() + 1]) {
      const guess = Date.UTC(year, mon, Number(m[2]), hour, Number(m[4] ?? 0));
      const t = guess - tzOffset(guess, tz);
      if (t > now - 86_400_000) return new Date(t).toISOString();
    }
  } catch { /* unknown time zone */ }
  return null;
}

/** The weekly lines of /usage's text, as windows. */
export function parseUsage(text: string, now = Date.now()): { weekly?: RateLimitWindow; fable?: RateLimitWindow } {
  const out: { weekly?: RateLimitWindow; fable?: RateLimitWindow } = {};
  for (const line of text.split('\n')) {
    const m = /^\s*Current week \(([^)]+)\):\s*(\d+)% used\s*·\s*resets\s+(.*)$/i.exec(line);
    if (!m) continue;
    const resetsAt = parseReset(m[3], now);
    if (!resetsAt) continue;
    const pct = Number(m[2]);
    const w: RateLimitWindow = { usedPercent: pct, resetsAt, status: pct >= 100 ? 'rejected' : pct >= WARN_AT ? 'allowed_warning' : 'allowed' };
    if (/all models/i.test(m[1])) out.weekly = w;
    else if (/fable/i.test(m[1])) out.fable = w;
  }
  return out;
}

let running = false;
let started = false;

function poll(): void {
  if (running) return; // one /usage at a time, however it's called
  running = true;
  const args = ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'];
  const env = { ...process.env }; delete env.CLAUDECODE;
  execFile(CLI_IS_NATIVE ? CLAUDE_CLI_PATH : process.execPath, CLI_IS_NATIVE ? args : [CLAUDE_CLI_PATH, ...args],
    { cwd: os.tmpdir(), env, timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (err, stdout) => {
      running = false;
      if (err) { console.error('[UsagePoll] /usage failed:', err.message); return; }
      try {
        const text = String(JSON.parse(stdout).result ?? '');
        const reading = parseUsage(text);
        if (!reading.weekly && !reading.fable) { console.error('[UsagePoll] No weekly lines in /usage output'); return; }
        // No Fable line means no Fable limit now: clear it rather than keep a stale one.
        recordUsageReading({ weekly: reading.weekly, fable: reading.fable ?? null });
      } catch (e) {
        console.error('[UsagePoll] Could not read /usage output:', e);
      }
    });
}

/** Start polling. Only the first call does anything. */
export function startUsagePoll(): void {
  if (started) return;
  started = true;
  setTimeout(poll, 20_000).unref();
  setInterval(poll, EVERY_MS).unref();
}
