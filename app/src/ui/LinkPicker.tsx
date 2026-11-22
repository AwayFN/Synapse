import { useEffect, useMemo, useRef, useState } from 'react';
import { displayTitle, useData } from '../store/data';
import { adjacency } from '../store/graph';
import { useUI } from '../store/ui';
import { searchEntities } from '../lib/search';
import { parseCapture } from '../lib/parse';
import { commitCapture } from '../lib/capture';
import { kindLabel, natureOf, NATURES } from '../lib/kinds';
import { kindTag } from '../lib/entity';
import type { Entity } from '../types';
import { EntityGlyph, natureVar } from './common';

/** « + Relier… » — cherche n'importe quel neurone ; ou en capture un nouveau, déjà relié */
export function LinkPicker({ sourceId, onClose }: { sourceId: string; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const entities = useData((s) => s.entities);
  const links = useData((s) => s.links);
  const kinds = useData((s) => s.kinds);

  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo(() => {
    const taken = new Set((adjacency(links).get(sourceId) ?? []).map((x) => x.other));
    taken.add(sourceId);
    if (q.trim()) return searchEntities(entities, q, 40).map((h) => h.e).filter((e) => !taken.has(e.id)).slice(0, 30);
    return Object.values(entities)
      .filter((e) => !taken.has(e.id))
      .sort((a, b) => b.touchedAt - a.touchedAt)
      .slice(0, 30);
  }, [entities, links, q, sourceId]);

  type Row = { kind: 'link'; e: Entity } | { kind: 'create' };
  const rows: Row[] = [...results.map((e) => ({ kind: 'link' as const, e })), ...(q.trim() ? [{ kind: 'create' as const }] : [])];

  const pick = (row: Row) => {
    const d = useData.getState();
    if (row.kind === 'link') {
      d.link(sourceId, row.e.id);
    } else {
      const p = parseCapture(q, d.entities);
      const { entity } = commitCapture(p, { context: [sourceId] });
      useUI.getState().toast({ text: `CAPTURÉ & RELIÉ · ${displayTitle(entity)}`, color: NATURES[natureOf(entity, d.kinds)].hex });
    }
    onClose();
  };

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div className="glass anim-pop mt-2 border border-white/10" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 px-3 border-b border-white/[0.06]">
        <span className="text-white/50 mono text-xs">⟷</span>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(rows.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (rows[active]) pick(rows[active]);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
          placeholder="Relier à… (cherche, ou écris une nouvelle pensée)"
          className="flex-1 bg-transparent outline-none py-2.5 text-[13px] placeholder:text-white/30"
        />
        <button className="mono text-[10px] text-white/40 hover:text-white" onClick={onClose}>
          ÉCHAP
        </button>
      </div>
      <div ref={listRef} className="max-h-[260px] overflow-y-auto scroll-thin py-1">
        {rows.length === 0 && <div className="px-3 py-3 xs-label">Rien à relier pour l'instant</div>}
        {rows.map((row, i) => {
          const on = i === active;
          if (row.kind === 'create') {
            return (
              <button
                key="create"
                data-i={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(row)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 text-[12.5px] ${on ? 'bg-white/[0.05]' : ''}`}
              >
                <span className="mono text-white/60">+</span>
                <span className="text-white/65 truncate">
                  Capturer « <span className="text-white">{q.trim()}</span> » et relier
                </span>
              </button>
            );
          }
          const e = row.e;
          return (
            <button
              key={e.id}
              data-i={i}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(row)}
              className={`w-full text-left px-3 py-[7px] flex items-center gap-2.5 ${on ? 'bg-white/[0.05]' : ''}`}
              style={natureVar(natureOf(e, kinds))}
              title={kindLabel(e.kind)}
            >
              <EntityGlyph e={e} size={11} />
              <span className="text-[12.5px] text-white/85 truncate">{displayTitle(e)}</span>
              <span className="mono text-[8.5px] tracking-[0.12em] text-[rgb(var(--c)/0.75)] flex-none">{kindTag(e)}</span>
              {on && <span className="ml-auto mono text-[9px] text-white/35 flex-none">ENTRÉE</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
