import { useMemo } from 'react';

interface WriteFileViewProps {
  filePath: string;
  content: string;
}

export function WriteFileView({ filePath, content }: WriteFileViewProps) {
  const lines = useMemo(() => content.split('\n'), [content]);
  // Drop trailing empty line from terminal \n so the gutter doesn't show a phantom line
  const displayLines = lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;

  return (
    <div className="rounded border border-gray-800 bg-gray-900 overflow-hidden">
      <div className="px-3 py-1.5 bg-gray-950/60 border-b border-gray-800 flex items-center gap-2 text-xs">
        <span className="text-gray-300 font-mono truncate flex-1 min-w-0">{filePath}</span>
        <span className="shrink-0 font-mono text-[10px] text-green-400">+{displayLines.length}</span>
      </div>
      <div className="max-h-[50vh] overflow-auto">
        <table className="font-mono text-[11px] leading-tight w-full">
          <tbody>
            {displayLines.map((line, i) => (
              <tr key={i} className="bg-green-900/20">
                <td className="select-none text-right text-gray-600 px-2 w-[3.5em] border-r border-gray-800/60">{i + 1}</td>
                <td className="select-none text-green-300 px-1 w-[1.5em] text-center">+</td>
                <td className="text-green-200 pr-3 whitespace-pre">{line || ' '}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
