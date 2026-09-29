import { useEffect, useState } from 'react';
import type { SessionConfig as SessionConfigType } from '@clauder/shared';
import { projectFolderProblem, suggestProjectFolder } from '@clauder/shared';
import { MODELS } from './ModelEffortSelector';

interface SessionConfigProps {
  onSubmit: (config: SessionConfigType, opts?: { projectFolder?: string }) => void;
  onCancel: () => void;
}

/** Where the session runs: a new folder in the dev root, named rather than typed as a path, or any
 *  existing folder by path. The last choice is remembered. */
type Where = 'new' | 'existing';
const WHERE_KEY = 'clauder.newSession.where';

/** GET /api/projects. 'unavailable' means the server predates it and needs a restart. */
interface DevRoot { root: string; display: string; folders: string[] }

const inputClass = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500';

export function SessionConfigForm({ onSubmit, onCancel }: SessionConfigProps) {
  const [name, setName] = useState('');
  const [where, setWhere] = useState<Where>(() => (localStorage.getItem(WHERE_KEY) === 'existing' ? 'existing' : 'new'));
  const [cwd, setCwd] = useState('');
  // null = follow the session name; a string once the folder name is edited by hand.
  const [folder, setFolder] = useState<string | null>(null);
  const [devRoot, setDevRoot] = useState<DevRoot | 'loading' | 'unavailable'>('loading');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [controllerMode, setControllerMode] = useState(false);

  useEffect(() => {
    let live = true;
    fetch('/api/projects')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: DevRoot) => { if (live) setDevRoot(d); })
      .catch(() => { if (live) setDevRoot('unavailable'); });
    return () => { live = false; };
  }, []);

  const chooseWhere = (w: Where) => {
    setWhere(w);
    localStorage.setItem(WHERE_KEY, w);
  };

  const folderValue = folder ?? suggestProjectFolder(name);
  const folderName = folderValue.trim();
  const folderProblem = projectFolderProblem(folderName);
  const root = typeof devRoot === 'object' ? devRoot : null;
  // The dev folder sits on a case-insensitive disk: "mustangdrift" IS the existing "MustangDrift".
  const existing = root?.folders.find(f => f.toLowerCase() === folderName.toLowerCase());
  const projectFolder = existing ?? folderName;

  const canSubmit = !!name.trim() && (where === 'new' ? !!root && !folderProblem : !!cwd.trim());

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const config: SessionConfigType = {
      name: name.trim(),
      // For a new project the server picks the path (and creates the folder); this is where it'll be.
      cwd: where === 'new' && root ? `${root.root}/${projectFolder}` : cwd.trim(),
    };
    if (model.trim()) config.model = model.trim();
    if (effort.trim()) config.effort = effort.trim() as any;
    if (systemPrompt.trim()) config.systemPrompt = systemPrompt.trim();
    if (controllerMode) config.controllerMode = true;

    onSubmit(config, where === 'new' ? { projectFolder } : undefined);
  };

  const folderNote = devRoot === 'loading'
    ? { text: 'Checking the dev folder…', tone: 'text-gray-500' }
    : devRoot === 'unavailable'
      ? { text: 'New-project folders turn on after Clauder restarts.', tone: 'text-amber-400' }
      : !folderName
        ? { text: `Creates a new folder in ${devRoot.display}`, tone: 'text-gray-500' }
        : folderProblem
          ? { text: folderProblem, tone: 'text-red-400' }
          : existing
            ? { text: `${devRoot.display}/${existing} already exists — the session will open it.`, tone: 'text-amber-400' }
            : { text: `Creates ${devRoot.display}/${folderName}`, tone: 'text-green-400' };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <form
        onSubmit={handleSubmit}
        className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md shadow-2xl"
      >
        <h2 className="text-lg font-semibold mb-4">New Session</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Session Name *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Frontend refactor"
              className={inputClass}
              autoFocus
            />
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 mb-1">
              <span className="text-xs font-medium text-gray-400">Working Directory *</span>
              <div className="flex rounded-md border border-gray-700 bg-gray-800 p-0.5 text-[11px]">
                {(['new', 'existing'] as const).map(w => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => chooseWhere(w)}
                    aria-pressed={where === w}
                    className={`px-2.5 py-1 sm:py-0.5 rounded transition-colors ${where === w ? 'bg-gray-700 text-gray-100' : 'text-gray-400 hover:text-gray-200'}`}
                  >
                    {w === 'new' ? 'New project' : 'Existing folder'}
                  </button>
                ))}
              </div>
            </div>
            {where === 'new' ? (
              <>
                <input
                  type="text"
                  value={folderValue}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="Folder name, e.g. MustangDrift"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={devRoot === 'unavailable'}
                  className={`${inputClass} disabled:opacity-50`}
                />
                <p className={`mt-1 text-[11px] break-all ${folderNote.tone}`}>{folderNote.text}</p>
              </>
            ) : (
              <input
                type="text"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="e.g. /Users/you/projects/myapp"
                className={inputClass}
              />
            )}
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-400 mb-1">Model</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              >
                <option value="">Default</option>
                {MODELS.map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-gray-400 mb-1">Effort</label>
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
              >
                <option value="">Default</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="xhigh">Extra High</option>
                <option value="max">Max</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Additional Instructions (optional)</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="e.g. Focus on TypeScript best practices"
              className={`${inputClass} resize-none`}
              rows={2}
            />
          </div>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={controllerMode}
              onChange={(e) => setControllerMode(e.target.checked)}
              className="mt-0.5 accent-purple-500"
            />
            <div className="flex-1">
              <div className="text-xs font-medium text-purple-300">Controller mode</div>
              <div className="text-[10px] text-gray-500">
                This session can orchestrate other sessions via MCP tools (list, send, wait, read). Use for overnight automation.
              </div>
            </div>
          </label>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSubmit}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Create Session
          </button>
        </div>
      </form>
    </div>
  );
}
