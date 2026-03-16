import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'http';

const CLAUDER_DIR = path.join(process.env.HOME || '~', '.clauder');
const TOKEN_FILE = path.join(CLAUDER_DIR, 'auth-token');
const COOKIE_NAME = 'clauder_auth';

let authToken: string = '';

/** Load or generate the auth token. Call once on startup. */
export function initAuth(): string {
  // Allow override via env var
  if (process.env.CLAUDER_AUTH_TOKEN) {
    authToken = process.env.CLAUDER_AUTH_TOKEN;
    return authToken;
  }

  // Ensure ~/.clauder directory exists
  if (!fs.existsSync(CLAUDER_DIR)) {
    fs.mkdirSync(CLAUDER_DIR, { recursive: true });
  }

  // Load existing token or generate a new one
  if (fs.existsSync(TOKEN_FILE)) {
    authToken = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    if (authToken.length >= 32) {
      return authToken;
    }
  }

  // Generate a new 32-byte random hex token
  authToken = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(TOKEN_FILE, authToken, { mode: 0o600 });
  return authToken;
}

export function getAuthToken(): string {
  return authToken;
}

/** Parse a specific cookie value from a cookie header string. */
function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').find(c => c.trim().startsWith(name + '='));
  if (!match) return null;
  return decodeURIComponent(match.trim().slice(name.length + 1));
}

/** Express middleware that checks for a valid auth cookie. Skips /api/login and /api/auth-check. */
export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // Allow login and auth-check endpoints without auth
  if (req.path === '/api/login' || req.path === '/api/auth-check') {
    return next();
  }

  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  if (token === authToken) {
    return next();
  }

  res.status(401).json({ error: 'Unauthorized' });
}

/** Check if an incoming HTTP request (e.g. WebSocket upgrade) has a valid auth cookie. */
export function isAuthenticated(req: IncomingMessage): boolean {
  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  return token === authToken;
}

/** Set the auth cookie on a response. */
export function setAuthCookie(res: Response, secure: boolean) {
  const maxAge = 30 * 24 * 60 * 60; // 30 days
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(authToken)}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${maxAge}`,
  ];
  if (secure) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}
