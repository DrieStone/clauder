import fs from 'fs';
import path from 'path';
import os from 'os';
import type { UiState } from '@clauder/shared';

const UI_STATE_FILE = path.join(os.homedir(), '.clauder', 'ui-state.json');
// A read lands on every bit of activity you watch, so disk writes are batched. Broadcasts are not.
const SAVE_DELAY_MS = 1000;
const MAX_ENTRIES = 1000;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uniqueIds = (ids: unknown[]): string[] =>
  [...new Set(ids.filter((id): id is string => typeof id === 'string'))].slice(0, MAX_ENTRIES);

/** View state that follows Jonathan between devices: when each session was last read, which tabs he
 *  closed, and the order of his pinned tabs. TagManager's shape — in-memory state, atomic temp+rename
 *  writes to `~/.clauder/ui-state.json`, and the full (small) snapshot broadcast after every change.
 *  Times come from the server's clock, so they compare cleanly with each session's lastActiveAt no
 *  matter how far off a phone's clock is. Sessions that no longer exist drop out of snapshots. */
export class UiStateManager {
  private state: UiState = { readAt: {}, closedTabs: {}, pinOrder: [] };
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private broadcastFn: (state: UiState) => void,
    private sessionExists: (id: string) => boolean,
  ) {}

  load(): void {
    try {
      if (!fs.existsSync(UI_STATE_FILE)) return;
      this.merge(JSON.parse(fs.readFileSync(UI_STATE_FILE, 'utf-8')), false);
      console.log(`[UiState] Loaded read status for ${Object.keys(this.state.readAt).length} session(s)`);
    } catch (err) {
      console.error('[UiState] Failed to load:', err);
    }
  }

  snapshot(): UiState {
    const live = <T>(r: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(r).filter(([id]) => this.sessionExists(id)));
    return {
      readAt: live(this.state.readAt),
      closedTabs: live(this.state.closedTabs),
      pinOrder: this.state.pinOrder.filter(id => this.sessionExists(id)),
    };
  }

  markRead(sessionId: string): void {
    this.state.readAt[sessionId] = new Date().toISOString();
    this.changed();
  }

  setTabClosed(sessionId: string, closed: boolean): void {
    if (closed) this.state.closedTabs[sessionId] = Date.now();
    else if (sessionId in this.state.closedTabs) delete this.state.closedTabs[sessionId];
    else return;
    this.changed();
  }

  setPinOrder(ids: unknown[]): void {
    this.state.pinOrder = uniqueIds(ids);
    this.changed();
  }

  /** Fold in what a device tracked on its own before syncing (sent once per device), or the file on
   *  load. Read and close times keep the later of the two — read anywhere counts as read — and a pin
   *  order is adopted only if there isn't one yet. Anything malformed is ignored. */
  merge(input: unknown, notify = true): void {
    if (!isRecord(input)) return;
    const keepLater = <T>(target: Record<string, T>, src: unknown, valid: (v: unknown) => v is T, when: (v: T) => number) => {
      if (!isRecord(src)) return;
      for (const [id, v] of Object.entries(src).slice(0, MAX_ENTRIES)) {
        if (valid(v) && (target[id] === undefined || when(v) > when(target[id]))) target[id] = v;
      }
    };
    keepLater(this.state.readAt, input.readAt, (v): v is string => typeof v === 'string' && !isNaN(Date.parse(v)), Date.parse);
    keepLater(this.state.closedTabs, input.closedTabs, (v): v is number => typeof v === 'number' && isFinite(v), v => v);
    if (!this.state.pinOrder.length && Array.isArray(input.pinOrder)) this.state.pinOrder = uniqueIds(input.pinOrder);
    if (notify) this.changed();
  }

  /** Write a pending change now — the shutdown path. */
  flush(): void {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  private changed(): void {
    this.broadcastFn(this.snapshot());
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save(); }, SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  private save(): void {
    try {
      const dir = path.dirname(UI_STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Atomic write: temp sibling + rename, so a crash mid-write can't truncate ui-state.json.
      const tmp = `${UI_STATE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2));
      fs.renameSync(tmp, UI_STATE_FILE);
    } catch (err) {
      console.error('[UiState] Failed to save:', err);
    }
  }
}
