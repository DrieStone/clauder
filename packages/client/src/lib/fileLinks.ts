import { fileKind } from './fileKinds';

// Opening a file in a browser tab of its own. Images and videos open as themselves (the browser
// shows them); anything else Clauder can show opens /view, a page with just the file viewer.

/** The address that shows a session folder's file in a tab of its own. */
export function fileTabUrl(cwd: string, filePath: string): string {
  const q = `cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`;
  const kind = fileKind(filePath.split('/').pop() ?? filePath);
  return kind === 'image' || kind === 'video' ? `/api/files/raw?${q}` : `/view?${q}`;
}

/** Whether a click asked the browser for a new tab or window (Cmd/Ctrl/Shift/middle click). */
export const wantsNewTab = (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number }) =>
  e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1;
