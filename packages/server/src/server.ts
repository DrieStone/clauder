import express from 'express';
import compression from 'compression';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { execFile, spawn as spawnChild } from 'child_process';
import type { SessionManager } from './session-manager.js';
import type { TriggerManager } from './triggers.js';
import type { ProjectRunner } from './project-runner.js';
import type { WsOutboundMessage, ImageAttachment, FileAttachment } from '@clauder/shared';
import { getRateLimitInfo } from './rate-limits.js';
import { logUsage } from './usage-log.js';
import { DEV_ROOT, devRootForDisplay, listProjectFolders } from './projects.js';
import { search, smartSearch } from './search.js';
import { getGitStatus } from './git-status.js';
import { resolveAccess, setAuthCookie, getAuthToken, isOwnerKey } from './auth.js';
import { shareBaseUrl, type ShareManager } from './shares.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve a relative path within cwd, returning null if it escapes. */
function resolveSafePath(cwd: string, relativePath: string): string | null {
  const resolvedCwd = path.resolve(cwd);
  const resolved = path.resolve(resolvedCwd, relativePath);
  if (!resolved.startsWith(resolvedCwd + path.sep) && resolved !== resolvedCwd) {
    return null;
  }
  return resolved;
}

/** True for a transient "not resident yet" read failure on a macOS cloud-storage placeholder
 *  file (iCloud Drive optimizes ~/Documents and ~/Desktop by default: a file can exist in the
 *  directory listing before its content is downloaded). The kernel returns EAGAIN/errno -11
 *  synchronously instead of blocking for materialization — but on this path Node/libuv doesn't
 *  always map it to the 'EAGAIN' code string, only the numeric errno, so check errno directly. */
function isTransientCloudReadError(err: any): boolean {
  return err?.errno === -11;
}

const CLOUD_READ_RETRY_DELAYS_MS = [400, 900]; // ~1.3s total before giving up

/** Read a file, retrying past transient cloud-placeholder EAGAIN failures (see
 *  isTransientCloudReadError) with a short backoff — the OS's own signal is "try again". */
async function readFileWithCloudRetry(resolved: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.readFile(resolved, 'utf-8');
    } catch (err: any) {
      if (!isTransientCloudReadError(err) || attempt >= CLOUD_READ_RETRY_DELAYS_MS.length) throw err;
      await new Promise(r => setTimeout(r, CLOUD_READ_RETRY_DELAYS_MS[attempt]));
    }
  }
}

// Text/code files served as UTF-8 JSON via /api/files/read.
const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.text', '.log', '.json', '.jsonc', '.yaml', '.yml', '.toml',
  '.xml', '.csv', '.tsv', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.php',
  '.java', '.kt', '.kts', '.swift', '.go', '.rs', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.fish', '.sql', '.graphql', '.gql', '.html', '.htm', '.css', '.scss',
  '.sass', '.less', '.ini', '.conf', '.cfg', '.env', '.properties', '.vue', '.svelte', '.astro',
  '.lua', '.pl', '.r', '.dart', '.scala', '.clj', '.ex', '.exs', '.erl', '.hs', '.ml',
]);
// Extensionless files that are still text.
const TEXT_BASENAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', 'procfile']);
// Media served raw (with byte-range support) via /api/files/raw.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
const RAW_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS, '.pdf']);

function isTextFile(resolved: string): boolean {
  return TEXT_EXTS.has(path.extname(resolved).toLowerCase())
    || TEXT_BASENAMES.has(path.basename(resolved).toLowerCase());
}

