import fs from 'fs';
import os from 'os';
import path from 'path';
import type { KeepWarmStatus } from '@clauder/shared';

// Keeping sessions warm. A session's prompt cache lasts an hour on the subscription; past that, its
// next turn re-sends the whole conversation at full price (often $6-12 for a big Opus session). A
// session being kept warm gets a tiny hidden turn (ManagedSession.keepWarmPing) shortly before its
// cache would expire, which costs a cache read instead. Two ways a session is kept warm:
//   - automatically (on by default): every session, main or task, for 3 hours after its last real
//     turn (pings don't count), whether or not the owner is around;
//   - by hand: the 🔥 button warms a whole project for a set time (3 hours by default).
// Only sessions still warm (active in the last hour) are pinged: one already cold would cost a full
// re-send to warm, the very cost this avoids. Never on API credits, never near the usage limit.

const FILE = path.join(os.homedir(), '.clauder', 'keep-warm.json');
const MIN = 60_000;
/** Ping this long after the session's last API call (the cache lasts 60 minutes). */
const PING_AFTER_MS = 54 * MIN;
const CACHE_MS = 60 * MIN;
/** "Around": the owner did something in Clauder this recently (shown in the status only). */
const AROUND_MS = 2 * 60 * MIN;
/** Automatic warming covers a session for this long after its last real turn. */
const AUTO_WINDOW_MS = 3 * 60 * MIN;
/** No pings at or above this much of the 5-hour window. */
const QUOTA_STOP_PERCENT = 90;

export interface WarmSession {
  id: string;
  projectId: string;
  name: string;
  /** Last API call (the session's lastActiveAt). */
  lastActiveMs: number;
  idle: boolean;
}

interface Persisted {
  /** Automatic warming. Saved as `autoAll`: the older `auto` (owner-wrote-only, often switched off)
   *  is ignored, so the every-session default starts on. */
  autoAll: boolean;
  defaultHours: number;
  manual: Record<string, number>;
  stats: { pings: number; costUsd: number; since: string };
}

export class KeepWarm {
  private data: Persisted = { autoAll: true, defaultHours: 3, manual: {}, stats: { pings: 0, costUsd: 0, since: new Date().toISOString() } };
  private lastOwnerActivity = 0;
  private lastPing = new Map<string, number>();          // sessionId -> ms
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSent = '';

  constructor(private deps: {
    sessions: () => WarmSession[];
    ping: (sessionId: string) => Promise<number | null>;
    quotaBlocked: () => boolean;
    onChange: (status: KeepWarmStatus) => void;
    now?: () => number;
    file?: string;
  }) {}

  private now() { return this.deps.now ? this.deps.now() : Date.now(); }
  private get file() { return this.deps.file ?? FILE; }

