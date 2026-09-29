import { execFile, spawn } from 'child_process';
import { homedir } from 'os';
import { dirname, basename, sep } from 'path';
import type { SessionState, UIMessage, SearchScope, SessionHit, FileHit, SearchResponse } from '@clauder/shared';
import { CLAUDE_CLI_PATH } from './session.js';
import { runClaudeOneShot } from './claude-oneshot.js';

const SNIPPET_RADIUS = 80;
const RECENT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — matches the "recent" bonus window

// Paths never worth surfacing from a whole-disk Spotlight search.
const EXCLUDED_PATH_SEGMENTS = ['/Library/', '/node_modules/', '/.git/', '/.Trash/', '/.npm/', '/.cache/'];

function isExcludedPath(p: string): boolean {
  return EXCLUDED_PATH_SEGMENTS.some(seg => p.includes(seg));
}

/** Lowercase search terms. Quoted phrases ("like this") are kept whole; everything else is
 *  split on whitespace, with terms under 2 chars dropped as too noisy to match on. */
export function tokenize(q: string): string[] {
  const terms: string[] = [];
  const phraseRe = /"([^"]+)"/g;
  let rest = q;
  let m: RegExpExecArray | null;
  while ((m = phraseRe.exec(q)) !== null) {
    const phrase = m[1].trim().toLowerCase();
    if (phrase.length >= 2) terms.push(phrase);
    rest = rest.replace(m[0], ' ');
  }
  for (const w of rest.toLowerCase().split(/\s+/)) {
    if (w.length >= 2) terms.push(w);
  }
  return terms;
}

function snippetAround(text: string, term: string): string {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return text.slice(0, SNIPPET_RADIUS * 2).trim();
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + term.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).trim() + suffix;
}

function countMatches(haystack: string, terms: string[]): { any: number; all: boolean } {
  const lower = haystack.toLowerCase();
  let any = 0;
  for (const t of terms) if (lower.includes(t)) any++;
  return { any, all: any === terms.length };
}

/** In-memory scan of every session's name, cwd, summary, notes, and messages. Synchronous —
 *  40 sessions / ~1,900 messages resolves in well under a millisecond. */
