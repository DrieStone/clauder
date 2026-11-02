import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { SessionState, KeepWarmStatus } from '@clauder/shared';
import { formatTimeAgo } from '../lib/time';

// The warning before an expensive cold resume. A session's prompt cache lasts an hour; after that,
// its next message re-sends the whole conversation at the cache-write price. For a long one that's
// a few dollars of usage (AutoEdit: 903k tokens, about $7 at API rates), so the owner chooses:
// send anyway, or start fresh with a summary (server: SessionManager.sendFresh).

/** Warn at or above this many tokens (about $1.20 on Opus at the write price). */
const WARN_TOKENS = 150_000;
const CACHE_MS = 60 * 60 * 1000;
/** Cache-write price per million tokens: 2x each model's input price. */
const WRITE_PER_MTOK: Record<string, number> = {
  'claude-fable-5-1': 16,
  'claude-opus-5-5': 8,
  'claude-sonnet-5-5': 4,
  'claude-haiku-5-5': 1, // its over-100K rate, which a conversation this size pays
};

export interface ColdResumeInfo { tokens: number; usd: number; idleSince: string }

/** What sending to this session now would re-send, if that's worth a warning; null otherwise. */
export function coldResumeInfo(s: SessionState, keepWarm: KeepWarmStatus | null | undefined, now = Date.now()): ColdResumeInfo | null {
  const tokens = s.promptTokens ?? 0;
  if (!s.sdkSessionId || tokens < WARN_TOKENS || s.status === 'working') return null;
  if (keepWarm?.sessions?.includes(s.id)) return null; // kept warm by pings
  if (now - Date.parse(s.lastActiveAt) < CACHE_MS) return null;
  const rate = WRITE_PER_MTOK[s.config.model ?? ''] ?? 8;
  return { tokens, usd: (tokens / 1e6) * rate, idleSince: s.lastActiveAt };
}

export function ColdResumeDialog({ info, onChoose }: { info: ColdResumeInfo; onChoose: (c: 'send' | 'fresh' | 'cancel') => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onChoose('cancel'); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onChoose]);
  const k = Math.round(info.tokens / 1000);
  return createPortal(
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-end sm:items-center justify-center p-3" onClick={(e) => { if (e.target === e.currentTarget) onChoose('cancel'); }}>
      <div role="dialog" aria-label="This conversation has gone cold" className="w-full max-w-md bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-4 space-y-3 text-sm text-gray-300">
        <h2 className="text-base font-semibold text-gray-100">🧊 This conversation has gone cold</h2>
        <p>
          Last active {formatTimeAgo(info.idleSince)}, so its cache has expired. Sending now re-sends the whole
          conversation, about <span className="text-gray-100">{k.toLocaleString()}k tokens</span> (around{' '}
          <span className="text-amber-300">${info.usd < 10 ? info.usd.toFixed(2) : Math.round(info.usd)}</span> at API rates, from your subscription usage).
        </p>
        <p className="text-xs text-gray-500">
          Starting fresh gives Claude a short summary instead and lets it look up the old conversation when it needs a detail. The chat here stays as it is.
        </p>
        <div className="flex flex-col sm:flex-row gap-2 pt-1">
          <button onClick={() => onChoose('fresh')} className="flex-1 px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium">Start fresh with a summary</button>
          <button onClick={() => onChoose('send')} className="flex-1 px-3 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-100">Send anyway</button>
          <button onClick={() => onChoose('cancel')} className="px-3 py-2 rounded-lg text-gray-400 hover:text-gray-200">Cancel</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
