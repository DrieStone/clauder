import fs from 'fs';
import path from 'path';
import os from 'os';
import type { ProjectRun } from '@clauder/shared';

const CLAUDER_DIR = path.join(os.homedir(), '.clauder');
const RUNS_FILE = path.join(CLAUDER_DIR, 'project-runs.json');
const RUNS_BAK = `${RUNS_FILE}.bak`;

/** Atomic write: temp sibling + rename, so a crash can't truncate the runs file.
 *  Mirrors persistence.ts atomicWrite. */
function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function tryRead(file: string): ProjectRun[] | null {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveRuns(runs: ProjectRun[]): void {
  if (!fs.existsSync(CLAUDER_DIR)) fs.mkdirSync(CLAUDER_DIR, { recursive: true });
  // Roll the current good file to .bak before overwriting (near-current recovery source).
  try {
    if (fs.existsSync(RUNS_FILE)) fs.copyFileSync(RUNS_FILE, RUNS_BAK);
  } catch (err) {
    console.error('[ProjectRuns] Failed to roll .bak:', err);
  }
  atomicWrite(RUNS_FILE, JSON.stringify(runs, null, 2));
}

export function loadRuns(): ProjectRun[] {
  if (!fs.existsSync(RUNS_FILE)) return [];
  const parsed = tryRead(RUNS_FILE);
  if (parsed) return parsed;
  // Corrupt main file — recover from .bak rather than silently losing run history.
  console.error('[ProjectRuns] project-runs.json unparseable — trying .bak');
  const fromBak = tryRead(RUNS_BAK);
  if (fromBak) {
    console.error(`[ProjectRuns] Recovered ${fromBak.length} run(s) from .bak`);
    return fromBak;
  }
  console.error('[ProjectRuns] No usable backup — starting with empty run list');
  return [];
}
