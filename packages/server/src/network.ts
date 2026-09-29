import os from 'os';

/** "::ffff:192.168.5.52" → "192.168.5.52"; drops an IPv6 zone ("fe80::1%en0"). */
export function normalizeIp(ip: string | undefined): string {
  return String(ip ?? '').replace(/^::ffff:/i, '').replace(/%.*$/, '').toLowerCase();
}

function ipv4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  return m ? m.slice(1).map(Number) : null;
}

export function isLoopback(ip: string): boolean {
  const p = ipv4(ip);
  return p ? p[0] === 127 : ip === '::1';
}

/** Tailscale's address ranges: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isTailscale(ip: string): boolean {
  const p = ipv4(ip);
  if (p) return p[0] === 100 && p[1] >= 64 && p[1] <= 127;
  return ip.startsWith('fd7a:115c:a1e0:');
}

/** The local network: 10/8, 172.16/12, 192.168/16 and link-local, plus IPv6 unique-local and
 *  link-local (Tailscale's own IPv6 range excluded). */
export function isLan(ip: string): boolean {
  const p = ipv4(ip);
  if (p) {
    return p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254);
  }
  return (/^f[cd][0-9a-f]{2}:/.test(ip) && !isTailscale(ip)) || /^fe[89ab][0-9a-f]:/.test(ip);
}

let ownAddresses: { at: number; ips: Set<string> } | null = null;

/** Whether a connection comes from this Mac: loopback, or one of its own interface addresses
 *  (opening http://JS.local:3001 on the Mac itself arrives from its LAN address). A TCP peer can't
 *  borrow one of these from elsewhere on the network — the handshake's replies would never leave. */
export function isThisMachine(ip: string): boolean {
  if (isLoopback(ip)) return true;
  if (!ownAddresses || Date.now() - ownAddresses.at > 60_000) {
    const ips = new Set<string>();
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list ?? []) ips.add(normalizeIp(a.address));
    }
    ownAddresses = { at: Date.now(), ips };
  }
  return ownAddresses.ips.has(ip);
}
