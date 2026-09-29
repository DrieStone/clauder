import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { TagDef } from '@clauder/shared';

const TAGS_FILE = path.join(os.homedir(), '.clauder', 'tags.json');

type BroadcastFn = (tags: TagDef[]) => void;

/** The registry of user-defined session tags (label + color), persisted to
 *  `~/.clauder/tags.json`. Mirrors TriggerManager's shape: an in-memory Map, atomic
 *  temp+rename writes, and a broadcast callback fired (with the full snapshot) after every
 *  mutation. The registry is small, so we broadcast the whole thing rather than per-item events.
 *  Sessions reference tags by id (SessionConfig.tags); cascading a delete out of sessions is the
 *  caller's job (see index.ts wiring). */
export class TagManager {
  private tags = new Map<string, TagDef>();
  private broadcastFn: BroadcastFn;

  constructor(broadcastFn: BroadcastFn = () => {}) {
    this.broadcastFn = broadcastFn;
  }

  load(): void {
    try {
      if (!fs.existsSync(TAGS_FILE)) return;
      const data = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf-8'));
      if (!Array.isArray(data)) return;
      for (const t of data) {
        if (t && typeof t.id === 'string') this.tags.set(t.id, t);
      }
      console.log(`[TagManager] Loaded ${this.tags.size} tag(s) from disk`);
    } catch (err) {
      console.error('[TagManager] Failed to load:', err);
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(TAGS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Atomic write: temp sibling + rename, so a crash mid-write can't truncate tags.json.
      const tmp = `${TAGS_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.tags.values()], null, 2));
      fs.renameSync(tmp, TAGS_FILE);
    } catch (err) {
      console.error('[TagManager] Failed to save:', err);
    }
  }

  list(): TagDef[] {
    return [...this.tags.values()];
  }

  has(id: string): boolean {
    return this.tags.has(id);
  }

  create(input: { label: string; color: string }): TagDef {
    const label = input.label.trim().slice(0, 40) || 'Tag';
    const tag: TagDef = { id: uuid(), label, color: input.color };
    this.tags.set(tag.id, tag);
    this.save();
    this.broadcastFn(this.list());
    return tag;
  }

  update(id: string, patch: { label?: string; color?: string }): TagDef | null {
    const existing = this.tags.get(id);
    if (!existing) return null;
    const next: TagDef = {
      ...existing,
      ...(patch.label !== undefined ? { label: patch.label.trim().slice(0, 40) || existing.label } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
    };
    this.tags.set(id, next);
    this.save();
    this.broadcastFn(this.list());
    return next;
  }

  /** Remove a tag from the registry. Returns true if it existed. Caller must strip the id from
   *  any sessions that carry it. */
  delete(id: string): boolean {
    const existed = this.tags.delete(id);
    if (existed) {
      this.save();
      this.broadcastFn(this.list());
    }
    return existed;
  }
}
