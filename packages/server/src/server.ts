import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { execFile, spawn as spawnChild } from 'child_process';
import type { SessionManager } from './session-manager.js';
import type { TriggerManager } from './triggers.js';

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

export function createApp(sessionManager: SessionManager, getTriggers: () => TriggerManager) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/api/sessions', (_req, res) => {
    res.json(sessionManager.getAllSessions());
  });

  app.get('/api/sessions/:id', (req, res) => {
    const session = sessionManager.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    res.json(session.getState());
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
    const cli = findCliPath();
    // claude auth login opens a browser on the server machine — fire and forget
    const cmd = cli.isNative ? cli.command : process.execPath;
    const args = cli.isNative ? ['auth', 'login'] : [cli.command, 'auth', 'login'];
    const proc = spawnChild(cmd, args, {
      detached: true,
      stdio: 'ignore',
    });
    proc.unref();
    res.json({ ok: true, message: 'Login flow started — complete authentication in the browser window that opened on the server.' });
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
    res.json(trigger);
  });

  app.patch('/api/triggers/:id', (req, res) => {
    const trigger = getTriggers().update(req.params.id, req.body || {});
    if (!trigger) {
      res.status(404).json({ error: 'Trigger not found' });
      return;
    }
    res.json(trigger);
  });

  app.delete('/api/triggers/:id', (req, res) => {
    const ok = getTriggers().remove(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Trigger not found' });
      return;
    }
    res.json({ ok: true });
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

    const ext = path.extname(resolved).toLowerCase();
    if (ext !== '.md' && ext !== '.txt') {
      res.status(403).json({ error: 'Only .md and .txt files can be viewed' });
      return;
    }

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        res.status(400).json({ error: 'Not a file' });
        return;
      }
      if (stat.size > 1_000_000) {
        res.status(413).json({ error: 'File too large (max 1MB)' });
        return;
      }

      const content = await fs.readFile(resolved, 'utf-8');
      res.json({ content, name: path.basename(resolved) });
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        res.status(404).json({ error: 'File not found' });
      } else {
        res.status(500).json({ error: 'Failed to read file' });
      }
    }
  });

  // Serve built client in production
  const clientDist = path.resolve(__dirname, '../../client/dist');
  if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // SPA fallback: serve index.html for all non-API routes
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  return app;
}
