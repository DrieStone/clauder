import type { UiState } from '@clauder/shared';

// Before the server synced it (server/src/ui-state.ts), each browser kept read status and tab state
// in localStorage. The context starts from that copy and keeps it up to date until the server's first
// snapshot arrives — a server that predates syncing never sends one — then merges it up once and
// drops it.
const READ_KEY = 'clauder.lastViewedAt';
const CLOSED_KEY = 'clauder.closedTabs';
const ORDER_KEY = 'clauder.pinOrder';
const KEYS = [READ_KEY, CLOSED_KEY, ORDER_KEY];

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadLocalUiState(): UiState {
  return { readAt: read(READ_KEY, {}), closedTabs: read(CLOSED_KEY, {}), pinOrder: read(ORDER_KEY, []) };
}

export function saveLocalUiState(s: UiState): void {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(s.readAt));
    localStorage.setItem(CLOSED_KEY, JSON.stringify(s.closedTabs));
    localStorage.setItem(ORDER_KEY, JSON.stringify(s.pinOrder));
  } catch {
    // Storage full or disabled — the in-memory copy still works for this page.
  }
}

/** The local copy, if it holds anything worth merging into the server's. */
export function localUiStateToMerge(): UiState | null {
  const s = loadLocalUiState();
  return Object.keys(s.readAt).length || Object.keys(s.closedTabs).length || s.pinOrder.length ? s : null;
}

export function clearLocalUiState(): void {
  for (const k of KEYS) localStorage.removeItem(k);
}
