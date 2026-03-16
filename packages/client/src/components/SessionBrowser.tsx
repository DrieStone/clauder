import { useEffect } from 'react';
import type { DiscoveredSession } from '@clauder/shared';
import { useSessions } from '../context/SessionContext';

export function SessionBrowser() {
  const { state, discoverSessions, resumeDiscovered, setShowDiscovery } = useSessions();

  useEffect(() => {
    discoverSessions();
  }, [discoverSessions]);

  const formatDate = (ts: string | null) => {
    if (!ts) return 'Unknown';
    const d = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffHrs = diffMs / (1000 * 60 * 60);
    if (diffHrs < 1) return `${Math.round(diffMs / (1000 * 60))}m ago`;
    if (diffHrs < 24) return `${Math.round(diffHrs)}h ago`;
    const diffDays = Math.round(diffHrs / 24);
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  const projectName = (path: string) => {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  };

  // Group sessions by project
  const byProject = new Map<string, DiscoveredSession[]>();
  for (const s of state.discoveredSessions) {
    const existing = byProject.get(s.projectPath) || [];
    existing.push(s);
    byProject.set(s.projectPath, existing);
  }

  const handleResume = (session: DiscoveredSession) => {
    const name = `${projectName(session.projectPath)} (forked)`;
    resumeDiscovered(session.sessionId, name, session.projectPath);
    setShowDiscovery(false);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
          <div>
            <h2 className="text-lg font-semibold">Pick Up Existing Session</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Fork a session from VS Code or CLI. The original stays untouched.
            </p>
          </div>
          <button
            onClick={() => setShowDiscovery(false)}
            className="text-gray-400 hover:text-gray-200 text-xl leading-none"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {state.discoveryLoading ? (
            <div className="flex items-center justify-center py-12 text-gray-500 text-sm">
              Scanning sessions...
            </div>
          ) : state.discoveredSessions.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-gray-500 text-sm">
              No existing sessions found in ~/.claude/projects/
            </div>
          ) : (
            <div className="space-y-4">
              {Array.from(byProject.entries()).map(([projectPath, sessions]) => (
                <div key={projectPath}>
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="text-sm font-medium text-gray-300">{projectName(projectPath)}</h3>
                    <span className="text-xs text-gray-600 truncate">{projectPath}</span>
                  </div>

                  <div className="space-y-1.5">
                    {sessions.map((session) => (
                      <button
                        key={session.sessionId}
                        onClick={() => handleResume(session)}
                        className="w-full text-left bg-gray-800 hover:bg-gray-750 border border-gray-700 hover:border-gray-600 rounded-lg px-4 py-3 transition-colors cursor-pointer group"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            {session.firstUserMessage ? (
                              <p className="text-sm text-gray-200 truncate group-hover:text-white">
                                {session.firstUserMessage}
                              </p>
                            ) : (
                              <p className="text-sm text-gray-500 italic">No user messages</p>
                            )}
                            <div className="flex items-center gap-3 mt-1 text-xs text-gray-500">
                              <span>{session.messageCount.user} user / {session.messageCount.assistant} assistant msgs</span>
                              <span>{formatSize(session.fileSize)}</span>
                            </div>
                          </div>
                          <div className="text-xs text-gray-500 whitespace-nowrap">
                            {formatDate(session.lastTimestamp || session.lastModified)}
                          </div>
                        </div>
                        <div className="mt-1 text-xs text-gray-600 font-mono truncate">
                          {session.sessionId}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-gray-800 flex justify-between items-center">
          <button
            onClick={discoverSessions}
            disabled={state.discoveryLoading}
            className="text-xs text-blue-400 hover:text-blue-300 disabled:text-gray-600 transition-colors"
          >
            Refresh
          </button>
          <button
            onClick={() => setShowDiscovery(false)}
            className="px-4 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
