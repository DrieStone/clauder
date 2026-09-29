// Known alternate hostnames for reaching this specific Clauder instance — used as WebSocket
// fallback targets when the page's own origin stops responding. Covers the "bookmarked the
// Tailscale hostname, but I'm actually on the home network and Tailscale's relay is having an
// issue" case (and the reverse): once the page has loaded via ANY of these, the live connection
// rotates through the others automatically if its current one goes flaky. This can't rescue a
// completely failed *initial* page load (nothing can run before the page loads) — only the live
// connection, once something got the page open. Hardcoded to Jonathan's setup; update if the
// Tailscale MagicDNS name or LAN hostname ever changes.
const ALTERNATE_HOSTNAMES = ['JS.local', 'macbook-pro.tail0923a6.ts.net'];

/** The Tailscale address of this Clauder, for the sign-in screen: a Tailscale device is always
 *  the owner's. */
export function tailscaleOrigin(): string | null {
  const host = ALTERNATE_HOSTNAMES.find(h => h.endsWith('.ts.net'));
  return host ? `http://${host}:${window.location.port || '3001'}` : null;
}

/** A share-link page connects only to the host that served it, carrying the link's token. */
export function buildGuestWsUrl(token: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws?share=${encodeURIComponent(token)}`;
}

/** Build the ordered list of ws:// URLs to try, current-origin first (it just served the page,
 *  so it's known-good right now), then the alternates, deduplicated. */
export function buildWsCandidates(): string[] {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = window.location.port;
  const hosts = [window.location.host, ...ALTERNATE_HOSTNAMES.map(h => port ? `${h}:${port}` : h)];
  const seen = new Set<string>();
  const unique = hosts.filter((h) => {
    const key = h.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.map(h => `${protocol}//${h}/ws`);
}
