import { useState, useEffect } from 'react';
import { FileViewer } from './FileViewer';

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
}

interface FileBrowserProps {
  cwd: string;
}

const VIEWABLE_EXTENSIONS = new Set(['.md', '.txt']);

function isViewable(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return VIEWABLE_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

export function FileBrowser({ cwd }: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<{ path: string; name: string } | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/files/list?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(currentPath)}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) setError(data.error);
        else setEntries(data.entries);
      })
      .catch(() => setError('Failed to load directory'))
      .finally(() => setLoading(false));
  }, [cwd, currentPath]);

  if (viewingFile) {
    return (
      <FileViewer
        cwd={cwd}
        filePath={viewingFile.path}
        fileName={viewingFile.name}
        onBack={() => setViewingFile(null)}
      />
    );
  }

  const isRoot = currentPath === '';
  const parentPath = currentPath.includes('/')
    ? currentPath.slice(0, currentPath.lastIndexOf('/'))
    : '';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Path bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 text-xs text-gray-400 shrink-0">
        {!isRoot && (
          <button
            onClick={() => setCurrentPath(parentPath)}
            className="text-gray-400 hover:text-gray-200 transition-colors shrink-0"
          >
            &larr; Up
          </button>
        )}
        <span className="truncate font-mono">{currentPath || '/'}</span>
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">Loading...</div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-red-400 text-sm">{error}</div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {entries.map(entry => {
            const viewable = entry.type === 'directory' || isViewable(entry.name);
            return (
              <button
                key={entry.path}
                onClick={() => {
                  if (entry.type === 'directory') {
                    setCurrentPath(entry.path);
                  } else if (isViewable(entry.name)) {
                    setViewingFile({ path: entry.path, name: entry.name });
                  }
                }}
                className={`w-full flex items-center gap-2 px-4 py-1.5 text-sm text-left transition-colors ${
                  viewable ? 'hover:bg-gray-800/50 cursor-pointer' : 'cursor-default opacity-50'
                }`}
              >
                <span className="text-gray-500 w-5 text-center shrink-0 text-xs">
                  {entry.type === 'directory' ? '\u{1F4C1}' : '\u{1F4C4}'}
                </span>
                <span className={entry.type === 'directory' ? 'text-blue-400' : 'text-gray-300'}>
                  {entry.name}
                </span>
              </button>
            );
          })}
          {entries.length === 0 && (
            <div className="flex items-center justify-center py-8 text-gray-500 text-sm">
              Empty directory
            </div>
          )}
        </div>
      )}
    </div>
  );
}
