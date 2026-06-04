import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const SECTION_HEADER = '## Discovered during sessions';
const CANDIDATE_RE = /\[CLAUDE\.md candidate:\s*([^\]]+)\]/g;

/** Pull every `[CLAUDE.md candidate: ...]` rule out of a block of assistant text. */
export function extractClaudeMdCandidates(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(CANDIDATE_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const c = m[1].trim();
    if (c) out.push(c);
  }
  return out;
}

/** Normalize a bullet/line for dedup comparison: strip leading "- ", trim, lowercase. */
function normalize(line: string): string {
  return line.replace(/^\s*[-*]\s*/, '').trim().toLowerCase();
}

/**
 * Append a candidate rule to <cwd>/CLAUDE.md under the "Discovered during sessions" section.
 * Dedupes against existing lines (case-insensitive, ignoring the bullet marker) so repeated
 * candidates — the cause of the duplicate entries we've seen — don't pile up.
 * Returns true if it wrote, false if skipped (duplicate, empty, or too long).
 */
export function applyClaudeMdCandidate(cwd: string, candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed || trimmed.length > 500) return false;

  const path = join(cwd, 'CLAUDE.md');
  let existing = existsSync(path) ? readFileSync(path, 'utf8') : '';

  // Dedup: skip if this exact rule is already present anywhere in the file.
  const target = normalize(trimmed);
  if (existing.split('\n').some(line => normalize(line) === target)) return false;

  if (!existing.includes(SECTION_HEADER)) {
    existing = existing.trimEnd() + (existing ? '\n\n' : '') + SECTION_HEADER + '\n';
  }
  existing = existing.trimEnd() + `\n- ${trimmed}\n`;
  writeFileSync(path, existing, 'utf8');
  return true;
}