export function searchSessions(states: SessionState[], terms: string[], limit = 30): SessionHit[] {
  if (terms.length === 0) return [];
  const now = Date.now();
  const hits: SessionHit[] = [];

  for (const s of states) {
    let score = 0;
    const nameMatch = countMatches(s.config.name ?? '', terms);
    score += nameMatch.any * 5 + (nameMatch.all ? 5 : 0);
    if (s.summary) {
      const m = countMatches(s.summary, terms);
      score += m.any * 3 + (m.all ? 3 : 0);
    }
    if (s.notes) {
      const m = countMatches(s.notes, terms);
      score += m.any * 3 + (m.all ? 3 : 0);
    }

    // Find the best-matching individual message (skip tool/system chatter).
    let bestMsg: UIMessage | null = null;
    let bestMsgScore = 0;
    for (const msg of s.messages) {
      if (msg.role === 'system' || !msg.content) continue;
      const m = countMatches(msg.content, terms);
      if (m.any === 0) continue;
      const msgScore = m.any * 1 + (m.all ? 2 : 0);
      score += msgScore;
      if (msgScore > bestMsgScore) {
        bestMsgScore = msgScore;
        bestMsg = msg;
      }
    }

    if (score === 0) continue;

    const lastActive = new Date(s.lastActiveAt).getTime();
    if (!isNaN(lastActive) && now - lastActive < RECENT_MS) score *= 1.5;

    const snippet = bestMsg
      ? snippetAround(bestMsg.content, terms[0])
      : (s.summary ? snippetAround(s.summary, terms[0]) : s.config.cwd);

    hits.push({
      kind: 'session',
      sessionId: s.id,
      sessionName: s.config.name,
      messageId: bestMsg?.id,
      role: bestMsg?.role,
      snippet,
      timestamp: bestMsg?.timestamp ?? s.lastActiveAt,
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

function sessionForPath(states: SessionState[], p: string): string | undefined {
  for (const s of states) {
    const cwd = s.config.cwd;
    if (cwd && (p === cwd || p.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep))) return s.id;
  }
  return undefined;
}

/** Whole-file-content search via Spotlight (already indexing the disk). `dirs === null` means
 *  search everywhere; otherwise restrict with -onlyin per directory. 5s kill — mdfind can hang
 *  on an unusual query, and this must never block the request. */
export function spotlightSearch(q: string, dirs: string[] | null, states: SessionState[], limit = 60): Promise<FileHit[]> {
  return new Promise((resolve) => {
    const args: string[] = [];
    if (dirs) for (const d of dirs) args.push('-onlyin', d);
    args.push(q);

    const child = execFile('/usr/bin/mdfind', args, { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve([]); return; }
      const home = homedir();
      const seen = new Set<string>();
      const hits: FileHit[] = [];
      const qLower = q.toLowerCase();
      for (const line of stdout.split('\n')) {
        const p = line.trim();
        if (!p || seen.has(p) || isExcludedPath(p)) continue;
        seen.add(p);
        const name = basename(p);
        const nameMatches = name.toLowerCase().includes(qLower);
        hits.push({
          kind: 'file',
          path: p,
          name,
          dir: dirname(p),
          source: 'spotlight',
          sessionId: sessionForPath(states, p),
          // Name matches rank above content-only matches; results under $HOME rank above
          // anything outside it (relevant mainly in the "everywhere" scope).
          score: (nameMatches ? 10 : 1) + (p.startsWith(home) ? 2 : 0),
        });
        if (hits.length >= limit * 2) break; // cap raw scan before sort/slice
      }
      hits.sort((a, b) => b.score - a.score);
      resolve(hits.slice(0, limit));
    });
    child.on('error', () => resolve([]));
  });
}

/** Grep is capped hard because it runs on every keystroke of the live keyword search: a query
 *  that doesn't finish in this window is SIGTERM'd and we keep whatever partial output arrived.
 *  3s (down from an original 8s) was the difference between the feature feeling dead and feeling
 *  responsive — the old value let a single query block the whole modal for 8s. */
const GREP_TIMEOUT_MS = 3_000;

/** Exact-phrase code search via the ripgrep binary bundled inside the Claude CLI (there is no
 *  standalone `rg` on this machine — see the plan). Killed at GREP_TIMEOUT_MS. Skipped entirely
 *  for very short phrases (too noisy) — callers should also skip this for the 'everywhere'
 *  scope. Directory pre-filtering (e.g. dropping slow external volumes) is the caller's job. */
export function grepProjects(phrase: string, dirs: string[], states: SessionState[], limit = 40): Promise<FileHit[]> {
  if (phrase.length < 3 || dirs.length === 0) return Promise.resolve([]);

  return new Promise((resolve) => {
    const args = [
      '-n', '--max-count', '3', '--max-filesize', '1M', '--max-columns', '400', '-i',
      '-g', '!node_modules', '-g', '!.git',
      phrase, ...dirs,
    ];
    let proc;
    try {
      proc = spawn(CLAUDE_CLI_PATH, args, { argv0: 'rg', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve([]);
      return;
    }
    proc.on('error', () => resolve([]));

    let out = '';
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }, GREP_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    proc.on('close', () => {
      clearTimeout(killTimer);
      const hits: FileHit[] = [];
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        // ripgrep's default format: path:line:text
        const m = /^(.+?):(\d+):(.*)$/.exec(line);
        if (!m) continue;
        const [, p, lineNoStr, text] = m;
        if (isExcludedPath(p)) continue;
        hits.push({
          kind: 'file',
          path: p,
          name: basename(p),
          dir: dirname(p),
          snippet: text.trim().slice(0, 200),
          source: 'grep',
          line: Number(lineNoStr),
          sessionId: sessionForPath(states, p),
          score: 8,
        });
        if (hits.length >= limit) break;
      }
      resolve(hits);
    });
  });
}

function dedupeFileHits(hits: FileHit[], limit: number): FileHit[] {
  const byPath = new Map<string, FileHit>();
  for (const h of hits) {
    const existing = byPath.get(h.path);
    // Prefer a grep hit (has a line + snippet) over a bare spotlight hit for the same path;
    // otherwise keep the higher-scored one.
    if (!existing || h.source === 'grep' || h.score > existing.score) byPath.set(h.path, h);
  }
  return [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Run all three search engines under Promise.allSettled — one engine failing (mdfind
 *  hanging, rg erroring) never blanks the others. */
export async function search(q: string, scope: SearchScope, states: SessionState[], limit = 40): Promise<SearchResponse> {
  const started = Date.now();
  const terms = tokenize(q);
  const errors: string[] = [];

  const projectDirs = [...new Set(states.map(s => s.config.cwd).filter(Boolean))];
  const spotlightDirs = scope === 'projects' ? projectDirs : null;
  // grep walks the filesystem synchronously, so slow external mounts (network shares, spinning
  // media drives under /Volumes) dominate its runtime and routinely blow the timeout while
  // returning nothing useful. Spotlight still covers those dirs (it uses the prebuilt index),
  // so grep can safely skip them and stay fast on the local project dirs that actually hold code.
  const grepDirs = projectDirs.filter(d => !d.startsWith('/Volumes/'));

  const [sessionsResult, filesResult, grepResult] = await Promise.allSettled([
    Promise.resolve(searchSessions(states, terms, limit)),
    spotlightSearch(q, spotlightDirs, states, 60),
    scope === 'projects' ? grepProjects(q, grepDirs, states, 40) : Promise.resolve([] as FileHit[]),
  ]);

  const sessions = sessionsResult.status === 'fulfilled' ? sessionsResult.value : (errors.push('sessions search failed'), []);
  const spotlightFiles = filesResult.status === 'fulfilled' ? filesResult.value : (errors.push('file search failed'), []);
  const grepFiles = grepResult.status === 'fulfilled' ? grepResult.value : (errors.push('code search failed'), []);

  const files = dedupeFileHits([...grepFiles, ...spotlightFiles], 60);

  const tookMs = Date.now() - started;
  console.log(`[Search] q="${q}" scope=${scope} smart=false sessions=${sessions.length} files=${files.length} grep=${grepFiles.length} ${tookMs}ms`);

  return {
    query: q,
    scope,
    smart: false,
    sessions,
    files,
    tookMs,
    ...(errors.length ? { errors } : {}),
  };
}

const SMART_MODEL = 'claude-haiku-4-5-20251001';

function extractJsonObject(text: string): any | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Haiku-assisted search: expand the user's idea into several keyword variants, re-search
 *  with all of them, then ask Haiku to rank the merged candidates with a one-line reason.
 *  Degrades to the plain keyword result (with `errors` set) on any Haiku failure — never
 *  blocks the caller waiting on a broken subprocess. */
export async function smartSearch(q: string, scope: SearchScope, states: SessionState[], model = SMART_MODEL): Promise<SearchResponse> {
  const started = Date.now();

  const expandPrompt =
    `A user is searching their coding sessions and project files for this idea:\n"${q}"\n\n` +
    `Suggest 3 to 6 alternate short keywords or phrasings they might actually find in text ` +
    `(synonyms, related terms, likely file/variable names). Reply with ONLY strict JSON, no ` +
    `prose, no markdown fences: {"terms": ["term1", "term2", ...]}`;

  const expandRaw = await runClaudeOneShot({ prompt: expandPrompt, model, timeoutMs: 45_000 });
  const expandParsed = extractJsonObject(expandRaw);
  let expandedTerms: string[] = Array.isArray(expandParsed?.terms)
    ? expandParsed.terms.filter((t: unknown) => typeof t === 'string' && t.trim()).map((t: string) => t.trim())
    : [];

  if (expandedTerms.length === 0) {
    // Haiku expansion failed — degrade to plain keyword search.
    const fallback = await search(q, scope, states);
    return { ...fallback, smart: false, errors: [...(fallback.errors ?? []), 'smart unavailable'] };
  }

  const allTerms = [q, ...expandedTerms].slice(0, 7);
  const perTermResults = await Promise.all(allTerms.map(t => search(t, scope, states, 20)));

  const sessionsByKey = new Map<string, SessionHit>();
  const filesByPath = new Map<string, FileHit>();
  const errors: string[] = [];
  for (const r of perTermResults) {
    if (r.errors) errors.push(...r.errors);
    for (const s of r.sessions) {
      const key = s.messageId ? `${s.sessionId}:${s.messageId}` : s.sessionId;
      const existing = sessionsByKey.get(key);
      if (!existing || s.score > existing.score) sessionsByKey.set(key, s);
    }
    for (const f of r.files) {
      const existing = filesByPath.get(f.path);
      if (!existing || f.score > existing.score) filesByPath.set(f.path, f);
    }
  }
  const candidateSessions = [...sessionsByKey.values()].sort((a, b) => b.score - a.score).slice(0, 40);
  const candidateFiles = [...filesByPath.values()].sort((a, b) => b.score - a.score).slice(0, 40);

  type Candidate = { kind: 'session' | 'file'; label: string; snippet: string };
  const candidates: Candidate[] = [
    ...candidateSessions.map(s => ({ kind: 'session' as const, label: s.sessionName, snippet: s.snippet })),
    ...candidateFiles.map(f => ({ kind: 'file' as const, label: f.path, snippet: f.snippet ?? '' })),
  ].slice(0, 60);

  if (candidates.length === 0) {
    return {
      query: q, scope, smart: true, expandedTerms,
      sessions: [], files: [], tookMs: Date.now() - started,
      ...(errors.length ? { errors } : {}),
    };
  }

  const rerankPrompt =
    `A user searched for this idea:\n"${q}"\n\n` +
    `Here are candidate matches, numbered. For each candidate, "kind" is session or file, ` +
    `"label" is its name/path, "snippet" is a text excerpt.\n\n` +
    candidates.map((c, i) => `${i}: [${c.kind}] ${c.label} — ${c.snippet.slice(0, 200)}`).join('\n') +
    `\n\nReply with ONLY strict JSON, no prose, no markdown fences, ranking the candidates ` +
    `that actually relate to the user's idea, best first (omit clearly irrelevant ones), each ` +
    `with a short one-line reason:\n{"ranked": [{"i": 0, "why": "..."}, ...]}`;

  const rerankRaw = await runClaudeOneShot({ prompt: rerankPrompt, model, timeoutMs: 45_000 });
  const rerankParsed = extractJsonObject(rerankRaw);
  const ranked: { i: number; why: string }[] = Array.isArray(rerankParsed?.ranked)
    ? rerankParsed.ranked.filter((r: any) => typeof r?.i === 'number' && candidates[r.i])
    : [];

  const rankedIndices = new Set(ranked.map(r => r.i));
  const orderedIndices = [
    ...ranked.map(r => r.i),
    ...candidates.map((_, i) => i).filter(i => !rankedIndices.has(i)),
  ].slice(0, 40);

  const reasonByIndex = new Map(ranked.map(r => [r.i, r.why]));
  const sessions: SessionHit[] = [];
  const files: FileHit[] = [];
  for (const i of orderedIndices) {
    const c = candidates[i];
    if (!c) continue;
    if (c.kind === 'session') {
      const hit = candidateSessions.find(s => s.sessionName === c.label && s.snippet === c.snippet);
      if (hit) sessions.push({ ...hit, reason: reasonByIndex.get(i) });
    } else {
      const hit = candidateFiles.find(f => f.path === c.label);
      if (hit) files.push({ ...hit, reason: reasonByIndex.get(i) });
    }
  }

  const tookMs = Date.now() - started;
  console.log(`[Search] q="${q}" scope=${scope} smart=true sessions=${sessions.length} files=${files.length} grep=0 ${tookMs}ms`);

  if (ranked.length === 0) {
    // Rerank failed — still return the union of candidates (unranked) rather than nothing.
    return {
      query: q, scope, smart: true, expandedTerms,
      sessions: candidateSessions.slice(0, 20), files: candidateFiles.slice(0, 20),
      tookMs, errors: [...errors, 'smart rerank unavailable'],
    };
  }

  return {
    query: q, scope, smart: true, expandedTerms,
    sessions, files, tookMs,
    ...(errors.length ? { errors } : {}),
  };
}
