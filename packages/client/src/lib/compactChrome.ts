// Compact mode on a phone: the ⤢ button by the message box hides the session's tab strip, header,
// Chat/Files tabs and task bar (everything marked `kb-hide`), as typing does, but until switched
// back. Kept per device.

const KEY = 'clauder.compactChrome';

export function isCompact(): boolean {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setCompact(on: boolean): void {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
  document.documentElement.classList.toggle('chrome-min', on);
}

/** Apply the stored setting (once, at startup). */
export function applyCompact(): void {
  document.documentElement.classList.toggle('chrome-min', isCompact());
}