  load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const d = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      delete d.auto;
      this.data = { ...this.data, ...d, stats: { ...this.data.stats, ...(d.stats ?? {}) } };
    } catch (err) { console.error('[KeepWarm] Failed to load:', err); }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data, null, 2));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (err) { console.error('[KeepWarm] Failed to save:', err); }
  }

  start(): void {
    this.timer = setInterval(() => { this.tick().catch(err => console.error('[KeepWarm] tick failed:', err)); }, MIN);
    this.timer.unref();
  }

  /** The owner did something in Clauder (any message from their browser but a heartbeat). */
  ownerActive(): void {
    const was = this.isAround();
    this.lastOwnerActivity = this.now();
    if (!was) this.changed();
  }

  /** The owner wrote in a project (not a guest, not Clauder itself). */
  ownerWrote(_projectId: string): void { this.ownerActive(); }

  setAuto(on: boolean): void { this.data.autoAll = !!on; this.save(); this.changed(); }

  /** Warm a project by hand for `hours` (null: stop). */
  setManual(projectId: string, hours: number | null): void {
    if (hours && hours > 0) this.data.manual[projectId] = this.now() + Math.min(hours, 24) * 60 * MIN;
    else delete this.data.manual[projectId];
    this.save();
    this.changed();
  }

  private isAround(): boolean { return this.now() - this.lastOwnerActivity < AROUND_MS; }

  /** Until when automatic warming covers a session, or null. */
  private autoUntil(s: WarmSession): number | null {
    if (!this.data.autoAll || this.now() - s.lastActiveMs >= AUTO_WINDOW_MS) return null;
    return s.lastActiveMs + AUTO_WINDOW_MS;
  }

  /** Until when a session is kept warm, and how; null if it isn't. By hand wins over automatic. */
  private sessionWarmUntil(s: WarmSession): { until: number; mode: 'manual' | 'auto' } | null {
    const manual = this.data.manual[s.projectId];
    if (manual && manual > this.now()) return { until: manual, mode: 'manual' };
    const auto = this.autoUntil(s);
    return auto ? { until: auto, mode: 'auto' } : null;
  }

  /** Until when a project is kept warm, and how; null if it isn't. Automatic: its latest session's. */
  warmUntil(projectId: string, sessions = this.deps.sessions()): { until: number; mode: 'manual' | 'auto' } | null {
    let best: { until: number; mode: 'manual' | 'auto' } | null = null;
    const manual = this.data.manual[projectId];
    if (manual && manual > this.now()) return { until: manual, mode: 'manual' };
    for (const s of sessions) {
      if (s.projectId !== projectId) continue;
      const until = this.autoUntil(s);
      if (until && (!best || until > best.until)) best = { until, mode: 'auto' };
    }
    return best;
  }

  async tick(): Promise<void> {
    const now = this.now();
    let dirty = false;
    for (const [p, until] of Object.entries(this.data.manual)) if (until <= now) { delete this.data.manual[p]; dirty = true; }
    if (dirty) this.save();
    if (!this.deps.quotaBlocked()) {
      for (const s of this.deps.sessions()) {
        if (!s.idle || !this.sessionWarmUntil(s)) continue;
        const last = Math.max(s.lastActiveMs, this.lastPing.get(s.id) ?? 0);
        const age = now - last;
        if (age < PING_AFTER_MS || age >= CACHE_MS) continue; // not due yet, or already cold
        this.lastPing.set(s.id, now);
        const cost = await this.deps.ping(s.id);
        if (cost !== null) {
          this.data.stats.pings++;
          this.data.stats.costUsd = Math.round((this.data.stats.costUsd + cost) * 100) / 100;
          this.save();
          console.log(`[KeepWarm] Pinged "${s.name}" (cache ${Math.round(age / MIN)} min old) for $${cost.toFixed(2)}`);
        }
      }
    }
    this.changed();
  }

  removeSession(sessionId: string): void { this.lastPing.delete(sessionId); }

  /** A destroyed project's by-hand warming goes with it. */
  setManualIfSet(projectId: string): void { if (projectId in this.data.manual) this.setManual(projectId, null); }

  status(): KeepWarmStatus {
    const all = this.deps.sessions();
    const projects: KeepWarmStatus['projects'] = {};
    const ids = new Set([...Object.keys(this.data.manual), ...all.map(s => s.projectId)]);
    for (const id of ids) {
      const w = this.warmUntil(id, all);
      if (w) projects[id] = { until: new Date(w.until).toISOString(), mode: w.mode };
    }
    const now = this.now();
    // Sessions whose cache is still alive and that will be pinged to keep it so (the 🔥 on task chips).
    const sessions = all.filter(s => this.sessionWarmUntil(s) && now - Math.max(s.lastActiveMs, this.lastPing.get(s.id) ?? 0) < CACHE_MS).map(s => s.id);
    return { auto: this.data.autoAll, around: this.isAround(), defaultHours: this.data.defaultHours, projects, sessions, pings: this.data.stats.pings, costUsd: this.data.stats.costUsd, since: this.data.stats.since };
  }

  /** Tell the browsers, when something they show changed. */
  private changed(): void {
    const s = this.status();
    const full = JSON.stringify(s);
    if (full === this.lastSent) return;
    this.lastSent = full;
    try { this.deps.onChange(s); } catch (err) { console.error('[KeepWarm] listener failed:', err); }
  }
}
