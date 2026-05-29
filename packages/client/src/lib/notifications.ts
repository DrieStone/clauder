/**
 * Browser notification helper. Wraps the Notification API + tab title indicator.
 *
 * Tracks "unread" notifications (count + sessionId list) so:
 *  - The browser tab title shows a count
 *  - Clicking a notification can focus that session
 *  - Opening a session clears its unread state
 */

const STORAGE_KEY = 'clauder.notifications.enabled';
const ORIG_TITLE = 'Clauder';

let enabled = (() => {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
})();

const unread = new Set<string>(); // sessionIds with unread notifications
let onSessionClick: ((sessionId: string) => void) | null = null;

export function isNotificationsEnabled(): boolean {
  return enabled && typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

export function isSupported(): boolean {
  return typeof Notification !== 'undefined';
}

/** Request permission and enable notifications. Returns true if successful. */
export async function enableNotifications(): Promise<boolean> {
  if (!isSupported()) return false;
  if (Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') return false;
  }
  if (Notification.permission !== 'granted') return false;
  enabled = true;
  try { localStorage.setItem(STORAGE_KEY, '1'); } catch {}
  return true;
}

export function disableNotifications(): void {
  enabled = false;
  try { localStorage.setItem(STORAGE_KEY, '0'); } catch {}
}

/** Register a callback for when a notification is clicked. */
export function onNotificationClick(cb: (sessionId: string) => void): void {
  onSessionClick = cb;
}

/** Update the browser tab title to reflect unread count. */
function updateTitle(): void {
  const n = unread.size;
  document.title = n > 0 ? `(${n}) ${ORIG_TITLE}` : ORIG_TITLE;
}

/** Show a notification. If the tab is focused, just track unread (no popup). */
export function notify(opts: {
  title: string;
  body: string;
  sessionId: string;
  /** Tag groups notifications by category — same tag replaces the previous */
  tag?: string;
}): void {
  unread.add(opts.sessionId);
  updateTitle();

  // Don't pop up notifications if the tab is currently visible
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    return;
  }

  if (!isNotificationsEnabled()) return;

  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag || `clauder-${opts.sessionId}`,
      icon: '/favicon.ico',
    });
    n.onclick = () => {
      window.focus();
      onSessionClick?.(opts.sessionId);
      n.close();
    };
  } catch {
    // Notification creation can fail in some sandboxed contexts — ignore
  }
}

/** Mark a session as read (call when user opens it). */
export function markRead(sessionId: string): void {
  if (unread.delete(sessionId)) updateTitle();
}

export function getUnreadCount(): number {
  return unread.size;
}
