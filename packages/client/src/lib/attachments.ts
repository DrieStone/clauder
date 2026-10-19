import type { ImageAttachment, FileAttachment } from '@clauder/shared';

// Shared by the owner's composer (PromptInput) and a guest's (GuestView), so both attach files
// the same way the server expects them. The server re-checks a guest's (guest-view.ts).
export const MAX_IMAGES = 10;
export const MAX_IMAGE_SIZE = 15 * 1024 * 1024; // 15MB — desktop screenshots/photos routinely exceed 5MB
export const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB
export const MAX_FILES = 5;

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'py', 'rb', 'php', 'java', 'kt', 'swift', 'go', 'rs', 'c', 'cpp', 'h',
  'cs', 'sh', 'bash', 'zsh', 'fish', 'sql', 'graphql', 'html', 'css', 'scss',
  'env', 'gitignore', 'dockerfile', 'makefile', 'lock',
]);

export function isTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXTENSIONS.has(ext);
}

const tooLarge = (file: File, max: number) =>
  `"${file.name}" is too large (${(file.size / 1e6).toFixed(1)}MB — max ${max / 1e6}MB).`;

function read(file: File, as: 'dataUrl' | 'text'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(`Couldn't read "${file.name}".`));
    if (as === 'text') reader.readAsText(file); else reader.readAsDataURL(file);
  });
}

/** Read a picked, pasted or dropped image as base64. Rejects with a message to show the user. */
export async function readImage(file: File): Promise<ImageAttachment> {
  if (!file.type.startsWith('image/')) throw new Error(`"${file.name}" isn't an image.`);
  if (file.size > MAX_IMAGE_SIZE) throw new Error(tooLarge(file, MAX_IMAGE_SIZE));
  return { data: (await read(file, 'dataUrl')).split(',')[1], mimeType: file.type };
}

/** Read any other file the way the server sends it to Claude: text is inlined, a PDF goes as a
 *  native document block, and anything else (XLS, docx, zip, …) as base64 the server saves to
 *  disk, handing Claude the path, since the API has no content block for those formats.
 *  Rejects with a message to show the user. */
export async function readFile(file: File): Promise<FileAttachment> {
  if (file.size > MAX_FILE_SIZE) throw new Error(tooLarge(file, MAX_FILE_SIZE));
  if (isTextFile(file)) {
    return { name: file.name, mimeType: file.type || 'text/plain', content: await read(file, 'text'), kind: 'text' };
  }
  const base64 = (await read(file, 'dataUrl')).split(',')[1];
  return { name: file.name, mimeType: file.type || 'application/octet-stream', content: base64, kind: file.type === 'application/pdf' ? 'document' : 'binary' };
}
