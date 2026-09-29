import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import type { MonitorInfo } from '@clauder/shared';

/** The bits of a ManagedSession a monitor needs, exposed as functions so they're read at
 *  call-time — the controller is constructed as a field initializer (before the session's
 *  constructor body sets `id`/`config`), so capturing values eagerly would capture undefined. */
export interface MonitorHost {
  id(): string;
  cwd(): string;
  isIdle(): boolean;
  /** Deliver a monitor event to the session (send now if idle, else queue for after the turn). */
  deliver(message: string): void;
  /** Push the current monitor list to clients (for the UI chips). */
  onMonitorsChanged(monitors: MonitorInfo[]): void;
}

export interface MonitorSpec {
  command: string;
  pattern?: string;
  description?: string;
  stopOnMatch?: boolean;
  maxRuntimeSec?: number;
}

interface ActiveMonitor {
  info: MonitorInfo;
  child: ChildProcess | null;
  regex: RegExp | null;
  buffer: string[];        // matched lines awaiting the next flush
  truncated: boolean;      // buffer hit MAX_LINES_PER_WAKE since the last flush
  remainder: string;       // partial trailing line carried between stdout chunks
  debounceTimer: NodeJS.Timeout | null;
  autoStopTimer: NodeJS.Timeout | null;
  lastWakeAt: number;      // epoch ms of the last delivered batch (rate-limit anchor)
}

const MAX_MONITORS = 3;              // per session
const DEBOUNCE_MS = 3_000;           // collect a burst of matches before waking
const MIN_WAKE_INTERVAL_MS = 30_000; // never wake the session more than once per this window
const MAX_LINES_PER_WAKE = 40;       // cap lines carried into one wake message
const MAX_LINE_LEN = 2_000;          // truncate very long lines
const DEFAULT_RUNTIME_MS = 2 * 60 * 60 * 1000; // 2h
const MAX_RUNTIME_MS = 6 * 60 * 60 * 1000;     // hard cap
const MIN_RUNTIME_MS = 60_000;

/** Runs and watches per-session background commands, waking the session on matching output.
 *  See MonitorInfo for the user-facing model. All timers are unref'd so monitors never keep the
 *  process alive; children are spawned detached and killed by process-group so pipelines die too. */
export class MonitorController {
  private monitors = new Map<string, ActiveMonitor>();

  constructor(private host: MonitorHost) {}

  list(): MonitorInfo[] {
    return [...this.monitors.values()].map(m => m.info);
  }

