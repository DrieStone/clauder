import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import type { Skill } from '@clauder/shared';

/** Built-in slash commands shipped with the Claude CLI. Hardcoded — the binary doesn't expose a listing API. */
export const BUILTIN_SKILLS: Skill[] = [
  { name: 'init',                    description: 'Initialize a CLAUDE.md file with codebase documentation',  source: 'builtin' },
  { name: 'simplify',                description: 'Review changed code for reuse, quality, and efficiency',   source: 'builtin' },
  { name: 'review',                  description: 'Review a pull request',                                    source: 'builtin' },
  { name: 'security-review',         description: 'Complete a security review of the pending changes',        source: 'builtin' },
  { name: 'loop',                    description: 'Run a prompt or slash command on a recurring interval',    source: 'builtin' },
  { name: 'schedule',                description: 'Create, update, list, or run scheduled remote agents',     source: 'builtin' },
  { name: 'claude-api',              description: 'Build, debug, and optimize Claude API / Anthropic SDK apps', source: 'builtin' },
  { name: 'fewer-permission-prompts', description: 'Add common read-only tool calls to allowlist',             source: 'builtin' },
  { name: 'update-config',           description: 'Configure the Claude Code harness via settings.json',      source: 'builtin' },
  { name: 'keybindings-help',        description: 'Customize keyboard shortcuts in ~/.claude/keybindings.json', source: 'builtin' },
];

/** Scan <cwd>/.claude/commands/ for project-level skill files. Returns [] if dir missing or unreadable. */
export function discoverProjectSkills(cwd: string): Skill[] {
  const dir = join(cwd, '.claude', 'commands');
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir);
    const out: Skill[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const full = join(dir, entry);
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      const name = entry.slice(0, -3); // strip .md
      let description = '';
      try {
        const head = readFileSync(full, 'utf8').split('\n', 1)[0] ?? '';
        description = head.replace(/^#+\s*/, '').trim().slice(0, 200);
      } catch {
        // unreadable file — keep empty description
      }
      out.push({ name, description, source: 'project' });
    }
    return out;
  } catch {
    return [];
  }
}

/** Combined skill list for a session's CWD. Project skills shadow built-ins on name collision. */
export function getSkillsForCwd(cwd: string): Skill[] {
  const project = discoverProjectSkills(cwd);
  const projectNames = new Set(project.map(s => s.name));
  const builtins = BUILTIN_SKILLS.filter(s => !projectNames.has(s.name));
  return [...project, ...builtins].sort((a, b) => a.name.localeCompare(b.name));
}
