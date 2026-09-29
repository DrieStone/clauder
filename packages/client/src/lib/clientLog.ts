// Forward client errors to the server log (/api/client-log → `[client:mobile]` / `[client:desktop]`
// lines in ~/.clauder/clauder.log). Deduped and rate-limited here; the server caps again on its
// side. Message/stack only — never conversation content.

const recent = new Map<string, number>(); // message → last-sent epoch ms
let sentThisMinute = 0;
setInterval(() => { sentThisMinute = 0; }, 60_000);

export function reportClientError(message: string, stack?: string): void {
  try {
    const now = Date.now();
    const last = recent.get(message) ?? 0;
    if (now - last < 30_000 || sentThisMinute >= 10) return; // dedupe + local cap
    recent.set(message, now);
    sentThisMinute++;
    void fetch('/api/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message.slice(0, 300),
        stack: (stack ?? '').slice(0, 500),
        url: location.pathname,
        userAgent: navigator.userAgent,
      }),
      keepalive: true, // survives page unload
    }).catch(() => { /* telemetry must never throw */ });
  } catch { /* ditto */ }
}
