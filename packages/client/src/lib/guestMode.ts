import { createContext, useContext } from 'react';

/** Set on a share-link page: which guest is looking. Chat components use it to hide owner-only
 *  controls (pinning, applying CLAUDE.md rules) and to label who wrote each message. Null for the
 *  owner. The server enforces all of this regardless; this only keeps dead buttons off the page. */
export const GuestModeContext = createContext<{ guestName: string } | null>(null);

export function useGuestMode(): { guestName: string } | null {
  return useContext(GuestModeContext);
}