  /** Start a monitor. Returns the new id, or an error string for the caller to surface. */
  start(spec: MonitorSpec): { id?: string; error?: string } {
    const command = String(spec.command || '').trim();
    if (!command) return { error: 'monitor: missing "command"' };
    if (this.monitors.size >= MAX_MONITORS) {
      return { error: `monitor: already at the max of ${MAX_MONITORS} — stop one first` };
    }
    let regex: RegExp | null = null;
    if (spec.pattern) {
      try { regex = new RegExp(String(spec.pattern)); }
      catch (e: any) { return { error: `monitor: invalid pattern regex: ${e.message}` }; }
    }

    const id = randomUUID().slice(0, 8);
    const runtimeMs = Math.min(
      MAX_RUNTIME_MS,
      Math.max(MIN_RUNTIME_MS, (Number(spec.maxRuntimeSec) || 0) * 1000 || DEFAULT_RUNTIME_MS),
    );
    const info: MonitorInfo = {
      id,
      description: (String(spec.description || '').trim() || command).slice(0, 120),
      command: command.slice(0, 500),
      pattern: spec.pattern ? String(spec.pattern).slice(0, 300) : undefined,
      stopOnMatch: !!spec.stopOnMatch,
      createdAt: new Date().toISOString(),
      autoStopAt: new Date(Date.now() + runtimeMs).toISOString(),
      matchCount: 0,
      status: 'running',
    };
    const m: ActiveMonitor = {
      info, child: null, regex, buffer: [], truncated: false, remainder: '',
      debounceTimer: null, autoStopTimer: null, lastWakeAt: 0,
    };

    let child: ChildProcess;
    try {
      // detached so a pipeline (`tail | grep`) becomes its own process group we can group-kill.
      child = spawn('bash', ['-lc', command], { cwd: this.host.cwd(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e: any) {
      return { error: `monitor: failed to start: ${e.message}` };
    }
    m.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onData(m, chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => this.onData(m, chunk)); // stderr lines count too
    child.on('error', (err) => {
      this.host.deliver(`[Monitor: ${info.description}] failed to start (id ${id}): ${err.message}`);
      this.stop(id, false);
    });
    child.on('exit', (code, signal) => this.onExit(m, code, signal));

    m.autoStopTimer = setTimeout(() => {
      this.stop(id, false);
      this.host.deliver(`[Monitor: ${info.description}] auto-stopped after reaching its time limit (id ${id}).`);
    }, runtimeMs);
    m.autoStopTimer.unref?.();

    this.monitors.set(id, m);
    this.host.onMonitorsChanged(this.list());
    console.log(`[Session ${this.host.id()}] Monitor started ${id}: ${info.description}`);
    return { id };
  }

  /** Stop a monitor. `notify` controls whether the session is woken with a "stopped" note
   *  (used for lifecycle events; a user-initiated stop passes false). */
  stop(id: string, notify: boolean): void {
    const m = this.monitors.get(id);
    if (!m) return;
    this.clearTimers(m);
    this.killChild(m);
    this.monitors.delete(id);
    if (notify) this.host.deliver(`[Monitor: ${m.info.description}] stopped (id ${id}).`);
    this.host.onMonitorsChanged(this.list());
    console.log(`[Session ${this.host.id()}] Monitor stopped ${id}`);
  }

  /** Tear down every monitor with no delivery/broadcast — for session destroy. */
  stopAll(): void {
    for (const m of this.monitors.values()) {
      this.clearTimers(m);
      this.killChild(m);
    }
    this.monitors.clear();
  }

  // ── internals ────────────────────────────────────────────────────────────

  private onData(m: ActiveMonitor, chunk: string): void {
    const text = m.remainder + chunk;
    const parts = text.split('\n');
    m.remainder = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.replace(/\r$/, '');
      if (!line) continue;
      if (m.regex && !m.regex.test(line)) continue;
      m.info.matchCount++;
      m.info.lastMatchAt = new Date().toISOString();
      if (m.buffer.length < MAX_LINES_PER_WAKE) m.buffer.push(line.slice(0, MAX_LINE_LEN));
      else m.truncated = true;
    }
    if (m.buffer.length > 0) this.scheduleFlush(m);
  }

  private scheduleFlush(m: ActiveMonitor): void {
    if (m.debounceTimer) return; // one pending flush at a time
    m.debounceTimer = setTimeout(() => { m.debounceTimer = null; this.flush(m); }, DEBOUNCE_MS);
    m.debounceTimer.unref?.();
  }

  private flush(m: ActiveMonitor, force = false): void {
    if (m.buffer.length === 0) return;
    const since = Date.now() - m.lastWakeAt;
    if (!force && since < MIN_WAKE_INTERVAL_MS) {
      // Woke too recently — hold the batch and retry when the rate-limit window opens.
      const wait = MIN_WAKE_INTERVAL_MS - since;
      m.debounceTimer = setTimeout(() => { m.debounceTimer = null; this.flush(m); }, wait);
      m.debounceTimer.unref?.();
      return;
    }
    const lines = m.buffer;
    const truncated = m.truncated;
    m.buffer = [];
    m.truncated = false;
    m.lastWakeAt = Date.now();

    const count = `${lines.length}${truncated ? '+' : ''}`;
    const header = `[Monitor: ${m.info.description}] ${count} new match${lines.length !== 1 ? 'es' : ''} (id ${m.info.id}):`;
    const footer = m.info.stopOnMatch
      ? '\n\n(One-shot monitor — now stopped.)'
      : `\n\n(Monitoring continues. To stop it, emit <<monitor_stop>>{"id":"${m.info.id}"}<<>>.)`;
    this.host.deliver(`${header}\n${lines.join('\n')}${footer}`);
    this.host.onMonitorsChanged(this.list());

    if (m.info.stopOnMatch) this.stop(m.info.id, false);
  }

  private onExit(m: ActiveMonitor, code: number | null, signal: string | null): void {
    if (!this.monitors.has(m.info.id)) return; // already stopped by us — child kill, not a real exit
    this.clearTimers(m);
    this.monitors.delete(m.info.id);
    const tail = m.buffer.length ? `\nFinal ${m.buffer.length} line(s):\n${m.buffer.join('\n')}` : '';
    const how = signal ? `signal ${signal}` : `exit ${code ?? 0}`;
    this.host.deliver(`[Monitor: ${m.info.description}] the watched process ended (${how}); monitoring stopped (id ${m.info.id}).${tail}`);
    this.host.onMonitorsChanged(this.list());
    console.log(`[Session ${this.host.id()}] Monitor ${m.info.id} process exited (${how})`);
  }

  private clearTimers(m: ActiveMonitor): void {
    if (m.debounceTimer) { clearTimeout(m.debounceTimer); m.debounceTimer = null; }
    if (m.autoStopTimer) { clearTimeout(m.autoStopTimer); m.autoStopTimer = null; }
  }

  private killChild(m: ActiveMonitor): void {
    const child = m.child;
    m.child = null;
    if (!child || child.pid == null) return;
    // Group-kill (negative pid) so a detached pipeline dies with its shell; fall back to a
    // direct kill if the group is already gone.
    try { process.kill(-child.pid, 'SIGTERM'); }
    catch { try { child.kill('SIGTERM'); } catch { /* already dead */ } }
  }
}
