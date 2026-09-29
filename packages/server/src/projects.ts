import fs from 'fs';
import os from 'os';
import path from 'path';
import { projectFolderProblem } from '@clauder/shared';

/** Where the new-session form's "New project" option creates folders. Every dev project already
 *  lives here, so a new one needs only a name. Override with CLAUDER_DEV_ROOT. */
export const DEV_ROOT = path.resolve(process.env.CLAUDER_DEV_ROOT || path.join(os.homedir(), 'development'));

/** DEV_ROOT the way the form shows it: "~/development". */
export function devRootForDisplay(): string {
  const home = os.homedir();
  return DEV_ROOT === home || DEV_ROOT.startsWith(home + path.sep) ? '~' + DEV_ROOT.slice(home.length) : DEV_ROOT;
}

/** The folders already in the dev root, so the form can say when a name would reuse one. */
export function listProjectFolders(): string[] {
  try {
    return fs.readdirSync(DEV_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** The dev-root path for a project folder name, creating the folder if it's new. An existing
 *  folder of that name is reused rather than refused — the form has already said so. */
export function ensureProjectFolder(name: string): { path: string; created: boolean } {
  const problem = projectFolderProblem(name);
  if (problem) throw new Error(problem);
  if (!fs.existsSync(DEV_ROOT)) throw new Error(`The dev folder ${DEV_ROOT} doesn't exist.`);
  const target = path.resolve(DEV_ROOT, name.trim());
  // The name rules already forbid separators; this backstop keeps it exactly one level deep.
  if (path.dirname(target) !== DEV_ROOT) throw new Error('A project folder must sit directly in the dev folder.');
  try {
    fs.mkdirSync(target); // not recursive: exactly one new folder
    return { path: target, created: true };
  } catch (err: any) {
    if (err?.code !== 'EEXIST') throw err;
    if (!fs.statSync(target).isDirectory()) throw new Error(`${target} already exists and isn't a folder.`);
    // The disk is case-insensitive, so "strategicconquest" found "StrategicConquest" — report the
    // folder as it's really spelled, so the session's cwd matches what Finder shows.
    const want = path.basename(target).toLowerCase();
    const actual = fs.readdirSync(DEV_ROOT).find(n => n.toLowerCase() === want) ?? path.basename(target);
    return { path: path.join(DEV_ROOT, actual), created: false };
  }
}
