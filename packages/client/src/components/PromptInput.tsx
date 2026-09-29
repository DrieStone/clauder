import { useState, useCallback, useRef, useEffect, useMemo, type KeyboardEvent, type ClipboardEvent } from 'react';
import { useSessions } from '../context/SessionContext';
import type { ImageAttachment, FileAttachment, Skill, EffortLevel } from '@clauder/shared';
import { SkillDropdown } from './SkillDropdown';

const MAX_IMAGES = 10;
const MAX_IMAGE_SIZE = 15 * 1024 * 1024; // 15MB — desktop screenshots/photos routinely exceed 5MB
const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB
const MAX_FILES = 5;

// Touch-primary device (phone/tablet). On these, the soft keyboard's Return should insert a
// newline rather than submit — you tap Send to send. Evaluated once; device type is stable.
const IS_TOUCH = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(pointer: coarse)').matches;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'py', 'rb', 'php', 'java', 'kt', 'swift', 'go', 'rs', 'c', 'cpp', 'h',
  'cs', 'sh', 'bash', 'zsh', 'fish', 'sql', 'graphql', 'html', 'css', 'scss',
  'env', 'gitignore', 'dockerfile', 'makefile', 'lock',
]);

function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXTENSIONS.has(ext);
}

// Per-message effort dial — three presets, always exactly one selected ('default' is a real
// state, not "no override"). Never touches the session's model: effort is the cache-safe cost
// dial (same model, same warm cache, just fewer/more thinking tokens), unlike switching
// models, which cold-starts the prompt cache. Quick = low effort for mechanical asks. Deep =
// high effort for a genuinely hard question. Default = the session's own configured effort.
type SendMode = 'quick' | 'default' | 'deep';
const SEND_MODE_EFFORT: Record<Exclude<SendMode, 'default'>, EffortLevel> = { quick: 'low', deep: 'high' };

const DOWNSCALE_MAX_DIM = 1600;

/** Downscale an image attachment to a 1600px long edge before sending — a 12MB screenshot
 *  becomes ~300KB, which matters everywhere the payload travels: the WS message, the API
 *  tokens, and persisted session history (images ride un-stripped into sessions.json).
 *  Images already at or under 1600px pass through untouched (original format preserved).
 *  GIFs are skipped — canvas rasterization would destroy animation. Any decode/convert
 *  failure falls back to the original attachment; this must never block or drop a send. */
async function downscaleImage(att: ImageAttachment): Promise<ImageAttachment> {
  if (att.mimeType === 'image/gif') return att;
  try {
    const dataUrl = `data:${att.mimeType};base64,${att.data}`;
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('image decode failed'));
      el.src = dataUrl;
    });
    const { width, height } = img;
    if (Math.max(width, height) <= DOWNSCALE_MAX_DIM) return att;

    const scale = DOWNSCALE_MAX_DIM / Math.max(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return att;
    // JPEG has no alpha channel — matte transparent images to white first (matches how
    // they'd render in the chat background anyway).
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const outUrl = canvas.toDataURL('image/jpeg', 0.85);
    return { data: outUrl.split(',')[1], mimeType: 'image/jpeg' };
  } catch {
    return att;
  }
}

interface PromptInputProps {
  sessionId: string;
  onSend: (message: string, images?: ImageAttachment[], planMode?: boolean, files?: FileAttachment[], model?: string, effort?: string) => void;
  onInterrupt: () => void;
  isWorking: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
}

