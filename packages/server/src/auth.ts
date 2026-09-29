import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'http';
import type { ShareLink } from '@clauder/shared';
import { normalizeIp, isThisMachine, isTailscale, isLan } from './network.js';

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

/** Whether `key` is the owner token (the secret in the owner link), compared in constant time. */
export function isOwnerKey(key: string): boolean {
  if (!authToken || typeof key !== 'string') return false;
  const a = Buffer.from(key);
  const b = Buffer.from(authToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Check if an incoming HTTP request (e.g. WebSocket upgrade) has a valid auth cookie. */
export function isAuthenticated(req: IncomingMessage): boolean {
  const token = parseCookie(req.headers.cookie, COOKIE_NAME);
  return token === authToken;
}

/** Set the auth cookie on a response. Browsers cap cookie lifetimes at 400 days; the auth check
 *  re-sets it on each visit, so a signed-in device stays signed in. */
export function setAuthCookie(res: Response, secure: boolean) {
  const maxAge = 400 * 24 * 60 * 60;
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

export type Access =
  | { role: 'owner'; via: 'this-mac' | 'tailscale' | 'owner-link' }
  | { role: 'guest'; share: ShareLink }
  | { role: 'none'; reason: 'not-signed-in' | 'invalid-share' | 'share-off-network' };

/** Who's connecting, for every API request and WebSocket.
 *  - The owner: this Mac, their Tailscale devices, or a device that opened the owner link once
 *    (which sets the auth cookie). Plain Wi-Fi isn't enough: a guest is on that network too.
 *  - A guest: a share link's token, honored only from the local network, Tailscale, or this Mac,
 *    never the internet. A request carrying a share token is always that guest, even from the
 *    owner's own devices, so opening a link previews exactly what the guest sees.
 *  Tailscale needs both ends on Tailscale addresses, not just a 100.x source address. */
export function resolveAccess(req: IncomingMessage, shareToken: string | null, findShare: (token: string) => ShareLink | null): Access {
  const remote = normalizeIp(req.socket?.remoteAddress);
  const local = normalizeIp(req.socket?.localAddress);
  if (shareToken) {
    const share = findShare(shareToken);
    if (!share) return { role: 'none', reason: 'invalid-share' };
    if (!isThisMachine(remote) && !isLan(remote) && !isTailscale(remote)) return { role: 'none', reason: 'share-off-network' };
    return { role: 'guest', share };
  }
  if (isThisMachine(remote)) return { role: 'owner', via: 'this-mac' };
  if (isTailscale(remote) && isTailscale(local)) return { role: 'owner', via: 'tailscale' };
  if (authToken && parseCookie(req.headers.cookie, COOKIE_NAME) === authToken) return { role: 'owner', via: 'owner-link' };
  return { role: 'none', reason: 'not-signed-in' };
}
