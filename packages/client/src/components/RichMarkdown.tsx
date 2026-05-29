import { useState, useRef, useCallback, type HTMLAttributes } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeExternalLinks from 'rehype-external-links';

function CodeBlock({ children, ...props }: HTMLAttributes<HTMLPreElement>) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopy = useCallback(() => {
    const text = preRef.current?.textContent ?? '';
    if (!text) return;
    navigator.clipboard.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {/* clipboard write blocked — fail silently */});
  }, []);

  return (
    <div className="relative group">
      <pre ref={preRef} {...props}>{children}</pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy code"
        className="absolute top-1.5 right-1.5 px-1.5 py-0.5 text-[10px] bg-gray-700/80 hover:bg-gray-600 text-gray-200 rounded opacity-40 group-hover:opacity-100 transition-opacity"
      >
        {copied ? '✓ Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** Markdown renderer with GFM tables, safe external links, and a copy button on code blocks. */
export function RichMarkdown({ children }: { children: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }]]}
      components={{
        pre: CodeBlock,
        table: ({ children }) => (
          <div className="overflow-x-auto my-2">
            <table className="border-collapse text-xs min-w-full">{children}</table>
          </div>
        ),
      }}
    >{children}</Markdown>
  );
}
