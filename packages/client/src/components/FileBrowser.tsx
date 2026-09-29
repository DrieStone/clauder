import { useState, useEffect } from 'react';
import { FileViewer } from './FileViewer';
import { fileKind, fileIcon } from '../lib/fileKinds';

interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  path: string;
}

interface FileBrowserProps {
  cwd: string;
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

  // Trigger a browser download via a transient anchor — the endpoint sets
  // Content-Disposition: attachment, so this never navigates away.
  const downloadFile = (path: string) => {
    const a = document.createElement('a');
    a.href = `/api/files/download?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

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
            const kind = entry.type === 'directory' ? null : fileKind(entry.name);
            const viewable = entry.type === 'directory' || kind !== null;
            return (
              <div
                key={entry.path}
                role="button"
                tabIndex={0}
                onClick={() => {
                  if (entry.type === 'directory') {
                    setCurrentPath(entry.path);
                  } else if (kind !== null) {
                    setViewingFile({ path: entry.path, name: entry.name });
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  if (entry.type === 'directory') setCurrentPath(entry.path);
                  else if (kind !== null) setViewingFile({ path: entry.path, name: entry.name });
                }}
                className={`group w-full flex items-center gap-2 px-4 py-2 sm:py-1.5 text-sm text-left transition-colors ${
                  viewable ? 'hover:bg-gray-800/50 cursor-pointer' : 'cursor-default'
                }`}
              >
                <span className="text-gray-500 w-5 text-center shrink-0 text-xs">
                  {fileIcon(entry.type === 'directory' ? 'directory' : kind)}
                </span>
                <span className={`flex-1 min-w-0 truncate ${entry.type === 'directory' ? 'text-blue-400' : viewable ? 'text-gray-300' : 'text-gray-500'}`}>
                  {entry.name}
                </span>
                {entry.type === 'file' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); downloadFile(entry.path); }}
                    className="shrink-0 text-gray-500 hover:text-gray-200 opacity-60 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                    title={`Download ${entry.name}`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                    </svg>
                  </button>
                )}
              </div>
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
