import { useEffect, useMemo, useRef, useState } from 'react';
import { displayTitle, useData } from '../store/data';
import { neighborsOf } from '../store/graph';
import { useUI } from '../store/ui';
import { matchScore } from '../lib/text';
import { bodyOf, tagsOf, TYPE_LABEL, type Entity } from '../types';
import { LEVEL, useBackLayer } from '../lib/back';
import { cvar } from './common';
import { TYPE_TAG } from './Labels';

const TYPE_RANK = { project: 0, task: 1, note: 2, slot: 3 } as const;

function searchText(e: Entity) {
  return `${e.title} ${bodyOf(e).slice(0, 200)} ${tagsOf(e).join(' ')}`;
}

/** "+ Lier à…" — search across every entity, Enter to link; can also create & link */
export function LinkPicker({ sourceId, onClose, level = LEVEL.inPanel }: { sourceId: string; onClose: () => void; level?: number }) {
  // Échap (ou retour sur le téléphone) ferme d'abord cette liste, pas ce qui la contient
  useBackLayer(true, onClose, level);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const entities = useData((s) => s.entities);
  const links = useData((s) => s.links);

  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo(() => {
    const taken = new Set(neighborsOf(entities, links, sourceId).map((n) => n.entity.id));
    taken.add(sourceId);
    const out: { e: Entity; score: number }[] = [];
    for (const e of Object.values(entities)) {
      if (taken.has(e.id)) continue;
      const score = q.trim() ? Math.max(matchScore(q, displayTitle(e)), matchScore(q, searchText(e)) * 0.6) : 1;
      if (score > 0) out.push({ e, score });
    }
    out.sort((a, b) => b.score - a.score || TYPE_RANK[a.e.type] - TYPE_RANK[b.e.type] || b.e.updatedAt - a.e.updatedAt);
    return out.slice(0, 40).map((r) => r.e);
  }, [entities, links, q, sourceId]);

  type Row = { kind: 'link'; e: Entity } | { kind: 'create'; type: 'note' | 'task' };
  const rows: Row[] = [
    ...results.map((e) => ({ kind: 'link' as const, e })),
    ...(q.trim() ? [{ kind: 'create' as const, type: 'note' as const }, { kind: 'create' as const, type: 'task' as const }] : []),
  ];

  const pick = (row: Row) => {
    const d = useData.getState();
    if (row.kind === 'link') {
      d.link(sourceId, row.e.id);
    } else {
      const title = q.trim();
      const created = row.type === 'note' ? d.createNote({ title }, { linkTo: [sourceId] }) : d.createTask({ title }, { linkTo: [sourceId] });
      useUI.getState().toast({ text: `${TYPE_LABEL[created.type].toUpperCase()} CRÉÉE & LIÉE · ${title}`, color: created.color });
    }
    onClose();
  };

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div className="glass anim-pop mt-2 border border-white/10" style={cvar('#00e5ff')} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2 px-3 border-b border-white/[0.07]">
        <span className="text-[#00e5ff] mono text-xs">⟷</span>
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
          placeholder="Lier à… (projet, tâche, note, créneau)"
          className="flex-1 bg-transparent outline-none py-2.5 text-[13px] placeholder:text-white/30"
        />
        <button className="mono text-[10px] text-white/40 hover:text-white" onClick={onClose}>
          ÉCHAP
        </button>
      </div>
      <div ref={listRef} className="max-h-[260px] overflow-y-auto scroll-thin py-1">
        {rows.length === 0 && <div className="px-3 py-3 xs-label">Aucune entité à lier</div>}
        {rows.map((row, i) => {
          const on = i === active;
          if (row.kind === 'create') {
            return (
              <button
                key={`c-${row.type}`}
                data-i={i}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(row)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 text-[12.5px] ${on ? 'bg-white/[0.06]' : ''}`}
              >
                <span className="mono text-[#39ff88]">+</span>
                <span className="text-white/70">
                  Créer {row.type === 'note' ? 'une note' : 'une tâche'} « <span className="text-white">{q.trim()}</span> » et lier
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
              className={`w-full text-left px-3 py-[7px] flex items-center gap-2.5 ${on ? 'bg-white/[0.06]' : ''}`}
              style={cvar(e.color)}
            >
              <span className="dot" />
              <span className="mono text-[8.5px] tracking-[0.14em] text-[rgb(var(--c))] w-9">{TYPE_TAG[e.type]}</span>
              <span className="text-[12.5px] text-white/85 truncate">{displayTitle(e)}</span>
              {on && <span className="ml-auto mono text-[9px] text-white/35">ENTRÉE</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
