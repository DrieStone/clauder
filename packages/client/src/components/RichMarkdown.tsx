import { memo, useState, useRef, useCallback, type HTMLAttributes } from 'react';
import Markdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeExternalLinks from 'rehype-external-links';

const VALID_HREF_RE = /^(https?:|mailto:|tel:)/i;
// A markdown link-syntax boundary "](" leaked INTO an href is a near-certain sign of
// doubled-up/nested link syntax ("[[text](url)](url)", which CommonMark doesn't support — a
// link can't contain a link) that the parser mangled into the URL. That "]" immediately
// followed by "(" essentially never occurs in a legitimate URL. Crucially, react-markdown
// URL-ENCODES the brackets before a custom <a> component sees the href, so we must match the
// encoded forms (%5D = "]", %28 = "(") too — matching only literal "]" / "(" silently misses
// it (which is exactly the bug this guards against). Catches it even when the href still
// starts with a valid scheme, e.g. "https://x.com/a/%5Btext%5D(https://x.com/a)".
const MALFORMED_LINK_RE = /(\]|%5[Dd])(\(|%28)/;

/** Guards against malformed markdown links rendering as normal-looking, silently-dead links.
 *  The other common failure shape: the garbage href doesn't start with a real scheme at all,
 *  so the browser resolves it AGAINST CLAUDER'S OWN ORIGIN — producing a dead
 *  http://localhost:3001/... link that looks completely normal until you click it. Either way,
 *  render as plain, clearly-non-clickable text instead of a link that goes nowhere/wrong. */
function SafeLink({ href, children, ...props }: HTMLAttributes<HTMLAnchorElement> & { href?: string }) {
  if (!href || !VALID_HREF_RE.test(href) || MALFORMED_LINK_RE.test(href)) {
    return <span className="text-gray-400 underline decoration-dotted" title="Malformed link — not clickable">{children}</span>;
  }
  return <a href={href} {...props}>{children}</a>;
}

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

function ScrollTable({ children }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto my-2">
      <table className="border-collapse text-xs min-w-full">{children}</table>
    </div>
  );
}

// Module-level so every render hands react-markdown the same plugins and components. An inline
// `table` component was a new component type each render, so React rebuilt every table's DOM.
const REMARK_PLUGINS: Options['remarkPlugins'] = [remarkGfm];
const REHYPE_PLUGINS: Options['rehypePlugins'] = [[rehypeExternalLinks, { target: '_blank', rel: ['noopener', 'noreferrer'] }]];
const COMPONENTS: Components = { pre: CodeBlock, a: SafeLink, table: ScrollTable };

/** Markdown renderer with GFM tables, safe external links, and a copy button on code blocks.
 *  Memoized on the text: parsing is the expensive part, and a message rarely changes once written. */
export const RichMarkdown = memo(function RichMarkdown({ children }: { children: string }) {
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>
      {children}
    </Markdown>
  );
});
