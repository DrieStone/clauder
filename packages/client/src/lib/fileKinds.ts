// Shared file-type classification for the file browser + viewer. Mirrors the server's
// allowlists in server.ts (TEXT_EXTS / IMAGE_EXTS / VIDEO_EXTS).

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
const TEXT_EXT = new Set([
  'md', 'markdown', 'txt', 'text', 'log', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'csv',
  'tsv', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'php', 'java', 'kt', 'kts', 'swift',
  'go', 'rs', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'sh', 'bash', 'zsh', 'fish', 'sql', 'graphql',
  'gql', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'ini', 'conf', 'cfg', 'env', 'properties',
  'vue', 'svelte', 'astro', 'lua', 'pl', 'r', 'dart', 'scala', 'clj', 'ex', 'exs', 'erl', 'hs', 'ml',
]);

export type FileKind = 'image' | 'video' | 'text';

/** Classify a filename into a viewable kind, or null if we can't display it. */
export function fileKind(name: string): FileKind | null {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (TEXT_EXT.has(ext)) return 'text';
  if (/^(dockerfile|makefile|license|readme|procfile)$/i.test(name)) return 'text';
  return null;
}

/** Emoji icon for a directory or a classified file. */
export function fileIcon(kind: FileKind | null | 'directory'): string {
  switch (kind) {
    case 'directory': return '\u{1F4C1}'; // 📁
    case 'image':     return '\u{1F5BC}\u{FE0F}'; // 🖼️
    case 'video':     return '\u{1F3AC}'; // 🎬
    default:          return '\u{1F4C4}'; // 📄
  }
}
