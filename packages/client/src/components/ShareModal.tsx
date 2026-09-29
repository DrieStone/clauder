import { useState } from 'react';
import type { SessionState, ShareLink } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';
import { copyText } from '../lib/copyText';

const RULES_PLACEHOLDER = "e.g. Don't change anything outside this project's folder. Copying files to iCloud Drive is fine.";

function timeAgo(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  return (
    <button
      type="button"
      onClick={async () => { setState((await copyText(text)) ? 'copied' : 'failed'); setTimeout(() => setState('idle'), 1500); }}
      className="shrink-0 px-2 py-1 text-[11px] rounded bg-gray-700 hover:bg-gray-600 text-gray-100"
    >
      {state === 'copied' ? '✓ Copied' : state === 'failed' ? 'Select & copy' : label}
    </button>
  );
}

function LinkRow({ link, url }: { link: ShareLink; url: string }) {
  const { updateShare, revokeShare } = useSessions();
  const [rules, setRules] = useState(link.rules);
  const dirty = rules.trim() !== link.rules.trim();
  return (
    <div className="border border-gray-700 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-100">{link.guestName}</span>
        <span className="text-[11px] text-gray-500">{link.lastUsedAt ? `last used ${timeAgo(link.lastUsedAt)}` : 'not used yet'}</span>
        <button
          onClick={() => { if (confirm(`Revoke ${link.guestName}'s link? They'll be disconnected right away.`)) revokeShare(link.id); }}
          className="ml-auto text-[11px] text-red-300 hover:text-red-200"
        >
          Revoke
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input readOnly value={url} onFocus={(e) => e.target.select()} className="flex-1 min-w-0 text-[11px] font-mono text-gray-300 bg-gray-800/60 border border-gray-700 rounded px-2 py-1" />
        <CopyButton text={url} />
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Rules for {link.guestName}</div>
        <textarea
          value={rules}
          onChange={(e) => setRules(e.target.value)}
          rows={2}
          placeholder={RULES_PLACEHOLDER}
          className="w-full resize-y text-xs text-gray-200 bg-gray-800/60 border border-gray-700 rounded px-2 py-1.5 placeholder-gray-600 focus:outline-none focus:border-blue-500"
        />
        {dirty && (
          <div className="flex justify-end gap-2 mt-1">
            <button onClick={() => setRules(link.rules)} className="px-2 py-1 text-[11px] text-gray-400 hover:text-gray-200">Cancel</button>
            <button onClick={() => updateShare(link.id, { rules })} className="px-2 py-1 text-[11px] rounded bg-blue-600 hover:bg-blue-500 text-white">Save rules</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Share one session with a named guest on the local network. Each link carries a secret token, lasts
 *  until revoked, and tells Claude who's writing and the rules for them (server: shares.ts). */
export function ShareModal({ session, onClose }: { session: SessionState; onClose: () => void }) {
  const { state, createShare, logEvent } = useSessions();
  const links = state.shares.filter(s => s.sessionId === session.id);
  const base = state.shareBaseUrl ?? `${window.location.protocol}//${window.location.host}`;
  const [name, setName] = useState('');
  const [rules, setRules] = useState('');
  const [ownerLink, setOwnerLink] = useState<string | null>(null);

  const create = () => {
    if (!name.trim()) return;
    createShare(session.id, name.trim(), rules.trim());
    logEvent('share_create');
    setName('');
    setRules('');
  };

  const showOwnerLink = async () => {
    try {
      const res = await fetch('/api/owner-link');
      if (res.ok) setOwnerLink((await res.json()).url);
    } catch { /* stays hidden */ }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold truncate">🔗 Share “{session.config.name}”</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200 text-xl leading-none w-7 h-7 flex items-center justify-center hover:bg-gray-800 rounded">×</button>
        </div>
        <div className="p-4 space-y-4 overflow-y-auto">
          {links.length > 0 && (
            <div className="space-y-2">
              {links.map(link => <LinkRow key={link.id} link={link} url={`${base}/s/${link.token}`} />)}
            </div>
          )}

          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-gray-500">New link</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
              placeholder="Who it's for, e.g. Lisa"
              maxLength={40}
              className="w-full text-sm text-gray-100 bg-gray-800/60 border border-gray-700 rounded px-2 py-1.5 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <textarea
              value={rules}
              onChange={(e) => setRules(e.target.value)}
              rows={2}
              placeholder={`Rules for them (optional). ${RULES_PLACEHOLDER}`}
              className="w-full resize-y text-xs text-gray-200 bg-gray-800/60 border border-gray-700 rounded px-2 py-1.5 placeholder-gray-600 focus:outline-none focus:border-blue-500"
            />
            <div className="flex justify-end">
              <button onClick={create} disabled={!name.trim()} className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white">Create link</button>
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-gray-500">
            A link works for anyone on your Wi-Fi who has it, until you revoke it. They see this whole
            session, including tool output, and can send messages. Claude is told who wrote each
            message and your rules for that person. It follows them, but they're instructions, not a
            sandbox: with permission prompts off, Claude can still run commands on this Mac.
          </p>

          <div className="border-t border-gray-800 pt-3 space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-gray-500">Your own devices</div>
            <p className="text-[11px] leading-relaxed text-gray-500">
              This Mac and your Tailscale devices always have full access. For another device of yours on
              Wi-Fi, open your owner link on it once. Anyone with it gets full access, so keep it to yourself.
            </p>
            {ownerLink ? (
              <div className="flex items-center gap-2">
                <input readOnly value={ownerLink} onFocus={(e) => e.target.select()} className="flex-1 min-w-0 text-[11px] font-mono text-gray-300 bg-gray-800/60 border border-gray-700 rounded px-2 py-1" />
                <CopyButton text={ownerLink} />
              </div>
            ) : (
              <button onClick={showOwnerLink} className="text-[11px] text-blue-300 hover:text-blue-200">Show my owner link</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
