import { execFile } from 'child_process';
import type { GitStatus } from '@clauder/shared';

/** Results are reused briefly: the header asks on open, at every turn end, and on window focus. */
const CACHE_MS = 10_000;
/** Hosts whose repo pages live at https://<host>/<owner>/<repo>, whatever the remote's protocol. */
const WEB_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

/** git in `cwd`. GIT_OPTIONAL_LOCKS=0 keeps `git status` off the index lock, since a session may be
 *  committing in the same repo at that moment; the timeout keeps a slow repo from stalling the request. */
function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 5_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** A remote URL as something safe to show: "owner/repo" (host-prefixed off GitHub) and a browser
 *  link. Handles https://, ssh:// and scp-style git@host:path remotes, and drops any credentials
 *  embedded in the URL; the raw URL never leaves the server. */
export function describeRemote(url: string): { label: string; webUrl: string | null } {
  const raw = url.trim();
  let host = '';
  let path = '';
  let web: string | null = null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      host = u.hostname;
      path = u.pathname;
      if (u.protocol === 'https:' || u.protocol === 'http:') web = `${u.protocol}//${u.host}`; // u.host carries no credentials
    } catch { /* unparseable — shown as a local remote */ }
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(raw);
    if (scp) { host = scp[1]; path = scp[2]; }
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (!host || !path) return { label: 'local remote', webUrl: null };
  if (!web && WEB_HOSTS.has(host)) web = `https://${host}`;
  return { label: host === 'github.com' ? path : `${host}/${path}`, webUrl: web ? `${web}/${path}` : null };
}

async function readGitStatus(cwd: string): Promise<GitStatus> {
  const checkedAt = new Date().toISOString();
  const none: GitStatus = {
    isRepo: false, branch: null, remoteLabel: null, remoteWebUrl: null,
    lastCommitAt: null, lastCommitSubject: null, changedFiles: 0, unpushedCommits: null, checkedAt,
  };
  let status: string;
  try {
    status = await git(cwd, ['status', '--porcelain=v2', '--branch']);
  } catch {
    return none; // not a repository, a missing folder, or no git
  }
  const [log, remotes, unpushed] = await Promise.all([
    git(cwd, ['log', '-1', '--format=%cI%x00%s']).catch(() => ''), // fails on a repo with no commits
    git(cwd, ['config', '--get-regexp', '^remote\\..*\\.url$']).catch(() => ''), // exits 1 with no remotes
    git(cwd, ['rev-list', '--count', 'HEAD', '--not', '--remotes']).catch(() => ''),
  ]);

  let branch: string | null = null;
  let changedFiles = 0;
  for (const line of status.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim();
      branch = head === '(detached)' ? null : head;
    } else if (line && !line.startsWith('#')) {
      changedFiles++;
    }
  }
  const [lastCommitAt, lastCommitSubject] = log.replace(/\n$/, '').split('\0');
  const urls = remotes.split('\n').map(l => /^remote\.(.+)\.url\s+(.+)$/.exec(l.trim())).filter((m): m is RegExpExecArray => !!m);
  const remote = urls.find(m => m[1] === 'origin') ?? urls[0];
  const described = remote ? describeRemote(remote[2]) : null;
  const unpushedCount = Number.parseInt(unpushed.trim(), 10);

  return {
    ...none,
    isRepo: true,
    branch,
    remoteLabel: described?.label ?? null,
    remoteWebUrl: described?.webUrl ?? null,
    lastCommitAt: lastCommitAt || null,
    lastCommitSubject: lastCommitSubject || null,
    changedFiles,
    // Commits no remote-tracking branch has, as of the last fetch or push. Meaningless with no
    // remote (it would count every commit), so left null there.
    unpushedCommits: remote && Number.isFinite(unpushedCount) ? unpushedCount : null,
  };
}

const cache = new Map<string, { at: number; result: Promise<GitStatus> }>();

/** Version-control state of a folder, for the session header's repo indicator. Never rejects. */
export function getGitStatus(cwd: string): Promise<GitStatus> {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const result = readGitStatus(cwd);
  cache.set(cwd, { at: Date.now(), result });
  return result;
}
