import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Trigger, TriggerSchedule } from '@clauder/shared';

const TRIGGERS_FILE = path.join(os.homedir(), '.clauder', 'triggers.json');

type FireFn = (sessionId: string, message: string) => void;
type BroadcastFn = (event: 'created' | 'updated' | 'deleted' | 'fired', trigger: Trigger, triggerId?: string) => void;

export class TriggerManager {
  private triggers = new Map<string, Trigger>();
  private timers = new Map<string, NodeJS.Timeout>();
  private fireFn: FireFn;
  private broadcastFn: BroadcastFn;

  constructor(fireFn: FireFn, broadcastFn: BroadcastFn) {
    this.fireFn = fireFn;
    this.broadcastFn = broadcastFn;
  }

  load(): void {
    try {
      if (!fs.existsSync(TRIGGERS_FILE)) return;
      const data = JSON.parse(fs.readFileSync(TRIGGERS_FILE, 'utf-8'));
      if (!Array.isArray(data)) return;
      for (const t of data) {
        this.triggers.set(t.id, t);
        this.scheduleNext(t);
      }
      console.log(`[TriggerManager] Loaded ${this.triggers.size} trigger(s) from disk`);
    } catch (err) {
      console.error('[TriggerManager] Failed to load:', err);
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(TRIGGERS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(TRIGGERS_FILE, JSON.stringify([...this.triggers.values()], null, 2));
    } catch (err) {
      console.error('[TriggerManager] Failed to save:', err);
    }
  }

  /** When should this trigger fire next? Returns null if disabled. */
  private nextFireMs(t: Trigger): number | null {
    if (!t.enabled) return null;
    if (t.schedule.type === 'once') return new Date(t.schedule.at).getTime();
    return new Date(t.schedule.nextAt).getTime();
  }

  private scheduleNext(t: Trigger): void {
    const existing = this.timers.get(t.id);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(t.id);
    }

    const fireAt = this.nextFireMs(t);
    if (fireAt === null) return;

    const delay = Math.max(0, fireAt - Date.now());
    const timer = setTimeout(() => this.fire(t.id), delay);
    this.timers.set(t.id, timer);
  }

  private fire(triggerId: string): void {
    const t = this.triggers.get(triggerId);
    if (!t || !t.enabled) return;

    t.lastFiredAt = new Date().toISOString();
    console.log(`[TriggerManager] Firing "${t.description}" → session ${t.sessionId}`);

    try {
      this.fireFn(t.sessionId, t.message);
    } catch (err: any) {
      console.error(`[TriggerManager] Fire failed for ${t.id}:`, err.message);
    }

    this.broadcastFn('fired', t);

    if (t.schedule.type === 'once') {
      // One-shot: delete after firing
      this.timers.delete(t.id);
      this.triggers.delete(t.id);
      this.broadcastFn('deleted', t);
    } else {
      // Recurring: set next fire time
      t.schedule = {
        type: 'recurring',
        intervalSeconds: t.schedule.intervalSeconds,
        nextAt: new Date(Date.now() + t.schedule.intervalSeconds * 1000).toISOString(),
      };
      this.scheduleNext(t);
      this.broadcastFn('updated', t);
    }

    this.save();
  }

  create(input: {
    sessionId: string;
    message: string;
    description: string;
    schedule: TriggerSchedule;
    source: 'watch' | 'scheduled';
  }): Trigger {
    const trigger: Trigger = {
      id: uuid(),
      sessionId: input.sessionId,
      message: input.message,
      description: input.description,
      schedule: input.schedule,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastFiredAt: null,
      source: input.source,
    };
    this.triggers.set(trigger.id, trigger);
    this.scheduleNext(trigger);
    this.save();
    this.broadcastFn('created', trigger);
    return trigger;
  }

  update(id: string, updates: {
    intervalSeconds?: number;
    message?: string;
    description?: string;
    enabled?: boolean;
    scheduleAt?: string;  // for one-shot reschedule
  }): Trigger | null {
    const t = this.triggers.get(id);
    if (!t) return null;

    if (updates.message !== undefined) t.message = updates.message;
    if (updates.description !== undefined) t.description = updates.description;
    if (updates.enabled !== undefined) t.enabled = updates.enabled;
    if (updates.intervalSeconds !== undefined && t.schedule.type === 'recurring') {
      t.schedule.intervalSeconds = updates.intervalSeconds;
      t.schedule.nextAt = new Date(Date.now() + updates.intervalSeconds * 1000).toISOString();
    }
    if (updates.scheduleAt !== undefined && t.schedule.type === 'once') {
      t.schedule.at = updates.scheduleAt;
    }

    this.scheduleNext(t);
    this.save();
    this.broadcastFn('updated', t);
    return t;
  }

  remove(id: string): boolean {
    const t = this.triggers.get(id);
    if (!t) return false;
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.triggers.delete(id);
    this.save();
    this.broadcastFn('deleted', t);
    return true;
  }

  list(filter?: { sessionId?: string; source?: 'watch' | 'scheduled' }): Trigger[] {
    let result = [...this.triggers.values()];
    if (filter?.sessionId) result = result.filter(t => t.sessionId === filter.sessionId);
    if (filter?.source) result = result.filter(t => t.source === filter.source);
    return result;
  }

  get(id: string): Trigger | undefined {
    return this.triggers.get(id);
  }

  /** Remove all triggers for a destroyed session. */
  removeSessionTriggers(sessionId: string): void {
    for (const t of [...this.triggers.values()]) {
      if (t.sessionId === sessionId) this.remove(t.id);
    }
  }
}