export function PromptInput({ sessionId, onSend, onInterrupt, isWorking, draft, onDraftChange }: PromptInputProps) {
  const { updateLastActive, refreshSkills, state, draftAppend } = useSessions();
  const [value, setValue] = useState(draft);
  const prevSessionIdRef = useRef(sessionId);
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);

  // When switching sessions, restore the saved draft for the new session
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      setValue(draft);
    }
  }, [sessionId, draft]);

  // "Insert path" from search: a one-shot signal (see draftAppend's doc comment in
  // SessionContext) rather than a live-synced draft, so only apply it once per nonce and
  // only while this session's compose box is the one mounted.
  const lastAppliedAppendNonceRef = useRef(0);
  useEffect(() => {
    if (!draftAppend || draftAppend.sessionId !== sessionId) return;
    if (draftAppend.nonce === lastAppliedAppendNonceRef.current) return;
    lastAppliedAppendNonceRef.current = draftAppend.nonce;
    setValue(v => {
      const next = v && !v.endsWith(' ') && !v.endsWith('\n') ? `${v} ${draftAppend.text}` : `${v}${draftAppend.text}`;
      onDraftChange(next);
      return next;
    });
  }, [draftAppend, sessionId, onDraftChange]);
  const [dragOver, setDragOver] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  // Per-message option, defaults on; reset to on after each send. Shown only when an image
  // is attached (see the image-preview strip below).
  const [downscale, setDownscale] = useState(true);
  // Per-message effort dial — a one-off override for just this turn, never touching the
  // session's configured effort. Resets to 'default' after every send.
  const [sendMode, setSendMode] = useState<SendMode>('default');
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // Rejections used to fail SILENTLY (bare `return`), so an oversized/unsupported file just
  // vanished with no clue why. Now every rejection surfaces a reason via setAttachError.
  const addImageFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) { setAttachError(`"${file.name}" isn't an image.`); return; }
    if (file.size > MAX_IMAGE_SIZE) {
      setAttachError(`"${file.name}" is too large (${(file.size / 1e6).toFixed(1)}MB — max ${MAX_IMAGE_SIZE / 1e6}MB).`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      setImages(prev => {
        if (prev.length >= MAX_IMAGES) { setAttachError(`Max ${MAX_IMAGES} images per message.`); return prev; }
        setAttachError(null);
        return [...prev, { data: base64, mimeType: file.type }];
      });
    };
    reader.onerror = () => setAttachError(`Couldn't read "${file.name}".`);
    reader.readAsDataURL(file);
  }, []);

  const addFile = useCallback((file: File) => {
    if (file.size > MAX_FILE_SIZE) {
      setAttachError(`"${file.name}" is too large (${(file.size / 1e6).toFixed(1)}MB — max ${MAX_FILE_SIZE / 1e6}MB).`);
      return;
    }
    const isPdf = file.type === 'application/pdf';
    const isText = isTextFile(file);

    const pushFile = (attachment: FileAttachment) => setFiles(prev => {
      if (prev.length >= MAX_FILES) { setAttachError(`Max ${MAX_FILES} files per message.`); return prev; }
      setAttachError(null);
      return [...prev, attachment];
    });

    if (isText) {
      // Read as text and inline it directly into the message.
      const reader = new FileReader();
      reader.onload = () => pushFile({ name: file.name, mimeType: file.type || 'text/plain', content: reader.result as string, kind: 'text' });
      reader.onerror = () => setAttachError(`Couldn't read "${file.name}".`);
      reader.readAsText(file);
    } else {
      // PDF → native API document block. Anything else (XLS, docx, zip, …) → 'binary':
      // the server saves it to disk and hands Claude the path to read with its own tools,
      // since the API has no content block for those formats.
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        pushFile({ name: file.name, mimeType: file.type || 'application/octet-stream', content: base64, kind: isPdf ? 'document' : 'binary' });
      };
      reader.onerror = () => setAttachError(`Couldn't read "${file.name}".`);
      reader.readAsDataURL(file);
    }
  }, []);

  const handleSend = useCallback(async (planMode = false) => {
    const trimmed = value.trim();
    if (!trimmed && images.length === 0 && files.length === 0) return;
    // Downscale at SEND time (not attach time) so previews always show the original and
    // toggling the option off right before sending still sends full resolution.
    const outImages = downscale && images.length > 0
      ? await Promise.all(images.map(downscaleImage))
      : images;
    const overrideEffort = sendMode === 'default' ? undefined : SEND_MODE_EFFORT[sendMode];
    onSend(
      trimmed,
      outImages.length > 0 ? outImages : undefined,
      planMode,
      files.length > 0 ? files : undefined,
      undefined, // this dial never overrides the model — see SendMode's doc comment
      overrideEffort,
    );
    setValue('');
    onDraftChange('');
    setImages([]);
    setFiles([]);
    setDownscale(true);
    setSendMode('default');
    setSkillsOpen(false);
  }, [value, images, files, downscale, sendMode, onSend, onDraftChange]);

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

      // Shift+Enter inserts newline; Cmd/Ctrl+Enter sends in plan mode; plain Enter sends normally.
      // On touch devices, Enter is left alone (inserts a newline) — you tap Send to submit.
      if (e.key === 'Enter' && !e.shiftKey && !IS_TOUCH) {
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

  // Accept file drops ANYWHERE in the app, not just the input bar — dropping onto the chat
  // area is the natural gesture and was previously rejected ("not allowed" cursor). Window-
  // level so it covers the whole view; gated on the "Files" type so it never interferes with
  // text/selection drags. (Native listeners, not React props on the input bar, so there's no
  // double-processing when you happen to drop right on the input.)
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (e: DragEvent) => { if (!hasFiles(e)) return; e.preventDefault(); setDragOver(true); };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragOver(false);
      for (const file of Array.from(e.dataTransfer?.files ?? [])) {
        if (file.type.startsWith('image/')) addImageFile(file); else addFile(file);
      }
    };
    const onDragLeave = (e: DragEvent) => { if (e.relatedTarget === null) setDragOver(false); };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragleave', onDragLeave);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragleave', onDragLeave);
    };
  }, [addImageFile, addFile]);

  const removeImage = useCallback((index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index));
  }, []);

  const handleTyping = useCallback(() => {
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      updateLastActive(sessionId);
    }, 2000);
  }, [updateLastActive, sessionId]);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    for (const file of files) {
      if (file.type.startsWith('image/')) addImageFile(file);
      else addFile(file);
    }
    e.target.value = '';
  }, [addImageFile, addFile]);

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
    <div className={`border-t border-gray-800 p-2 sm:p-3 ${dragOver ? 'bg-blue-900/20 border-blue-500' : ''}`}>
      {/* Full-screen drop overlay while dragging files anywhere over the app */}
      {dragOver && (
        <div className="fixed inset-0 z-40 bg-blue-950/40 border-2 border-dashed border-blue-500 flex items-center justify-center pointer-events-none">
          <div className="text-blue-200 text-sm font-medium bg-gray-900/80 px-4 py-2 rounded-lg">Drop image or file to attach</div>
        </div>
      )}
      {attachError && (
        <div className="flex items-center justify-between gap-2 mb-2 text-xs text-red-400">
          <span>{attachError}</span>
          <button onClick={() => setAttachError(null)} className="text-red-500 hover:text-red-300 shrink-0">✕</button>
        </div>
      )}
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
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-700 hover:bg-red-600 text-white text-xs rounded-full flex items-center justify-center [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 transition-opacity"
              >
                x
              </button>
            </div>
          ))}
          {images.length >= MAX_IMAGES && (
            <span className="text-xs text-gray-500 self-center ml-1">Max {MAX_IMAGES} images</span>
          )}
          <label className="flex items-center gap-1.5 text-xs text-gray-400 self-center ml-1 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={downscale}
              onChange={(e) => setDownscale(e.target.checked)}
              className="accent-blue-500"
            />
            Downscale to 1600px
          </label>
        </div>
      )}

      {/* File chips */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {files.map((f, i) => (
            <div key={i} className="flex items-center gap-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-gray-200 group">
              <span className="text-gray-400">{f.kind === 'document' ? '📄' : f.kind === 'binary' ? '📎' : '📝'}</span>
              <span className="max-w-[160px] truncate">{f.name}</span>
              <button
                onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))}
                className="ml-0.5 text-gray-500 hover:text-red-400 transition-colors"
              >
                ✕
              </button>
            </div>
          ))}
          {files.length >= MAX_FILES && (
            <span className="text-xs text-gray-500 self-center ml-1">Max {MAX_FILES} files</span>
          )}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileInputChange}
      />
      <div className="flex gap-2 min-w-0 items-start">
        {!isWorking && (
          <button
            onClick={handleSkillButtonClick}
            title="Open the skill picker (or just type / in the message box)"
            className="px-2.5 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm font-mono rounded-lg transition-colors self-start"
          >
            /
          </button>
        )}
        {!isWorking && (images.length < MAX_IMAGES || files.length < MAX_FILES) && (
          <button
            onClick={() => fileInputRef.current?.click()}
            title="Attach image or file"
            className="px-2.5 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded-lg transition-colors self-start"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
          </button>
        )}
        {/* Textarea + action buttons: stacked on mobile (input gets a full-width line, buttons
            drop below it) so the phone input isn't squeezed; inline on desktop (sm:) as before.
            While working there's only Stop + Queue, which fit inline on a phone too (saves a row). */}
        <div className={`flex-1 min-w-0 flex gap-2 ${isWorking ? 'flex-row items-start' : 'flex-col sm:flex-row sm:items-start'}`}>
          <div className="relative flex-1 min-w-0">
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
              placeholder={isWorking ? 'Queue a message...' : IS_TOUCH ? 'Type a message... (tap Send)' : 'Type a message or paste an image... (Enter to send, / for skills)'}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-base sm:text-sm text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500 min-h-[40px] max-h-[50vh] overflow-y-auto"
              rows={1}
            />
          </div>
          <div className={`flex gap-2 items-start ${isWorking ? 'shrink-0' : 'flex-wrap justify-end sm:justify-start sm:flex-nowrap'}`}>
            {isWorking && (
              <button
                onClick={onInterrupt}
                className="px-3 sm:px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Stop
              </button>
            )}
            {!isWorking && (
              <button
                onClick={() => handleSend(true)}
                disabled={!value.trim() && images.length === 0 && files.length === 0}
                title="Plan first (Cmd/Ctrl+Enter): Claude proposes a plan before executing"
                className="px-2.5 sm:px-3 py-2 bg-purple-700 hover:bg-purple-600 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
              >
                Plan
              </button>
            )}
            {!isWorking && (
              <div className="flex rounded-lg overflow-hidden shrink-0 border border-gray-700">
                <button
                  type="button"
                  onClick={() => setSendMode('quick')}
                  title="Quick: this message at low effort — cheapest turn, keeps the cache warm. For mechanical asks."
                  className={`px-2 sm:px-2.5 py-2 text-xs font-medium transition-colors ${
                    sendMode === 'quick' ? 'bg-green-700/40 text-green-300' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                  }`}
                >
                  Quick
                </button>
                <button
                  type="button"
                  onClick={() => setSendMode('default')}
                  title="Default: this message runs at the session's own configured effort."
                  className={`px-2 sm:px-2.5 py-2 text-xs font-medium border-l border-gray-700 transition-colors ${
                    sendMode === 'default' ? 'bg-gray-600 text-gray-100' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                  }`}
                >
                  Default
                </button>
                <button
                  type="button"
                  onClick={() => setSendMode('deep')}
                  title="Deep: this message at high effort. For genuinely hard questions — same model, just more thinking."
                  className={`px-2 sm:px-2.5 py-2 text-xs font-medium border-l border-gray-700 transition-colors ${
                    sendMode === 'deep' ? 'bg-purple-700/40 text-purple-300' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                  }`}
                >
                  Deep
                </button>
              </div>
            )}
            <button
              onClick={() => handleSend(false)}
              disabled={!value.trim() && images.length === 0 && files.length === 0}
              className="px-3 sm:px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {isWorking ? 'Queue' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