export function createApp(
  sessionManager: SessionManager,
  getTriggers: () => TriggerManager,
  getProjectRunner: () => ProjectRunner,
  getBroadcast: () => (msg: WsOutboundMessage) => void = () => () => {},
  getShares: () => ShareManager | undefined = () => undefined,
) {
  const app = express();
  // The client bundle shipped uncompressed (559 KB) — a real cost on cellular.
  app.use(compression());
  app.use(express.json({ limit: '5mb' }));

  // Who may use the API (auth.ts resolveAccess): the owner for everything, a share-link guest only
  // for its own session's attachments, and anyone for the health and sign-in checks.
  app.use('/api', (req, res, next) => {
    if (req.path === '/health' || req.path === '/auth-check') return next();
    const share = typeof req.query.share === 'string' ? req.query.share : null;
    const access = resolveAccess(req, share, (token) => getShares()?.findByToken(token) ?? null);
    if (access.role === 'owner') return next();
    if (access.role === 'guest' && req.method === 'GET' && req.path.startsWith(`/attachments/${encodeURIComponent(access.share.sessionId)}/`)) return next();
    res.status(access.role === 'guest' ? 403 : 401).json({ error: access.role === 'guest' ? 'Not available on a shared link' : 'Not signed in' });
  });

  // Whether this device has owner access (the page shows a sign-in screen if not). A device that
  // opened the owner link gets its cookie renewed here, so it stays signed in past the 400-day cap.
  app.get('/api/auth-check', (req, res) => {
    const access = resolveAccess(req, null, () => null);
    if (access.role === 'owner' && access.via === 'owner-link') setAuthCookie(res, req.protocol === 'https');
    res.json({ owner: access.role === 'owner', via: access.role === 'owner' ? access.via : null });
  });

  // The owner link: opening it once on a device gives that device owner access on the local
  // network, by setting the auth cookie. The Share dialog offers it; it must stay private.
  app.get('/api/owner-link', (_req, res) => {
    res.json({ url: `${shareBaseUrl()}/owner/${getAuthToken()}` });
  });
  app.get('/owner/:key', (req, res) => {
    if (!isOwnerKey(req.params.key)) {
      res.status(403).type('text').send('That owner link is not valid.');
      return;
    }
    setAuthCookie(res, req.protocol === 'https');
    res.redirect('/');
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Browser-side error forwarding: window.onerror / unhandledrejection in the client POST
  // here (see main.tsx). Before this, the browser had zero telemetry — every mobile bug was
  // diagnosed blind from screenshots. Rate-limited server-side; error text + stack only,
  // never page content.
  let clientLogCount = 0;
  setInterval(() => { clientLogCount = 0; }, 60 * 60 * 1000).unref();
  app.post('/api/client-log', (req, res) => {
    res.status(204).end(); // always ack fast; logging is best-effort
    if (++clientLogCount > 30) return; // cap per hour — a crash loop can't flood the log
    try {
      const b = req.body ?? {};
      const message = String(b.message ?? '').slice(0, 300);
      if (!message) return;
      const stack = String(b.stack ?? '').slice(0, 500);
      const url = String(b.url ?? '').slice(0, 120);
      const uaTag = /iPhone|iPad|Android|Mobile/i.test(String(b.userAgent ?? '')) ? 'mobile' : 'desktop';
      console.error(`[client:${uaTag}] ${message}${url ? ` @ ${url}` : ''}${stack ? `\n  ${stack.replace(/\n/g, '\n  ')}` : ''}`);
    } catch { /* never let telemetry throw */ }
  });

  // Restart the launchd-managed server process from the UI. `launchctl kickstart -k` sends
  // SIGKILL (bypassing our graceful SIGTERM/SIGINT handlers), so we flush persistence
  // synchronously first, respond, THEN kill — on a short delay so the HTTP response has time
  // to actually reach the browser before this process dies. The kickstart itself runs
  // detached + unref'd so it isn't a child of (and doesn't die with) this process.
  // NEVER call this from inside a running Claude session's Bash tool — that kills the CLI
  // child process mid-turn. This is only for the explicit "Restart Server" UI action.
  app.post('/api/restart-server', (_req, res) => {
    logUsage('server_restart_requested');
    try {
      sessionManager.persistNow();
    } catch (err) {
      console.error('[restart] persistNow failed before restart:', err);
    }
    res.json({ ok: true });
    setTimeout(() => {
      try {
        const uid = process.getuid?.();
        if (uid === undefined) {
          console.error('[restart] process.getuid unavailable — cannot target launchd job (not on a Unix platform?)');
          return;
        }
        const proc = spawnChild('launchctl', ['kickstart', '-k', `gui/${uid}/com.jsweet.clauder`], {
          detached: true,
          stdio: 'ignore',
        });
        proc.unref();
      } catch (err) {
        console.error('[restart] Failed to spawn kickstart:', err);
      }
    }, 400);
  });

  app.get('/api/rate-limit', (_req, res) => {
    res.json(getRateLimitInfo());
  });

  app.get('/api/project-runs', (_req, res) => {
    res.json(getProjectRunner().list());
  });

  app.get('/api/sessions', (_req, res) => {
    res.json(sessionManager.getAllSessions());
  });

  // --- Global search ---

  app.get('/api/search', async (req, res) => {
    const q = (req.query.q as string | undefined)?.trim();
    if (!q) {
      res.status(400).json({ error: 'q is required' });
      return;
    }
    const scope = req.query.scope === 'everywhere' ? 'everywhere' : 'projects';
    const smart = req.query.smart === '1' || req.query.smart === 'true';
    const limit = Number(req.query.limit) || 40;
    try {
      const states = sessionManager.getAllSessions();
      const result = smart ? await smartSearch(q, scope, states) : await search(q, scope, states, limit);
      res.json(result);
    } catch (err: any) {
      console.error('[Search] request failed:', err?.message ?? err);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  app.get('/api/sessions/:id', (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session.getState());
  });

  // The session header's repo indicator. The folder comes from the session, never from the client.
  app.get('/api/sessions/:id/git', async (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(await getGitStatus(session.config.cwd));
  });

  // --- Claude auth endpoints ---

  // Find the Claude CLI path (same walk-up logic as session.ts)
  const findCliPath = (): { command: string; isNative: boolean } => {
    let dir = __dirname;
    const candidates = [
      'node_modules/@anthropic-ai/claude-code/bin/claude.exe',
      'node_modules/@anthropic-ai/claude-code/cli.js',
    ];
    while (true) {
      for (const rel of candidates) {
        const candidate = path.join(dir, rel);
        if (existsSync(candidate)) return { command: candidate, isNative: rel.endsWith('.exe') };
      }
      const parent = path.dirname(dir);
      if (parent === dir) return { command: 'claude', isNative: true }; // fallback
      dir = parent;
    }
  };

  app.get('/api/claude-auth', (_req, res) => {
    const cli = findCliPath();
    const cmd = cli.isNative ? cli.command : process.execPath;
    const args = cli.isNative ? ['auth', 'status'] : [cli.command, 'auth', 'status'];
    execFile(cmd, args, { timeout: 10000 }, (err, stdout) => {
      if (err) {
        res.json({ loggedIn: false, error: err.message });
        return;
      }
      try {
        res.json(JSON.parse(stdout));
      } catch {
        res.json({ loggedIn: false, raw: stdout });
      }
    });
  });

  app.post('/api/claude-auth/login', (_req, res) => {
    logUsage('reauth_login');
    const cli = findCliPath();
    const cmd = cli.isNative ? cli.command : process.execPath;
    const args = cli.isNative ? ['auth', 'login', '--claudeai'] : [cli.command, 'auth', 'login', '--claudeai'];
    const proc = spawnChild(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let responded = false;
    let output = '';

    const tryExtractUrl = (chunk: string) => {
      output += chunk;
      if (responded) return;
      // CLI prints: "If the browser didn't open, visit: <url>"
      const match = output.match(/visit:\s*(https:\/\/\S+)/);
      if (match) {
        responded = true;
        res.json({ ok: true, url: match[1] });
      }
    };

    proc.stdout?.on('data', (d: Buffer) => tryExtractUrl(d.toString()));
    proc.stderr?.on('data', (d: Buffer) => tryExtractUrl(d.toString()));

    // Fallback: if no URL extracted within 5s, respond without one (browser may have auto-opened)
    const timeout = setTimeout(() => {
      if (!responded) {
        responded = true;
        res.json({ ok: true, url: null });
      }
    }, 5000);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (!responded) {
        responded = true;
        res.json({ ok: code === 0, url: null });
      }
      if (code === 0) {
        getBroadcast()({ type: 'auth_restored' });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      if (!responded) {
        responded = true;
        res.status(500).json({ ok: false, error: err.message });
      }
    });
  });

  // --- Triggers (watches + scheduled tasks) ---

  app.get('/api/triggers', (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    const source = req.query.source as 'watch' | 'scheduled' | undefined;
    res.json(getTriggers().list({ sessionId, source }));
  });

  app.post('/api/triggers', (req, res) => {
    const { sessionId, message, description, schedule, source } = req.body || {};
    if (!sessionId || !message || !schedule || !source) {
      res.status(400).json({ error: 'sessionId, message, schedule, source are required' });
      return;
    }
    if (source !== 'watch' && source !== 'scheduled') {
      res.status(400).json({ error: 'source must be "watch" or "scheduled"' });
      return;
    }
    // Validate schedule
    if (schedule.type === 'once') {
      if (!schedule.at || isNaN(new Date(schedule.at).getTime())) {
        res.status(400).json({ error: 'schedule.at must be a valid ISO timestamp' });
        return;
      }
    } else if (schedule.type === 'recurring') {
      const sec = Number(schedule.intervalSeconds);
      if (!sec || sec < 30) {
        res.status(400).json({ error: 'schedule.intervalSeconds must be >= 30' });
        return;
      }
      if (!schedule.nextAt) {
        schedule.nextAt = new Date(Date.now() + sec * 1000).toISOString();
      }
    } else {
      res.status(400).json({ error: 'schedule.type must be "once" or "recurring"' });
      return;
    }

    if (!sessionManager.getSession(sessionId)) {
      res.status(404).json({ error: `Session ${sessionId} not found` });
      return;
    }

    const trigger = getTriggers().create({
      sessionId,
      message: String(message),
      description: String(description || ''),
      schedule,
      source,
    });
    logUsage('schedule_created', { sessionId, source, scheduleType: schedule.type });
    res.json(trigger);
  });

  app.patch('/api/triggers/:id', (req, res) => {
    const trigger = getTriggers().update(req.params.id, req.body || {});
    if (!trigger) {
      res.status(404).json({ error: 'Trigger not found' });
      return;
    }
    logUsage('schedule_edited', { sessionId: trigger.sessionId });
    res.json(trigger);
  });

  app.delete('/api/triggers/:id', (req, res) => {
    const ok = getTriggers().remove(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Trigger not found' });
      return;
    }
    logUsage('schedule_deleted');
    res.json({ ok: true });
  });

  // --- New-project folders: the new-session form's "New project" option (see projects.ts) ---

  app.get('/api/projects', (_req, res) => {
    res.json({ root: DEV_ROOT, display: devRootForDisplay(), folders: listProjectFolders() });
  });

  // --- File browser endpoints ---

  app.get('/api/files/list', async (req, res) => {
    const cwd = req.query.cwd as string;
    const relativePath = (req.query.path as string) || '';

    if (!cwd) {
      res.status(400).json({ error: 'cwd is required' });
      return;
    }

    const resolved = resolveSafePath(cwd, relativePath);
    if (!resolved) {
      res.status(403).json({ error: 'Path traversal denied' });
      return;
    }

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isDirectory()) {
        res.status(400).json({ error: 'Not a directory' });
        return;
      }

      const dirEntries = await fs.readdir(resolved, { withFileTypes: true });
      const entries = dirEntries
        .filter(e => !e.name.startsWith('.'))
        .map(e => ({
          name: e.name,
          type: (e.isDirectory() ? 'directory' : 'file') as 'directory' | 'file',
          path: path.relative(path.resolve(cwd), path.join(resolved, e.name)),
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      res.json({ entries });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'Directory not found' });
      } else {
        res.status(500).json({ error: 'Failed to list directory' });
      }
    }
  });

  app.get('/api/files/read', async (req, res) => {
    const cwd = req.query.cwd as string;
    const relativePath = req.query.path as string;

    if (!cwd || !relativePath) {
      res.status(400).json({ error: 'cwd and path are required' });
      return;
    }

    const resolved = resolveSafePath(cwd, relativePath);
    if (!resolved) {
      res.status(403).json({ error: 'Path traversal denied' });
      return;
    }

    if (!isTextFile(resolved)) {
      res.status(403).json({ error: 'Not a viewable text file' });
      return;
    }

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        res.status(400).json({ error: 'Not a file' });
        return;
      }
      if (stat.size > 2_000_000) {
        res.status(413).json({ error: 'File too large (max 2MB)' });
        return;
      }

      const content = await readFileWithCloudRetry(resolved);
      logUsage('file_view', { kind: 'text' });
      res.json({ content, name: path.basename(resolved) });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
      } else if (isTransientCloudReadError(err)) {
        console.error(`[files/read] ${resolved}: still not resident after retries (errno -11, iCloud placeholder?)`);
        res.status(503).json({ error: "File isn't available yet — it may be an iCloud/cloud-storage placeholder still downloading. Try again in a moment, or open it in Finder first." });
      } else {
        // Previously swallowed silently — a 500 here left no trace in the log, so a report
        // of "HTTP 500" was undiagnosable after the fact. Always log what actually happened.
        console.error(`[files/read] ${resolved}: ${err.code || err.name || 'error'} — ${err.message}`);
        res.status(500).json({ error: 'Failed to read file' });
      }
    }
  });

  // Download any file within the session cwd as an attachment. Unlike /api/files/read
  // (text allowlist) and /api/files/raw (media allowlist), downloads deliberately have NO
  // extension filter — fetching an arbitrary artifact (zip, sqlite, binary) is the point.
  // Path traversal is guarded the same as the other file endpoints.
  app.get('/api/files/download', async (req, res) => {
    const cwd = req.query.cwd as string;
    const relativePath = req.query.path as string;

    if (!cwd || !relativePath) {
      res.status(400).json({ error: 'cwd and path are required' });
      return;
    }

    const resolved = resolveSafePath(cwd, relativePath);
    if (!resolved) {
      res.status(403).json({ error: 'Path traversal denied' });
      return;
    }

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        res.status(400).json({ error: 'Not a file' });
        return;
      }
      logUsage('file_download');
      res.download(resolved, path.basename(resolved), (err) => {
        if (err && !res.headersSent) {
          console.error(`[files/download] ${resolved}: ${(err as any).code || err.name || 'error'} — ${err.message}`);
          res.status(500).json({ error: 'Failed to download file' });
        }
      });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
      } else {
        console.error(`[files/download] ${resolved}: ${err.code || err.name || 'error'} — ${err.message}`);
        res.status(500).json({ error: 'Failed to download file' });
      }
    }
  });

  // Serve images / video / pdf raw, with byte-range support (res.sendFile handles Range
  // headers, so video seeking and streaming Just Work). Path-safety + extension allowlisted.
  app.get('/api/files/raw', async (req, res) => {
    const cwd = req.query.cwd as string;
    const relativePath = req.query.path as string;

    if (!cwd || !relativePath) {
      res.status(400).json({ error: 'cwd and path are required' });
      return;
    }

    const resolved = resolveSafePath(cwd, relativePath);
    if (!resolved) {
      res.status(403).json({ error: 'Path traversal denied' });
      return;
    }

    if (!RAW_EXTS.has(path.extname(resolved).toLowerCase())) {
      res.status(403).json({ error: 'File type not viewable' });
      return;
    }

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        res.status(400).json({ error: 'Not a file' });
        return;
      }
      // nosniff: trust our extension→Content-Type mapping, don't let the browser re-sniff.
      // SVGs are only ever loaded via <img> on the client, so embedded scripts can't execute.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Log once per view, not once per byte-range chunk (video seeking re-requests this
      // constantly with Range headers starting mid-file — only log the initial request).
      const range = req.headers.range;
      if (!range || /^bytes=0-/.test(range)) {
        logUsage('file_view', { kind: IMAGE_EXTS.has(path.extname(resolved).toLowerCase()) ? 'image' : 'video_or_pdf' });
      }
      const sendWithCloudRetry = (attempt: number) => {
        res.sendFile(resolved, { headers: { 'Content-Disposition': 'inline' } }, (err) => {
          if (!err || res.headersSent) return;
          if (isTransientCloudReadError(err) && attempt < CLOUD_READ_RETRY_DELAYS_MS.length) {
            setTimeout(() => sendWithCloudRetry(attempt + 1), CLOUD_READ_RETRY_DELAYS_MS[attempt]);
            return;
          }
          if (isTransientCloudReadError(err)) {
            console.error(`[files/raw] ${resolved}: still not resident after retries (errno -11, iCloud placeholder?)`);
            res.status(503).json({ error: "File isn't available yet — it may be an iCloud/cloud-storage placeholder still downloading. Try again in a moment, or open it in Finder first." });
          } else {
            console.error(`[files/raw] ${resolved}: ${(err as any).code || err.name || 'error'} — ${err.message}`);
            res.status(500).json({ error: 'Failed to read file' });
          }
        });
      };
      sendWithCloudRetry(0);
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
      } else {
        console.error(`[files/raw] ${resolved}: ${err.code || err.name || 'error'} — ${err.message}`);
        res.status(500).json({ error: 'Failed to read file' });
      }
    }
  });

  // --- Message attachments ---
  // Stored history arrives over the WebSocket with attachment blobs replaced by these URLs (see
  // client-view.ts). An attachment never changes once recorded, so it is served `immutable`:
  // the browser keeps it across reloads instead of receiving it in every session snapshot.
  app.get('/api/attachments/:sessionId/:messageId/:kind/:index', (req, res) => {
    const { sessionId, messageId, kind, index } = req.params;
    const session = sessionManager.getSession(sessionId);
    const message = session?.getState().messages.find(m => m.id === messageId);
    const i = parseInt(index, 10);
    const att = kind === 'image' ? message?.images?.[i] : kind === 'file' ? message?.files?.[i] : undefined;
    if (!att) { res.status(404).json({ error: 'Attachment not found' }); return; }
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (kind === 'image') {
      const img = att as ImageAttachment;
      res.setHeader('Content-Type', img.mimeType || 'application/octet-stream');
      res.send(Buffer.from(img.data, 'base64'));
      return;
    }
    const file = att as FileAttachment;
    if (file.kind === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(file.content);
      return;
    }
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.send(Buffer.from(file.content, 'base64'));
  });

  // Serve built client in production
  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist, {
      // Asset filenames are content-hashed, so they can be cached forever; index.html must always
      // be revalidated or a new build would never be picked up.
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', filePath.includes(`${path.sep}assets${path.sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache');
      },
    }));
    // SPA fallback: serve index.html for all non-API routes
    app.get('*', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  return app;
}
