import { useState, useEffect } from 'react';
import type { ApiCreditsSettings } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';
import { copyText } from '../lib/copyText';

// API credits (server/src/api-credits.ts): when the subscription is out of usage, sessions you've
// allowed keep working on your Anthropic API credit instead of sleeping. This panel holds the
// switch, the budgets, and what's been spent.

const SAVE_KEY_COMMAND = 'pbpaste > ~/.clauder/api-key && chmod 600 ~/.clauder/api-key';

const usd = (n: number) => `$${n.toFixed(2)}`;

function Meter({ label, spent, budget }: { label: string; spent: number; budget: number }) {
  const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 100;
  const color = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-emerald-500';
  return (
    <div>
      <div className="flex justify-between text-[11px] text-gray-400 mb-1">
        <span>{label}</span>
        <span className="tabular-nums text-gray-300">{usd(spent)} of {usd(budget)}</span>
      </div>
      <div className="h-1.5 rounded bg-gray-800 overflow-hidden"><div className={`h-full ${color}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

function Budget({ label, value, onSave, hint }: { label: string; value: number; onSave: (n: number) => void; hint?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text);
    if (!isFinite(n) || n < 0) { setText(String(value)); return; }
    if (n !== value) onSave(n);
  };
  return (
    <label className="block" title={hint}>
      <span className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">{label}</span>
      <span className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 focus-within:border-blue-500">
        <span className="text-gray-500 text-xs">$</span>
        <input
          value={text}
          inputMode="decimal"
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          className="w-full min-w-0 bg-transparent text-sm text-gray-100 outline-none tabular-nums"
        />
      </span>
    </label>
  );
}

function WorkspaceField({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const bad = text.trim() !== '' && !/^wrkspc_[A-Za-z0-9]{10,}$/.test(text.trim());
  return (
    <>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (!bad && text.trim() !== value) onSave(text.trim()); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        placeholder="wrkspc_01…  (Console → Settings → Workspaces)"
        className={`w-full bg-gray-800 border rounded px-2 py-1.5 text-sm text-gray-100 font-mono outline-none focus:border-blue-500 ${bad ? 'border-red-500' : 'border-gray-700'}`}
      />
      {bad && <span className="block text-[11px] text-red-300 mt-1">That doesn't look like a workspace ID (it starts with wrkspc_).</span>}
    </>
  );
}

export function ApiCreditsModal({ onClose }: { onClose: () => void }) {
  const { state, setApiCreditsSettings, setApiAllowed } = useSessions();
  const status = state.apiCredits;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = (patch: Partial<ApiCreditsSettings>) => setApiCreditsSettings(patch);
  const allowed = [...state.sessions.values()].filter(s => s.config.apiCredits && !s.config.mainSessionId);
  const sessionName = (id: string) => state.sessions.get(id)?.config.name;
  const today = new Date();
  const localDay = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-3 border-b border-gray-800 flex items-center justify-between shrink-0">
          <h2 className="text-sm font-semibold">💳 API credits</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200 text-xl leading-none w-7 h-7 flex items-center justify-center hover:bg-gray-800 rounded" aria-label="Close">×</button>
        </div>
        {!status ? (
          <div className="p-5 text-xs text-gray-400">This needs the Clauder server to be restarted with the API credits update.</div>
        ) : (
          <div className="p-4 space-y-4 overflow-y-auto text-xs text-gray-300">
            <p className="text-gray-400 leading-relaxed">
              When your subscription runs out of usage, a session you've allowed keeps working on your API credit instead of sleeping until it resets.
              Nothing uses it unless it's switched on here <em>and</em> the session is allowed (its ⚙ menu), or you press "Use API credits now" on a sleeping session. A guest's messages never use it.
            </p>

            {/* The key */}
            <div className="border border-gray-700 rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider text-gray-500">API key</span>
                {status.keyState === 'ok' && <span className="text-emerald-400">✓ saved (ends …{status.keyHint})</span>}
                {status.keyState === 'invalid' && <span className="text-amber-400">~/.clauder/api-key doesn't hold an Anthropic key</span>}
                {status.keyState === 'missing' && <span className="text-amber-400">not saved yet</span>}
              </div>
              {status.keyState !== 'ok' && (
                <>
                  <p className="text-gray-400 leading-relaxed">
                    Copy your key from the Anthropic Console, then run this in Terminal. It saves the key in a private file on this Mac, not in Clauder's settings or the repo.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 min-w-0 text-[11px] font-mono text-gray-200 bg-gray-800/70 border border-gray-700 rounded px-2 py-1 overflow-x-auto whitespace-nowrap">{SAVE_KEY_COMMAND}</code>
                    <button
                      onClick={async () => { setCopied(await copyText(SAVE_KEY_COMMAND)); setTimeout(() => setCopied(false), 1500); }}
                      className="shrink-0 px-2 py-1 text-[11px] rounded bg-gray-700 hover:bg-gray-600 text-gray-100"
                    >
                      {copied ? '✓ Copied' : 'Copy'}
                    </button>
                  </div>
                </>
              )}
              {status.blockedUntil && (
                <div className="text-amber-300">
                  {status.blockedReason === 'key'
                    ? 'Anthropic refused this key, so API credits are off until the key is replaced.'
                    : `The API account reported no credit, so API credits are paused until ${new Date(status.blockedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`}
                </div>
              )}
            </div>

            {/* The switch */}
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={status.settings.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
                className="mt-0.5 accent-blue-500"
              />
              <span>
                <span className="block text-sm text-gray-100">Use API credits when the subscription is out</span>
                <span className="block text-[11px] text-gray-500">
                  {status.subscriptionBlockedUntil
                    ? `The subscription is out of usage until ${new Date(status.subscriptionBlockedUntil).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}: allowed sessions are on API credits now.`
                    : 'The subscription has usage left, so nothing is running on API credits.'}
                </span>
              </span>
            </label>

            {/* Spend */}
            <div className="space-y-2">
              <Meter label="This month" spent={status.month === localDay.slice(0, 7) ? status.monthSpentUsd : 0} budget={status.settings.monthlyBudgetUsd} />
              <Meter label="Today" spent={status.day === localDay ? status.daySpentUsd : 0} budget={status.settings.dailyBudgetUsd} />
              <p className="text-[11px] text-gray-500">Spend is estimated from the CLI's own cost figure. Your Anthropic Console has the real balance.</p>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <Budget label="Monthly cap" value={status.settings.monthlyBudgetUsd} onSave={(n) => set({ monthlyBudgetUsd: n })} hint="Stop for the month at this much. Your credit is $200; the margin covers estimate error." />
              <Budget label="Daily cap" value={status.settings.dailyBudgetUsd} onSave={(n) => set({ dailyBudgetUsd: n })} />
              <Budget label="Per turn" value={status.settings.perTurnBudgetUsd} onSave={(n) => set({ perTurnBudgetUsd: n })} hint="One turn is cut off at this much; the work so far is kept." />
            </div>
            <label className="block">
              <span className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Model on API credits</span>
              <select
                value={status.settings.model}
                onChange={(e) => set({ model: e.target.value })}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              >
                <option value="session">The session's own model (Fable runs as Opus 5.5)</option>
                <option value="claude-opus-5-5">Opus 5.5 ($4 / $20 per million tokens)</option>
                <option value="claude-sonnet-5-5">Sonnet 5.5 ($2 / $10 per million tokens)</option>
              </select>
            </label>
            <label className="block">
              <span className="block text-[10px] uppercase tracking-wider text-gray-500 mb-1">Workspace ID (only if the key isn't tied to a workspace)</span>
              <WorkspaceField value={status.settings.workspaceId} onSave={(v) => set({ workspaceId: v })} />
            </label>
            <p className="text-[11px] text-gray-500 leading-relaxed">
              The first turn of a session on API credits re-reads the whole conversation at full price (the prompt cache doesn't carry over from your subscription), so a long conversation costs a few dollars to start. Effort is capped at "high".
            </p>

            {/* Who may use it */}
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Sessions allowed to use it</div>
              {allowed.length === 0 ? (
                <p className="text-gray-500">None. Allow a session from its ⚙ menu.</p>
              ) : (
                <ul className="space-y-1">
                  {allowed.map(s => (
                    <li key={s.id} className="flex items-center gap-2">
                      <span className="truncate flex-1">{s.config.name}</span>
                      {status.activeSessionIds.includes(s.id) && <span className="text-amber-300 text-[10px]">running on it now</span>}
                      <button onClick={() => setApiAllowed(s.id, false)} className="text-[11px] text-gray-400 hover:text-red-300">Stop allowing</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {status.recent.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Latest turns</div>
                <ul className="space-y-0.5">
                  {status.recent.slice(0, 6).map((r, i) => (
                    <li key={i} className="flex items-center gap-2 text-[11px]">
                      <span className="text-gray-500 w-14 shrink-0">{new Date(r.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                      <span className="truncate flex-1">{sessionName(r.sessionId) ?? r.name}</span>
                      <span className="tabular-nums text-gray-200">{usd(r.usd)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
