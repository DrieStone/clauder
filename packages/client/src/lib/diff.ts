import { diffLines } from 'diff';

export type DiffLine =
  | { type: 'context'; oldLine: number; newLine: number; content: string }
  | { type: 'add'; newLine: number; content: string }
  | { type: 'remove'; oldLine: number; content: string };

/** Convert two strings into a flat list of unified-diff rows with line numbers tracked across both sides. */
export function computeUnifiedDiff(oldText: string, newText: string): DiffLine[] {
  const changes = diffLines(oldText, newText);
  const rows: DiffLine[] = [];
  let oldLineNo = 1;
  let newLineNo = 1;

  for (const change of changes) {
    // diffLines returns chunks like "foo\nbar\n"; split-by-\n leaves a trailing empty we drop.
    const lines = change.value.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    if (change.added) {
      for (const content of lines) {
        rows.push({ type: 'add', newLine: newLineNo++, content });
      }
    } else if (change.removed) {
      for (const content of lines) {
        rows.push({ type: 'remove', oldLine: oldLineNo++, content });
      }
    } else {
      for (const content of lines) {
        rows.push({ type: 'context', oldLine: oldLineNo++, newLine: newLineNo++, content });
      }
    }
  }

  return rows;
}

export function summarizeDiff(rows: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.type === 'add') added++;
    else if (r.type === 'remove') removed++;
  }
  return { added, removed };
}
