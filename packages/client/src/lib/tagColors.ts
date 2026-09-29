// A fixed palette of tag colors, stored as hex strings on each TagDef and rendered via inline
// styles (see tagChipStyle). We use inline hex rather than Tailwind classes on purpose: tag
// colors are user-chosen at runtime, and Tailwind purges class names it can't see in the source,
// so dynamic `bg-${color}` classes would vanish from the build. Hex + inline style always works.

export const TAG_PALETTE: string[] = [
  '#ef4444', // red
  '#f97316', // orange
  '#f59e0b', // amber
  '#eab308', // yellow
  '#84cc16', // lime
  '#22c55e', // green
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#a855f7', // purple
  '#d946ef', // fuchsia
  '#ec4899', // pink
  '#64748b', // slate
];

export const DEFAULT_TAG_COLOR = '#3b82f6';

/** Inline styles for a tag chip: solid text, translucent fill + border of the tag's color.
 *  Alpha suffixes are 8-digit hex (`22` ≈ 13%, `55` ≈ 33%). */
export function tagChipStyle(color: string): React.CSSProperties {
  return {
    color,
    backgroundColor: `${color}22`,
    borderColor: `${color}55`,
  };
}
