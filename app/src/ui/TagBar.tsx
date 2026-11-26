import { useMemo } from 'react';
import { useData } from '../store/data';
import { useUI } from '../store/ui';
import { NEON } from '../lib/color';
import { hashString } from '../lib/random';
import { tagsOf } from '../types';
import { cvar } from './common';

export function tagColor(tag: string): string {
  return NEON[hashString(tag) % NEON.length];
}

/** Tous les tags (projets, tâches, notes, créneaux) avec leur nombre, les plus utilisés d'abord */
export function useAllTags(): [string, number][] {
  // select a primitive key so the store subscription stays stable
  const key = useData((s) => {
    const m = new Map<string, number>();
    for (const e of Object.values(s.entities)) for (const t of tagsOf(e)) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t, n]) => `${t}\u0001${n}`)
      .join('\u0002');
  });
  return useMemo(
    () => (key ? key.split('\u0002').map((p) => { const [t, n] = p.split('\u0001'); return [t, Number(n)] as [string, number]; }) : []),
    [key],
  );
}

/** Filtre par tag : les éléments qui ont ce tag (quelle que soit leur sorte) restent allumés, le reste s'estompe */
export function TagBar() {
  const tags = useAllTags();
  const active = useUI((s) => s.activeTags);
  const toggleTag = useUI((s) => s.toggleTag);
  const clearTags = useUI((s) => s.clearTags);
  if (!tags.length) return null;
  return (
    <div className="flex flex-wrap justify-center gap-1.5 max-w-[620px] pointer-events-auto" data-ui>
      {tags.map(([t, n]) => (
        <button key={t} className="chip" data-on={active.includes(t) ? '1' : '0'} style={cvar(tagColor(t))} onClick={() => toggleTag(t)}>
          #{t}
          <span className="opacity-50">{n}</span>
        </button>
      ))}
      {active.length > 0 && (
        <button className="chip" style={cvar('#ffffff')} onClick={clearTags}>
          ✕ filtre
        </button>
      )}
    </div>
  );
}
