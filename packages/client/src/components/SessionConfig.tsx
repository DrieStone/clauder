import { useState } from 'react';
import type { SessionConfig as SessionConfigType } from '@clauder/shared';

interface SessionConfigProps {
  onSubmit: (config: SessionConfigType) => void;
  onCancel: () => void;
}

export function SessionConfigForm({ onSubmit, onCancel }: SessionConfigProps) {
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !cwd.trim()) return;

    const config: SessionConfigType = {
      name: name.trim(),
      cwd: cwd.trim(),
    };
    if (model.trim()) config.model = model.trim();
    if (systemPrompt.trim()) config.systemPrompt = systemPrompt.trim();

    onSubmit(config);
  };

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
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Working Directory *</label>
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="e.g. /Users/you/projects/myapp"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Model (optional)</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
            >
              <option value="">Default</option>
              <option value="claude-opus-4-6">Claude Opus 4.6</option>
              <option value="claude-sonnet-4-6">Claude Sonnet 4.6</option>
              <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Additional Instructions (optional)</label>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="e.g. Focus on TypeScript best practices"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
              rows={2}
            />
          </div>
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
            disabled={!name.trim() || !cwd.trim()}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Create Session
          </button>
        </div>
      </form>
    </div>
  );
}
