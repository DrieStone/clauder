import { useEffect, useRef } from 'react';
import type { Skill } from '@clauder/shared';

interface SkillDropdownProps {
  skills: Skill[];
  highlightedIndex: number;
  onSelect: (skill: Skill) => void;
  onHover: (index: number) => void;
  onClose: () => void;
}

export function SkillDropdown({ skills, highlightedIndex, onSelect, onHover, onClose }: SkillDropdownProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      const el = containerRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [onClose]);

  // Scroll highlighted row into view
  useEffect(() => {
    const el = containerRef.current?.querySelector<HTMLElement>(`[data-skill-idx="${highlightedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex]);

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full mb-2 left-0 right-0 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-lg max-h-64 overflow-y-auto"
    >
      {skills.length === 0 ? (
        <div className="px-3 py-2 text-xs text-gray-500">No matching skills</div>
      ) : (
        skills.map((skill, i) => (
          <button
            key={skill.name}
            type="button"
            data-skill-idx={i}
            onMouseEnter={() => onHover(i)}
            onClick={() => onSelect(skill)}
            className={`w-full text-left px-3 py-1.5 flex items-baseline gap-2 text-xs transition-colors ${
              i === highlightedIndex ? 'bg-gray-700' : 'hover:bg-gray-700/60'
            }`}
          >
            <span className="font-mono text-blue-300 shrink-0">/{skill.name}</span>
            {skill.source === 'project' && (
              <span className="text-purple-400 text-[10px] uppercase tracking-wide shrink-0">project</span>
            )}
            <span className="text-gray-400 truncate">{skill.description}</span>
          </button>
        ))
      )}
    </div>
  );
}
