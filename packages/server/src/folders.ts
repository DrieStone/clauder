import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { SessionFolder } from '@clauder/shared';

const FOLDERS_FILE = path.join(os.homedir(), '.clauder', 'folders.json');
const MAX_NAME = 60;
const MAX_MEMBERS = 1000;

/** Dashboard folders: named groups of sessions, only for tidying the dashboard (a folder never
 *  touches a session's files or settings). Persisted to `~/.clauder/folders.json` TagManager-style:
 *  an in-memory Map, atomic temp+rename writes, and the full (small) list broadcast after every
 *  change. Membership lives here rather than on SessionConfig, so sessions.json is untouched.
 *  A session sits in at most one folder: putting it in one takes it out of any other. Sessions
 *  that no longer exist drop out of the list, and a destroyed session is pruned for good. */
export class FolderManager {
  private folders = new Map<string, SessionFolder>();

  constructor(
    private broadcastFn: (folders: SessionFolder[]) => void,
    /** Whether a session can go in a folder: it exists and isn't Scratch. */
    private canHold: (sessionId: string) => boolean,
  ) {}

  load(): void {
    try {
      if (!fs.existsSync(FOLDERS_FILE)) return;
      const data = JSON.parse(fs.readFileSync(FOLDERS_FILE, 'utf-8'));
      if (!Array.isArray(data)) return;
      for (const f of data) {
        if (f && typeof f.id === 'string' && typeof f.name === 'string' && Array.isArray(f.sessionIds)) {
          this.folders.set(f.id, { id: f.id, name: f.name, sessionIds: f.sessionIds.filter((id: unknown) => typeof id === 'string') });
        }
      }
      console.log(`[FolderManager] Loaded ${this.folders.size} folder(s) from disk`);
    } catch (err) {
      console.error('[FolderManager] Failed to load:', err);
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(FOLDERS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Atomic write: temp sibling + rename, so a crash mid-write can't truncate folders.json.
      // Saves every member, not just the live ones list() shows, so nothing is lost to timing.
      const tmp = `${FOLDERS_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.folders.values()], null, 2));
      fs.renameSync(tmp, FOLDERS_FILE);
    } catch (err) {
      console.error('[FolderManager] Failed to save:', err);
    }
  }

  private changed(): void {
    this.save();
    this.broadcastFn(this.list());
  }

  /** Folders as clients see them: only sessions that exist. */
  list(): SessionFolder[] {
    return [...this.folders.values()].map(f => ({ ...f, sessionIds: f.sessionIds.filter(id => this.canHold(id)) }));
  }

  private cleanName(name: unknown, fallback: string): string {
    return (typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '') || fallback;
  }

  private cleanIds(ids: unknown): string[] {
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids.filter((id): id is string => typeof id === 'string' && this.canHold(id)))].slice(0, MAX_MEMBERS);
  }

  /** Take these sessions out of every folder but `keep`. */
  private takeOut(ids: string[], keep: string | null): void {
    if (!ids.length) return;
    const drop = new Set(ids);
    for (const f of this.folders.values()) {
      if (f.id !== keep && f.sessionIds.some(id => drop.has(id))) f.sessionIds = f.sessionIds.filter(id => !drop.has(id));
    }
  }

  create(input: { name: unknown; sessionIds?: unknown }): SessionFolder {
    const folder: SessionFolder = { id: uuid(), name: this.cleanName(input.name, 'Folder'), sessionIds: this.cleanIds(input.sessionIds) };
    this.takeOut(folder.sessionIds, null);
    this.folders.set(folder.id, folder);
    this.changed();
    return folder;
  }

  /** Rename a folder and/or replace its sessions. Sessions left out go back to the main list. */
  update(id: string, patch: { name?: unknown; sessionIds?: unknown }): SessionFolder | null {
    const folder = this.folders.get(id);
    if (!folder) return null;
    if (patch.name !== undefined) folder.name = this.cleanName(patch.name, folder.name);
    if (patch.sessionIds !== undefined) {
      folder.sessionIds = this.cleanIds(patch.sessionIds);
      this.takeOut(folder.sessionIds, id);
    }
    this.changed();
    return folder;
  }

  /** Delete a folder. Its sessions aren't touched; they go back to the main list. */
  delete(id: string): boolean {
    if (!this.folders.delete(id)) return false;
    this.changed();
    return true;
  }

  /** Put a session in a folder, or take it out of whichever it's in (folderId null). */
  move(sessionId: string, folderId: string | null): void {
    if (!this.canHold(sessionId)) return;
    const target = folderId ? this.folders.get(folderId) : null;
    if (folderId && !target) return;
    this.takeOut([sessionId], null);
    if (target) target.sessionIds.push(sessionId);
    this.changed();
  }

  /** A destroyed session leaves its folder for good. */
  removeSession(sessionId: string): void {
    if (![...this.folders.values()].some(f => f.sessionIds.includes(sessionId))) return;
    this.takeOut([sessionId], null);
    this.changed();
  }
}
