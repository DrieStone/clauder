import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { GitStatus } from '@clauder/shared';

/** The chip is desktop-only; phones skip the requests entirely. */
const DESKTOP = '(min-width: 1024px)';

function timeAgo(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const date = new Date(iso);
  const otherYear = date.getFullYear() !== new Date().getFullYear();
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(otherYear ? { year: 'numeric' } : {}) });
}

function BranchIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden="true">
      <circle cx="4.5" cy="3.5" r="1.75" />
      <circle cx="4.5" cy="12.5" r="1.75" />
      <circle cx="11.5" cy="5.5" r="1.75" />
      <path d="M4.5 5.25v5.5M11.5 7.25c0 2.5-2.5 3-7 3.5" />
    </svg>
  );
}

/** Session header chip: whether the session's folder is in git, when it was last committed, and
 *  whether anything isn't backed up yet — uncommitted files, commits no remote has, or no remote at
 *  all. Refreshes when the session opens, when a turn ends (Claude may have committed), on window
 *  focus, and every 2 minutes. Memoized: SessionView re-renders on every WS message. */
export const GitIndicator = memo(function GitIndicator({ sessionId, working }: { sessionId: string; working: boolean }) {
  const [git, setGit] = useState<GitStatus | null>(null);
  const currentId = useRef(sessionId);

  const load = useCallback(() => {
    if (!window.matchMedia(DESKTOP).matches) return;
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/git`)
      .then(r => (r.ok ? r.json() : null))
      .then((g: GitStatus | null) => {
        // Ignore a late reply for the session we just switched away from.
        if (currentId.current === sessionId && g && typeof g.isRepo === 'boolean') setGit(g);
      })
      .catch(() => { /* a server without the endpoint: stay hidden */ });
  }, [sessionId]);

  useEffect(() => {
    currentId.current = sessionId;
    setGit(null);
    load();
  }, [sessionId, load]);

  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) load();
    wasWorking.current = working;
  }, [working, load]);

  useEffect(() => {
    window.addEventListener('focus', load);
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 120_000);
    return () => { window.removeEventListener('focus', load); clearInterval(timer); };
  }, [load]);

  if (!git) return null;

  if (!git.isRepo) {
    return (
      <span
        className="hidden lg:inline-flex items-center gap-1 ml-auto text-[11px] text-gray-500 shrink-0"
        title="This session's folder isn't in a git repository, so nothing here is versioned or backed up."
      >
        <BranchIcon className="w-3 h-3" /> No repo
      </span>
    );
  }

  const changed = git.changedFiles;
  const unpushed = git.unpushedCommits ?? 0;
  const noRemote = !git.remoteLabel;
  const atRisk = changed > 0 || unpushed > 0 || noRemote;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const tooltip = [
    noRemote
      ? `Local repository${git.branch ? ` · ${git.branch}` : ''}: no remote, so it isn't backed up anywhere`
      : `${git.remoteLabel}${git.branch ? ` · ${git.branch}` : ''}`,
    git.lastCommitAt
      ? `Last commit ${new Date(git.lastCommitAt).toLocaleString()}${git.lastCommitSubject ? `: ${git.lastCommitSubject}` : ''}`
      : 'No commits yet',
    changed > 0 ? `${plural(changed, 'file')} with uncommitted changes` : 'No uncommitted changes',
    noRemote ? null : unpushed > 0 ? `${plural(unpushed, 'commit')} not pushed` : 'All commits pushed',
    `Checked ${new Date(git.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${git.remoteWebUrl ? ' · click to open' : ''}`,
  ].filter(Boolean).join('\n');

  const body = (
    <>
      <BranchIcon className={`w-3 h-3 shrink-0 ${atRisk ? 'text-amber-400' : 'text-emerald-400'}`} />
      <span className="text-gray-300 truncate max-w-[10rem]">{noRemote ? 'local repo' : git.remoteLabel!.split('/').pop()}</span>
      <span className="text-gray-500 whitespace-nowrap">· {git.lastCommitAt ? `committed ${timeAgo(git.lastCommitAt)}` : 'no commits'}</span>
      {changed > 0 && <span className="text-amber-400 whitespace-nowrap">· {changed} uncommitted</span>}
      {unpushed > 0 && <span className="text-amber-400 whitespace-nowrap">· {unpushed} unpushed</span>}
      {noRemote && <span className="text-amber-400 whitespace-nowrap">· no remote</span>}
    </>
  );
  const className = 'hidden lg:inline-flex items-center gap-1 ml-auto min-w-0 text-[11px]';
  return git.remoteWebUrl ? (
    <a href={git.remoteWebUrl} target="_blank" rel="noopener noreferrer" className={`${className} hover:underline`} title={tooltip}>{body}</a>
  ) : (
    <span className={className} title={tooltip}>{body}</span>
  );
});
