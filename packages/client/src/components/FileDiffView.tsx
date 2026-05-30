import { useMemo } from 'react';
import { computeUnifiedDiff, summarizeDiff } from '../lib/diff';

interface FileDiffViewProps {
  filePath: string;
  oldText: string;
  newText: string;
  /** Show "+N −M" stats chip in the header. Default true. */
  showStats?: boolean;
  /** Show file path in header. Default true. False for MultiEdit child diffs where the header is shared. */
  showHeader?: boolean;
}

export function FileDiffView({ filePath, oldText, newText, showStats = true, showHeader = true }: FileDiffViewProps) {
  const rows = useMemo(() => computeUnifiedDiff(oldText, newText), [oldText, newText]);
  const stats = useMemo(() => summarizeDiff(rows), [rows]);

  if (rows.length === 0 || (stats.added === 0 && stats.removed === 0)) {
    return (
      <div className="rounded border border-gray-800 bg-gray-900 overflow-hidden">
        {showHeader && <DiffHeader filePath={filePath} stats={stats} showStats={showStats} />}
        <div className="px-3 py-2 text-xs text-gray-500">No changes</div>
      </div>
    );
  }

  return (
    <div className="rounded border border-gray-800 bg-gray-900 overflow-hidden">
      {showHeader && <DiffHeader filePath={filePath} stats={stats} showStats={showStats} />}
      <div className="max-h-[50vh] overflow-auto">
        <table className="font-mono text-[11px] leading-tight w-full">
          <tbody>
            {rows.map((row, i) => {
              const bg =
                row.type === 'add' ? 'bg-green-900/30' :
                row.type === 'remove' ? 'bg-red-900/30' :
                '';
              const textColor =
                row.type === 'add' ? 'text-green-200' :
                row.type === 'remove' ? 'text-red-200' :
                'text-gray-400';
              const marker = row.type === 'add' ? '+' : row.type === 'remove' ? '-' : ' ';
              const oldGutter = row.type === 'add' ? '' : String(row.oldLine);
              const newGutter = row.type === 'remove' ? '' : String(row.newLine);
              return (
                <tr key={i} className={bg}>
                  <td className="select-none text-right text-gray-600 px-2 w-[3.5em] border-r border-gray-800/60">{oldGutter}</td>
                  <td className="select-none text-right text-gray-600 px-2 w-[3.5em] border-r border-gray-800/60">{newGutter}</td>
                  <td className={`select-none ${textColor} px-1 w-[1.5em] text-center`}>{marker}</td>
                  <td className={`${textColor} pr-3 whitespace-pre`}>{row.content || ' '}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DiffHeader({ filePath, stats, showStats }: { filePath: string; stats: { added: number; removed: number }; showStats: boolean }) {
  return (
    <div className="px-3 py-1.5 bg-gray-950/60 border-b border-gray-800 flex items-center gap-2 text-xs">
      <span className="text-gray-300 font-mono truncate flex-1 min-w-0">{filePath}</span>
      {showStats && (
        <span className="shrink-0 flex items-center gap-2 font-mono text-[10px]">
          {stats.added > 0 && <span className="text-green-400">+{stats.added}</span>}
          {stats.removed > 0 && <span className="text-red-400">−{stats.removed}</span>}
        </span>
      )}
    </div>
  );
}
