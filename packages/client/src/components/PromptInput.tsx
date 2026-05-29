import { useState, useCallback, useRef, useEffect, useMemo, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react';
import { useSessions } from '../context/SessionContext';
import type { ImageAttachment, Skill } from '@clauder/shared';
import { SkillDropdown } from './SkillDropdown';

const MAX_IMAGES = 4;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

interface PromptInputProps {
  sessionId: string;
  onSend: (message: string, images?: ImageAttachment[], planMode?: boolean) => void;
  onInterrupt: () => void;
  isWorking: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
}

export function PromptInput({ sessionId, onSend, onInterrupt, isWorking, draft, onDraftChange }: PromptInputProps) {
  const { updateLastActive, refreshSkills, state } = useSessions();
  const [value, setValue] = useState(draft);
  const prevSessionIdRef = useRef(sessionId);
  const [images, setImages] = useState<ImageAttachment[]>([]);

  // When switching sessions, restore the saved draft for the new session
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      setValue(draft);
    }
  }, [sessionId, draft]);
  const [dragOver, setDragOver] = useState(false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Skill dropdown state
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const skills = state.sessionSkills.get(sessionId) ?? [];

  // The token after the leading slash, e.g. "sim" when value is "/sim". Empty when
  // value doesn't start with "/" or is just "/". Stops at first whitespace so
  // "/sim foo" still narrows by "sim".
  const filter = value.startsWith('/') ? value.slice(1).split(/\s/)[0] : '';

  const filteredSkills = useMemo<Skill[]>(() => {
    if (!skills.length) return [];
    if (!filter) return skills;
    const lower = filter.toLowerCase();
    return skills.filter(s => s.name.toLowerCase().startsWith(lower));
  }, [skills, filter]);

  // Reset highlight when the filtered list shape changes
  useEffect(() => {
    setHighlightedIndex(0);
  }, [filter, skillsOpen]);

  // Auto-resize textarea to fit content
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const addImageFile = useCallback((file: File) => {
    if (file.size > MAX_IMAGE_SIZE) return;
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      setImages(prev => {
        if (prev.length >= MAX_IMAGES) return prev;
        return [...prev, { data: base64, mimeType: file.type }];
      });
    };
    reader.readAsDataURL(file);
  }, []);

  const handleSend = useCallback((planMode = false) => {
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    onSend(trimmed, images.length > 0 ? images : undefined, planMode);
    setValue('');
    onDraftChange('');
    setImages([]);
    setSkillsOpen(false);
  }, [value, images, onSend, onDraftChange]);

  const insertSkill = useCallback((skill: Skill) => {
    // Replace the leading "/<token>" (and an optional trailing space) with "/<name> "
    const rest = value.replace(/^\/[^\s]*\s?/, '');
    const next = `/${skill.name} ` + rest;
    setValue(next);
    onDraftChange(next);
    setSkillsOpen(false);
    // Refocus textarea so user can keep typing
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [value, onDraftChange]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // IME composition (CJK input) — let the IME handle the keys
      if (e.nativeEvent.isComposing) return;

      // Dropdown navigation takes priority when it's open and has matches
      if (skillsOpen && filteredSkills.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setHighlightedIndex(i => Math.min(i + 1, filteredSkills.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setHighlightedIndex(i => Math.max(i - 1, 0));
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setSkillsOpen(false);
          return;
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
          e.preventDefault();
          insertSkill(filteredSkills[highlightedIndex]);
          return;
        }
      }

      // Shift+Enter inserts newline; Cmd/Ctrl+Enter sends in plan mode; plain Enter sends normally
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend(e.metaKey || e.ctrlKey);
      }
    },
    [handleSend, skillsOpen, filteredSkills, highlightedIndex, insertSkill],
  );

  const handleChange = useCallback((next: string) => {
    setValue(next);
    onDraftChange(next);
    // Auto-open dropdown when the user starts a slash command; close otherwise
    if (next.startsWith('/')) setSkillsOpen(true);
    else setSkillsOpen(false);
  }, [onDraftChange]);

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData.items;
    let hasImage = false;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        hasImage = true;
        const file = item.getAsFile();
        if (file) addImageFile(file);
      }
    }
    if (hasImage) e.preventDefault();
  }, [addImageFile]);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer.files;
    for (const file of files) {
      addImageFile(file);
    }
  }, [addImageFile]);

  const removeImage = useCallback((index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleTyping = useCallback(() => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      updateLastActive(sessionId);
    }, 2000);
  }, [updateLastActive, sessionId]);

  const handleSkillButtonClick = useCallback(() => {
    // Open the picker. If textarea is empty, seed with "/" so the same flow works as auto-trigger.
    refreshSkills(sessionId); // defensive: re-scan in case .claude/commands/ changed since last broadcast
    if (!value) {
      setValue('/');
      onDraftChange('/');
    }
    setSkillsOpen(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [refreshSkills, sessionId, value, onDraftChange]);

  return (
    <div
      className={`border-t border-gray-800 p-3 ${dragOver ? 'bg-blue-900/20 border-blue-500' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Image previews */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-2">
          {images.map((img, i) => (
            <div key={i} className="relative group">
              <img
                src={`data:${img.mimeType};base64,${img.data}`}
                alt={`Attachment ${i + 1}`}
                className="w-16 h-16 rounded object-cover border border-gray-700"
              />
              <button
                onClick={() => removeImage(i)}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-700 hover:bg-red-600 text-white text-xs rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
              >
                x
              </button>
            </div>
          ))}
          {images.length >= MAX_IMAGES && (
            <span className="text-xs text-gray-500 self-center ml-1">Max {MAX_IMAGES} images</span>
          )}
        </div>
      )}

      <div className="flex gap-2">
        {!isWorking && (
          <button
            onClick={handleSkillButtonClick}
            title="Open the skill picker (or just type / in the message box)"
            className="px-2.5 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-mono rounded-lg transition-colors self-start"
          >
            /
          </button>
        )}
        <div className="relative flex-1">
          {skillsOpen && (
            <SkillDropdown
              skills={filteredSkills}
              highlightedIndex={highlightedIndex}
              onSelect={insertSkill}
              onHover={setHighlightedIndex}
              onClose={() => setSkillsOpen(false)}
            />
          )}
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => { handleChange(e.target.value); handleTyping(); }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={isWorking ? 'Queue a message...' : 'Type a message or paste an image... (Enter to send, / for skills)'}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500 min-h-[40px] max-h-[50vh] overflow-y-auto"
            rows={1}
          />
        </div>
        {isWorking && (
          <button
            onClick={onInterrupt}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Stop
          </button>
        )}
        {!isWorking && (
          <button
            onClick={() => handleSend(true)}
            disabled={!value.trim() && images.length === 0}
            title="Plan first (Cmd/Ctrl+Enter): Claude proposes a plan before executing"
            className="px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Plan
          </button>
        )}
        <button
          onClick={() => handleSend(false)}
          disabled={!value.trim() && images.length === 0}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {isWorking ? 'Queue' : 'Send'}
        </button>
      </div>
    </div>
  );
}
