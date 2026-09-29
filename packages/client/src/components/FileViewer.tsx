import { useState, useEffect } from 'react';
import { RichMarkdown } from './RichMarkdown';
import { ZoomableImage } from './ZoomableImage';
import { fileKind } from '../lib/fileKinds';

interface FileViewerProps {
  cwd: string;
  filePath: string;
  fileName: string;
  onBack: () => void;
}

export function FileViewer({ cwd, filePath, fileName, onBack }: FileViewerProps) {
  const kind = fileKind(fileName);
  const rawUrl = `/api/files/raw?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-800 shrink-0">
        <button
          onClick={onBack}
          className="text-gray-400 hover:text-gray-200 text-sm transition-colors shrink-0"
        >
          &larr; Back
        </button>
        <span className="text-sm text-gray-300 truncate font-medium flex-1">{fileName}</span>
        <a
          href={`/api/files/download?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`}
          download={fileName}
          className="text-[10px] text-gray-500 hover:text-gray-300 shrink-0"
          title={`Download ${fileName}`}
        >
          Download ↓
        </a>
        {(kind === 'image' || kind === 'video') && (
          <a
            href={rawUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-gray-500 hover:text-gray-300 shrink-0"
            title="Open in a new tab"
          >
            Open ↗
          </a>
        )}
      </div>
      {kind === 'image' ? (
        <ImageView src={rawUrl} name={fileName} />
      ) : kind === 'video' ? (
        <VideoView src={rawUrl} />
      ) : (
        <TextView cwd={cwd} filePath={filePath} fileName={fileName} />
      )}
    </div>
  );
}

function ImageView({ src, name }: { src: string; name: string }) {
  const [error, setError] = useState(false);
  return (
    <div className="flex-1 overflow-hidden p-4 flex items-center justify-center bg-gray-950">
      {error ? (
        <div className="text-red-400 text-sm">Failed to load image</div>
      ) : (
        <ZoomableImage
          src={src}
          alt={name}
          onError={() => setError(true)}
          className="max-w-full max-h-full object-contain rounded"
        />
      )}
    </div>
  );
}

function VideoView({ src }: { src: string }) {
  const [error, setError] = useState(false);
  return (
    <div className="flex-1 overflow-auto p-4 flex items-center justify-center bg-black">
      {error ? (
        <div className="text-red-400 text-sm">Failed to load video (the browser may not support this format)</div>
      ) : (
        <video
          src={src}
          controls
          playsInline
          onError={() => setError(true)}
          className="max-w-full max-h-full rounded"
        />
      )}
    </div>
  );
}

function TextView({ cwd, filePath, fileName }: { cwd: string; filePath: string; fileName: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setContent(null);
    fetch(`/api/files/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`)
      .then(async (r) => {
        // Parse the body even on a non-2xx — the server sends a real {error} message
        // (e.g. "File not found", "Not a viewable text file") that's far more useful
        // than a bare status code.
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
        return data;
      })
      .then(data => {
        if (data.error) setError(data.error);
        else setContent(data.content);
      })
      .catch((err) => setError(`Failed to load file: ${err.message}`))
      .finally(() => setLoading(false));
  }, [cwd, filePath]);

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">Loading...</div>;
  }
  if (error) {
    return <div className="flex-1 flex items-center justify-center text-red-400 text-sm">{error}</div>;
  }
  if (content === null) {
    return <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">No content loaded</div>;
  }
  if (fileName.toLowerCase().endsWith('.md')) {
    return (
      <div className="flex-1 overflow-y-auto p-4">
        {/* RichMarkdown (the chat renderer) rather than bare react-markdown: brings GFM
            (pipe tables are an extension, not core CommonMark — bare Markdown rendered them
            as plain text), and wraps every table in an overflow-x-auto container so a wide
            table scrolls horizontally within the pane instead of blowing out the page width
            (which it did on mobile). */}
        <div className="prose prose-invert prose-sm max-w-none break-words [&_pre]:bg-gray-900 [&_pre]:border [&_pre]:border-gray-700 [&_pre]:rounded [&_code]:text-xs [&_th]:border [&_th]:border-gray-700 [&_th]:bg-gray-900 [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:border-gray-700 [&_td]:px-2 [&_td]:py-1 [&_tr:nth-child(even)]:bg-gray-900/40">
          <RichMarkdown>{content}</RichMarkdown>
        </div>
      </div>
    );
  }
  return (
    <pre className="flex-1 overflow-auto p-4 text-sm text-gray-300 whitespace-pre-wrap font-mono">
      {content}
    </pre>
  );
}
