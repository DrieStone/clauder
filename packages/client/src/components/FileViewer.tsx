import { useState, useEffect } from 'react';
import Markdown from 'react-markdown';

interface FileViewerProps {
  cwd: string;
  filePath: string;
  fileName: string;
  onBack: () => void;
}

export function FileViewer({ cwd, filePath, fileName, onBack }: FileViewerProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setContent(null);
    fetch(`/api/files/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(data => {
        if (data.error) setError(data.error);
        else setContent(data.content);
      })
      .catch((err) => setError(`Failed to load file: ${err.message}`))
      .finally(() => setLoading(false));
  }, [cwd, filePath]);

  const isMarkdown = fileName.toLowerCase().endsWith('.md');

  const renderContent = () => {
    if (loading) {
      return <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">Loading...</div>;
    }
    if (error) {
      return <div className="flex-1 flex items-center justify-center text-red-400 text-sm">{error}</div>;
    }
    if (content === null) {
      return <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">No content loaded</div>;
    }
    if (isMarkdown) {
      return (
        <div className="flex-1 overflow-y-auto p-4">
          <div className="prose prose-invert prose-sm max-w-none [&_pre]:bg-gray-900 [&_pre]:border [&_pre]:border-gray-700 [&_pre]:rounded [&_code]:text-xs">
            <Markdown>{content}</Markdown>
          </div>
        </div>
      );
    }
    return (
      <pre className="flex-1 overflow-y-auto p-4 text-sm text-gray-300 whitespace-pre-wrap font-mono">
        {content}
      </pre>
    );
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-800 shrink-0">
        <button
          onClick={onBack}
          className="text-gray-400 hover:text-gray-200 text-sm transition-colors"
        >
          &larr; Back
        </button>
        <span className="text-sm text-gray-300 truncate font-medium">{fileName}</span>
        {content !== null && (
          <span className="text-[10px] text-gray-600">{content.length} chars</span>
        )}
      </div>
      {renderContent()}
    </div>
  );
}
