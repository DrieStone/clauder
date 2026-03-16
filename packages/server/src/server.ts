import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import type { SessionManager } from './session-manager.js';
import { authMiddleware, setAuthCookie, getAuthToken } from './auth.js';

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

export function createApp(sessionManager: SessionManager) {
  const app = express();
  app.use(express.json());

  // Auth endpoints (before middleware)
  app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === getAuthToken()) {
      const secure = req.headers['x-forwarded-proto'] === 'https' || req.protocol === 'https';
      setAuthCookie(res, secure);
      res.json({ ok: true });
    } else {
      res.status(401).json({ error: 'Invalid password' });
    }
  });

  app.get('/api/auth-check', (req, res) => {
    // Quick way for client to check if already authenticated
    // This is checked before authMiddleware runs (it's whitelisted)
    const cookie = req.headers.cookie || '';
    const match = cookie.split(';').find(c => c.trim().startsWith('clauder_auth='));
    const token = match ? decodeURIComponent(match.trim().slice('clauder_auth='.length)) : '';
    res.json({ authenticated: token === getAuthToken() });
  });

  // Protect all other /api routes
  app.use('/api', authMiddleware);

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
