import { useState, useCallback, useRef, useEffect, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react';
import { useSessions } from '../context/SessionContext';
import type { ImageAttachment } from '@clauder/shared';

const MAX_IMAGES = 4;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

interface PromptInputProps {
  sessionId: string;
  onSend: (message: string, images?: ImageAttachment[]) => void;
  onInterrupt: () => void;
  isWorking: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
}

export function PromptInput({ sessionId, onSend, onInterrupt, isWorking, draft, onDraftChange }: PromptInputProps) {
  const { updateLastActive } = useSessions();
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

  const handleSend = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    onSend(trimmed, images.length > 0 ? images : undefined);
    setValue('');
    onDraftChange('');
    setImages([]);
  }, [value, images, onSend, onDraftChange]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

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
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => { setValue(e.target.value); onDraftChange(e.target.value); handleTyping(); }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isWorking ? 'Queue a message...' : 'Type a message or paste an image... (Enter to send)'}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500 min-h-[40px] max-h-[50vh] overflow-y-auto"
          rows={1}
        />
        {isWorking && (
          <button
            onClick={onInterrupt}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Stop
          </button>
        )}
        <button
          onClick={handleSend}
          disabled={!value.trim() && images.length === 0}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {isWorking ? 'Queue' : 'Send'}
        </button>
      </div>
    </div>
  );
}
