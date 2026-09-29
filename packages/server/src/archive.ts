import { existsSync, realpathSync, writeFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { stat, rename, rm } from 'fs/promises';
import { join, dirname, basename, sep } from 'path';
import { homedir, tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { SessionConfig, UIMessage } from '@clauder/shared';

const execFileP = promisify(execFile);

/**
 * archive.ts — the destructive core of the "Archive Project" feature. Owns everything that
 * touches the filesystem irreversibly. See docs/archive-project-plan.md.
 *
 * THE SAFETY INVARIANT: the project directory is moved to the Trash ONLY after the zip has
 * been created AND verified. Any failure before that point aborts with the directory
 * completely untouched. Order: validate → summarize → write manifest → zip → verify → trash.
 *
 * Removal is always a move to Trash via Finder/osascript — never rm -rf.
 */

export type ArchiveStage = 'summarizing' | 'zipping' | 'verifying' | 'trashing' | 'done' | 'error';

/** The minimal surface archive.ts needs from a session. ManagedSession satisfies this
 *  structurally (generateArchiveSummary is added in Phase 3); typing against the interface
 *  keeps this module's build decoupled from the concrete class. */
export interface ArchivableSession {
  config: SessionConfig;
  messages: UIMessage[];
  notes: string | null;
  summary: string | null;
  createdAt: string;
  lastActiveAt: string;
  totalCostUsd: number;
  generateArchiveSummary(): Promise<string>;
}

const ARCHIVE_DIR = join(homedir(), 'Documents', 'Clauder Archive');

/** Absolute path of the Clauder repo root (the dir with the top-level package.json named
 *  "clauder"), so we can refuse to archive Clauder itself. Null if not found. */
const CLAUDER_REPO_ROOT: string | null = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf-8')).name === 'clauder') return dir;
      } catch { /* not it — keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
})();

/**
 * Throw a descriptive Error (surfaced to the UI) if `cwd` is unsafe to move to Trash.
 * Only ever called for a directory that EXISTS — a non-existent cwd is handled as a
 * manifest-only archive by the caller (nothing gets trashed). Returns the resolved,
 * symlink-free real path — the guards check the real target, not a symlink alias, and the
 * caller trashes that exact resolved path.
 */
export function assertSafeToArchive(cwd: string, otherResolvedCwds: string[]): string {
  let resolved: string;
  try {
    resolved = realpathSync(cwd);
  } catch {
    throw new Error(`Cannot resolve project directory: ${cwd}`);
  }

  const home = homedir();

  if (resolved === home) throw new Error('Refusing to archive your home directory.');
  if (resolved === '/') throw new Error('Refusing to archive the filesystem root.');

  // Must be strictly nested under home — only archive things inside the user's home.
  if (!resolved.startsWith(home + sep)) {
    throw new Error(`Refusing to archive a path outside your home directory: ${resolved}`);
  }

  // Absolute system roots (belt-and-suspenders; the home check already excludes most).
  const SYSTEM_PREFIXES = ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/Applications', '/opt', '/tmp', '/cores', '/Volumes'];
  for (const p of SYSTEM_PREFIXES) {
    if (resolved === p || resolved.startsWith(p + sep)) {
      throw new Error(`Refusing to archive a system path: ${resolved}`);
    }
  }

  // ~/Library holds app data/preferences — never a project to archive.
  const homeLibrary = join(home, 'Library');
  if (resolved === homeLibrary || resolved.startsWith(homeLibrary + sep)) {
    throw new Error('Refusing to archive anything under ~/Library.');
  }

  // Too shallow: require at least 2 segments below home (e.g. ~/dev/foo ok; ~/foo reject).
  // Prevents trashing ~/Documents, ~/Desktop, ~/dev, etc.
  const depth = resolved.slice(home.length + 1).split(sep).filter(Boolean).length;
  if (depth < 2) {
    throw new Error(`Refusing to archive a top-level directory (too shallow): ${resolved}. Nest the project at least two levels under home.`);
  }

  // Not the Clauder repo itself, nor an ancestor of it.
  if (CLAUDER_REPO_ROOT) {
    let repo: string;
    try { repo = realpathSync(CLAUDER_REPO_ROOT); } catch { repo = CLAUDER_REPO_ROOT; }
    if (resolved === repo || repo.startsWith(resolved + sep)) {
      throw new Error('Refusing to archive the Clauder repository itself.');
    }
  }

  // Not the archive dir, nor an ancestor/descendant of it. (ARCHIVE_DIR may not exist yet, so
  // compare strings — don't realpath it.)
  if (resolved === ARCHIVE_DIR || ARCHIVE_DIR.startsWith(resolved + sep) || resolved.startsWith(ARCHIVE_DIR + sep)) {
    throw new Error('Refusing to archive the Clauder Archive directory.');
  }

  // Quotes/newlines would be pathological for the osascript path handling. Defense in depth
  // (the path is passed as an argv item, never string-interpolated, but reject anyway).
  if (/["\n\r]/.test(resolved)) {
    throw new Error(`Refusing to archive a path containing quotes or newlines: ${resolved}`);
  }

  // In use by another active session — don't trash a directory something else is working in.
  if (otherResolvedCwds.includes(resolved)) {
    throw new Error(`Refusing to archive — another active session is using this directory: ${resolved}`);
  }

  return resolved;
}

function pad(n: number): string { return String(n).padStart(2, '0'); }

function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

/** Build the ARCHIVE.md manifest — the only surviving record of the conversation once the
 *  session is destroyed, so the transcript is NOT trimmed here. */
function buildManifest(session: ArchivableSession, wrapup: string, archivedAt: string): string {
  const cfg = session.config;
  const L: string[] = [];
  L.push(`# Archive: ${cfg.name}`, '');
  L.push('| Field | Value |', '|---|---|');
  L.push(`| Working directory | ${cfg.cwd} |`);
  L.push(`| Created | ${session.createdAt} |`);
  L.push(`| Last active | ${session.lastActiveAt} |`);
  L.push(`| Model | ${cfg.model ?? '(default)'}${cfg.effort ? ' / ' + cfg.effort : ''} |`);
  L.push(`| Total cost (USD) | $${session.totalCostUsd.toFixed(4)} |`);
  L.push(`| Messages | ${session.messages.length} |`);
  L.push(`| Archived at | ${archivedAt} |`);
  L.push('', '## Wrap-up', '', wrapup || '(none)');
  if (session.notes) L.push('', '## Notes', '', session.notes);
  if (session.summary) L.push('', '## Summary', '', session.summary);
  L.push('', '## Full transcript', '');
  for (const m of session.messages) {
    const ts = m.timestamp ? ` — ${m.timestamp}` : '';
    L.push(`### ${m.role}${ts}`, '');
    if (m.content) L.push(m.content);
    if (m.toolUses?.length) {
      for (const tu of m.toolUses) {
        const inp = JSON.stringify(tu.input ?? {});
        L.push(`- 🔧 **${tu.name}**: ${inp.length > 200 ? inp.slice(0, 200) + '…' : inp}`);
      }
    }
    L.push('');
  }
  return L.join('\n');
}

/** Move a path to the macOS Trash. Tries Finder first (gives a proper "Put Back") but falls
 *  back to a direct filesystem move into ~/.Trash when Finder automation isn't permitted — a
 *  launchd-managed process frequently lacks the TCC Automation grant to command Finder's
 *  `delete` (verified during Phase 6 of docs/archive-project-plan.md, where osascript could
 *  QUERY Finder but not `delete`). Either way the item lands in the Trash, recoverable, and
 *  never a hard delete. The path is passed to osascript as an argv ITEM (not interpolated into
 *  the AppleScript source) so quoting/injection can't happen; the caller's guard also rejects
 *  quotes/newlines. The project dir is always under home (guarded), i.e. the same volume as
 *  ~/.Trash, so the rename fallback can't hit EXDEV. */
async function moveToTrash(absPath: string): Promise<void> {
  try {
    await execFileP('osascript', [
      '-e', 'on run argv',
      '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
      '-e', 'end run',
      absPath,
    ], { timeout: 60_000 });
    return;
  } catch {
    // Finder unavailable/unpermitted — fall through to a filesystem move.
  }

  const trashDir = join(homedir(), '.Trash');
  mkdirSync(trashDir, { recursive: true });
  const base = basename(absPath);
  let dest = join(trashDir, base);
  let n = 1;
  while (existsSync(dest)) dest = join(trashDir, `${base} ${n++}`);
  await rename(absPath, dest);
}

/**
 * Archive a session: AI wrap-up → manifest → zip → verify → (only now) move the project dir
 * to Trash. Returns the final zip path. Does NOT destroy the session — the caller does that.
 *
 * @param session       the session to archive (structurally an ArchivableSession)
 * @param otherSessions every OTHER active session (their cwds guard against archiving an
 *                       in-use directory)
 * @param onStage        progress callback (stage, human message)
 */
export async function archiveSession(
  session: ArchivableSession,
  otherSessions: ReadonlyArray<{ config: { cwd: string } }>,
  onStage: (stage: ArchiveStage, message: string) => void,
): Promise<{ zipPath: string }> {
  const cfg = session.config;

  if (cfg.isScratch) throw new Error('The scratch session cannot be archived.');

  const dirExists = existsSync(cfg.cwd);

  // Resolve the other sessions' cwds (best-effort) for the in-use guard.
  const otherResolved = otherSessions.map(s => {
    try { return realpathSync(s.config.cwd); } catch { return s.config.cwd; }
  });

  // Path safety — only meaningful (and only enforced) when there's a real directory to trash.
  let resolvedCwd: string | null = null;
  if (dirExists) {
    resolvedCwd = assertSafeToArchive(cfg.cwd, otherResolved);
  }

  // 1. AI wrap-up (best-effort — never blocks the archive).
  onStage('summarizing', 'Writing project wrap-up…');
  let wrapup = '';
  try { wrapup = await session.generateArchiveSummary(); } catch { /* fall through to fallback */ }
  if (!wrapup || !wrapup.trim()) wrapup = 'Wrap-up unavailable; see transcript below.';

  const archivedAt = new Date().toISOString();
  const manifest = buildManifest(session, wrapup, archivedAt);

  // 2. Stage the content to zip. If the dir exists, drop the manifest into it (it's headed to
  //    Trash anyway). If not, zip a manifest-only holder dir from a temp location.
  let zipSourceDir: string;
  let tempHolder: string | null = null;
  if (dirExists && resolvedCwd) {
    writeFileSync(join(resolvedCwd, 'CLAUDER-ARCHIVE.md'), manifest);
    zipSourceDir = resolvedCwd;
  } else {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'clauder-archive-'));
    const holder = join(tmpRoot, safeName(basename(cfg.cwd) || cfg.name));
    mkdirSync(holder);
    writeFileSync(join(holder, 'CLAUDER-ARCHIVE.md'), manifest);
    zipSourceDir = holder;
    tempHolder = tmpRoot;
  }

  // 3. Zip → temp path.
  mkdirSync(ARCHIVE_DIR, { recursive: true });
  const finalZip = join(ARCHIVE_DIR, `${safeName(cfg.name)}-${timestamp()}.zip`);
  const tmpZip = `${finalZip}.tmp.zip`;

  try {
    onStage('zipping', 'Zipping project…');
    // ditto --keepParent → the archive contains the project folder as its top-level entry.
    await execFileP('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', zipSourceDir, tmpZip], {
      timeout: 10 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });

    // 4. VERIFY before anything destructive: non-trivial size + integrity check.
    onStage('verifying', 'Verifying archive…');
    const st = await stat(tmpZip);
    if (st.size < 100) throw new Error('Archive verification failed: the zip is suspiciously small.');
    try {
      await execFileP('unzip', ['-t', tmpZip], { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    } catch {
      throw new Error('Archive verification failed: the zip did not pass an integrity check.');
    }

    // 5. Atomically promote temp → final (mirrors persistence.ts's write ethos).
    await rename(tmpZip, finalZip);
  } catch (err) {
    // Anything failed at/ before verify → clean up the temp zip and abort. The project
    // directory has NOT been touched (beyond a stray CLAUDER-ARCHIVE.md if it existed).
    await rm(tmpZip, { force: true }).catch(() => {});
    if (tempHolder) rmSync(tempHolder, { recursive: true, force: true });
    throw err;
  }

  // 6. Zip is verified and in place — NOW it is safe to remove the source.
  if (dirExists && resolvedCwd) {
    onStage('trashing', 'Moving project to Trash…');
    await moveToTrash(resolvedCwd);
  }

  if (tempHolder) rmSync(tempHolder, { recursive: true, force: true });

  onStage('done', `Archived to ${finalZip}`);
  return { zipPath: finalZip };
}
