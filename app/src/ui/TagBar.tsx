import { useMemo, useState } from 'react';
import { useData } from '../store/data';
import { useUI } from '../store/ui';

/** Tous les tags (de n'importe quel neurone) avec leur nombre, les plus utilisés d'abord */
export function useAllTags(): [string, number][] {
  // une clé primitive garde l'abonnement stable
  const key = useData((s) => {
    const m = new Map<string, number>();
    for (const e of Object.values(s.entities)) for (const t of e.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t, n]) => `${t}\u0001${n}`)
      .join('\u0002');
  });
  return useMemo(
    () =>
      key
        ? key.split('\u0002').map((p) => {
            const [t, n] = p.split('\u0001');
            return [t, Number(n)] as [string, number];
          })
        : [],
    [key],
  );
}

/** Filtre par tag : les neurones qui le portent restent allumés, le reste s'efface */
export function TagBar() {
  const tags = useAllTags();
  const active = useUI((s) => s.activeTags);
  const toggleTag = useUI((s) => s.toggleTag);
  const clearTags = useUI((s) => s.clearTags);
  const [all, setAll] = useState(false);
  if (!tags.length) return null;
  const shown = all ? tags : tags.filter(([t], i) => i < 9 || active.includes(t));
  return (
    <div className="flex flex-wrap justify-center gap-1.5 max-w-[640px] pointer-events-auto" data-ui>
      {shown.map(([t, n]) => (
        <button key={t} className="chip" data-on={active.includes(t) ? '1' : '0'} onClick={() => toggleTag(t)}>
          #{t}
          <span className="opacity-45">{n}</span>
        </button>
      ))}
      {tags.length > shown.length && (
        <button className="chip chip-muted" onClick={() => setAll(true)}>
          +{tags.length - shown.length}
        </button>
      )}
      {all && tags.length > 9 && (
        <button className="chip chip-muted" onClick={() => setAll(false)}>
          moins
        </button>
      )}
      {active.length > 0 && (
        <button className="chip chip-muted" onClick={clearTags}>
          ✕ filtre
        </button>
      )}
    </div>
  );
}
