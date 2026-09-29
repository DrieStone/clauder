import { mkdir, writeFile, readdir, stat, unlink } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import type { ImageAttachment } from '@clauder/shared';

export const UPLOADS_DIR = join(homedir(), '.clauder', 'uploads');

const MIME_TO_EXT: Record<string, string> = {
  'image/png':  'png',
  'image/jpeg': 'jpg',
  'image/jpg':  'jpg',
  'image/gif':  'gif',
  'image/webp': 'webp',
};

export async function ensureUploadsDir(): Promise<void> {
  await mkdir(UPLOADS_DIR, { recursive: true });
}

export async function saveUpload(img: ImageAttachment): Promise<string> {
  await ensureUploadsDir();
  const ext = MIME_TO_EXT[img.mimeType] ?? 'png';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `${ts}-${rand}.${ext}`;
  const filePath = join(UPLOADS_DIR, filename);
  await writeFile(filePath, Buffer.from(img.data, 'base64'));
  return filePath;
}

/** Save an arbitrary uploaded file (base64) to the uploads dir, preserving its original
 *  basename + extension (sanitized) so Claude sees a sensible path like
 *  `.../2026-...-ab12-Podcast_Guest_Ladder.xls` and can open it with the right tool. Used for
 *  'binary' attachments (XLS, docx, zip, …) that have no API content block — the path is the
 *  only way Claude reads them. */
export async function saveFileUpload(name: string, base64: string): Promise<string> {
  await ensureUploadsDir();
  // Strip any directory components and neutralize anything but a safe filename charset,
  // so a crafted "name" can't escape the uploads dir or inject path separators.
  const safeBase = (name.split(/[/\\]/).pop() || 'file').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'file';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 8);
  const filePath = join(UPLOADS_DIR, `${ts}-${rand}-${safeBase}`);
  await writeFile(filePath, Buffer.from(base64, 'base64'));
  return filePath;
}

export async function purgeOldUploads(maxAgeDays = 7): Promise<void> {
  await ensureUploadsDir();
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await readdir(UPLOADS_DIR);
  } catch {
    return;
  }
  let purged = 0;
  for (const name of entries) {
    const p = join(UPLOADS_DIR, name);
    try {
      const s = await stat(p);
      if (s.mtimeMs < cutoff) {
        await unlink(p);
        purged++;
      }
    } catch { /* skip */ }
  }
  if (purged > 0) console.log(`[uploads] Purged ${purged} old upload(s) from ${UPLOADS_DIR}`);
}
