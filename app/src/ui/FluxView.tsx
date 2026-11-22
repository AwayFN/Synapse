import { useMemo, useState } from 'react';
import { displayTitle, useData } from '../store/data';
import { adjacency } from '../store/graph';
import { useUI } from '../store/ui';
import { searchEntities } from '../lib/search';
import { parseCapture } from '../lib/parse';
import { commitCapture } from '../lib/capture';
import { natureOf, NATURE_ORDER, NATURES } from '../lib/kinds';
import { kindTag, metaLine } from '../lib/entity';
import { excerpt } from '../lib/text';
import { fmtClock, fmtDateLong, relativeDay, toISODate } from '../lib/time';
import type { Entity, Nature } from '../types';
import { Corners, EntityGlyph, Glyph, Kbd, natureVar, useKinds } from './common';
import { LinkPicker } from './LinkPicker';
import { can, useCan } from '../sync/perm';
import { memberName, useSession } from '../sync/session';

type Filter = 'all' | 'orphans' | Nature;

function Row({ e, degree, linking, setLinking }: { e: Entity; degree: number; linking: boolean; setLinking: (id: string | null) => void }) {
  const kinds = useKinds();
  const openEntity = useUI((s) => s.openEntity);
  const openEditor = useUI((s) => s.openEditor);
  const meta = metaLine(e, { tags: false });
  const shared = useSession((s) => s.mode !== 'local');
  const me = useSession((s) => s.me.id);
  const text = excerpt(e.body, 140);
  return (
    <div className="group" style={natureVar(natureOf(e, kinds))}>
      <div className="grid grid-cols-[52px_1fr_auto] gap-4 items-start py-2.5 pl-2 pr-2 hover:bg-white/[0.02] transition-colors border-l border-transparent hover:border-[rgb(var(--c)/0.5)]">
        <span className="mono text-[10.5px] text-white/30 tabular-nums pt-[2px]">
          {fmtClock(e.createdAt)}
          {shared && e.createdBy && e.createdBy !== me && <span className="block text-[8.5px] tracking-[0.1em] uppercase text-white/40 truncate">{memberName(e.createdBy)}</span>}
        </span>
        <button className="min-w-0 text-left" onClick={() => openEntity(e.id)}>
          <div className="flex items-center gap-2 min-w-0">
            <EntityGlyph e={e} size={11} />
            <span className={`text-[14px] truncate ${e.status === 'done' ? 'line-through text-white/40' : 'text-white/88 group-hover:text-white'}`}>{displayTitle(e)}</span>
            <span className="mono text-[8.5px] tracking-[0.13em] text-[rgb(var(--c)/0.75)] flex-none">{kindTag(e)}</span>
            {meta && <span className="mono text-[8.5px] tracking-[0.1em] uppercase text-white/30 truncate">{meta}</span>}
          </div>
          {text && text !== displayTitle(e) && <div className="text-[12px] text-white/40 truncate mt-0.5 pl-[19px]">{text}</div>}
          {e.tags.length > 0 && <div className="mono text-[9.5px] text-white/35 mt-0.5 pl-[19px]">{e.tags.map((t) => `#${t}`).join(' ')}</div>}
        </button>
        <div className="flex items-center gap-1">
          {degree > 0 ? (
            <span className="mono text-[9.5px] text-white/32 mr-1">⟷ {degree}</span>
          ) : (
            <span className="mono text-[9px] tracking-[0.1em] text-white/28 mr-1">SANS LIEN</span>
          )}
          {can.link() && (
            <button className="btn btn-ghost !px-2 !py-0.5 !text-[9.5px] opacity-50 group-hover:opacity-100" onClick={() => setLinking(linking ? null : e.id)}>
              Relier…
            </button>
          )}
          <button className="btn btn-ghost !px-2 !py-0.5 opacity-40 group-hover:opacity-100" title="Développer en plein écran" onClick={() => openEditor(e.id)}>
            ⤢
          </button>
          <button className="btn btn-ghost !px-2 !py-0.5 opacity-40 group-hover:opacity-100" title="Voir dans le réseau" onClick={() => openEntity(e.id)}>
            ◎
          </button>
        </div>
      </div>
      {linking && (
        <div className="ml-[68px] mr-2 mb-2">
          <LinkPicker sourceId={e.id} onClose={() => setLinking(null)} />
        </div>
      )}
    </div>
  );
}

function Flux() {
  const entities = useData((s) => s.entities);
  const links = useData((s) => s.links);
  const kinds = useKinds();
  const setView = useUI((s) => s.setView);
  const toast = useUI((s) => s.toast);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(160);
  const [capture, setCapture] = useState('');
  const [linking, setLinking] = useState<string | null>(null);
  const adj = adjacency(links);
  const perm = useCan();

  const all = useMemo(() => Object.values(entities).sort((a, b) => b.createdAt - a.createdAt), [entities]);
  const orphans = all.filter((e) => !(adj.get(e.id)?.length)).length;
  const list = useMemo(() => {
    let arr = q.trim() ? searchEntities(entities, q, 600).map((h) => h.e) : all;
    if (filter === 'orphans') arr = arr.filter((e) => !(adj.get(e.id)?.length));
    else if (filter !== 'all') arr = arr.filter((e) => natureOf(e, kinds) === filter);
    return arr;
  }, [q, entities, all, filter, adj, kinds]);

  const groups = useMemo(() => {
    if (q.trim()) return [{ day: 'Résultats', items: list.slice(0, limit) }];
    const out: { day: string; items: Entity[] }[] = [];
    for (const e of list.slice(0, limit)) {
      const d = toISODate(new Date(e.createdAt));
      if (!out.length || out[out.length - 1].day !== d) out.push({ day: d, items: [] });
      out[out.length - 1].items.push(e);
    }
    return out;
  }, [list, limit, q]);

  const doCapture = () => {
    if (!capture.trim()) return;
    const p = parseCapture(capture, useData.getState().entities);
    const { entity } = commitCapture(p);
    toast({ text: `CAPTURÉ · ${displayTitle(entity)}`, color: NATURES[natureOf(entity, useData.getState().kinds)].hex });
    setCapture('');
  };

  const chips: { f: Filter; label: string; n?: number; nature?: Nature }[] = [
    { f: 'all', label: 'Tout', n: all.length },
    { f: 'orphans', label: 'Sans lien', n: orphans },
    ...NATURE_ORDER.map((n) => ({ f: n as Filter, label: NATURES[n].plural, nature: n })),
  ];

  return (
    <div className="fixed inset-0 z-30 anim-fade" data-ui>
      <div className="backdrop" onClick={() => setView('network')} />
      <div className="absolute left-1/2 -translate-x-1/2 top-5 bottom-5 w-[min(1000px,calc(100vw-48px))] flex flex-col">
        <div className="flex items-end justify-between mb-4 gap-4">
          <div>
            <div className="hud text-[10px] text-white/60">Vue flux · ta mémoire, dans l'ordre où elle est arrivée</div>
            <div className="text-[28px] font-semibold tracking-tight text-white mt-1">
              {all.length}
              <span className="text-[13px] font-normal text-white/40 ml-3">neurones capturés</span>
              {orphans > 0 && <span className="text-[13px] font-normal text-white/30 ml-3">· {orphans} attendent un lien</span>}
            </div>
          </div>
          <button className="btn" onClick={() => setView('network')}>
            ← Réseau <span className="text-white/35 ml-1">Échap</span>
          </button>
        </div>

        <div className="glass neon p-3 flex flex-col gap-2.5 relative">
          <Corners />
          <div className={`flex items-center gap-2 ${perm.write() ? '' : 'hidden'}`}>
            <span className="hud text-[10px] text-white/70 w-[70px]">+ Capturer</span>
            <input
              className="field flex-1"
              placeholder="Vide ta tête ici : une idée, une chose à faire, une phrase… (Entrée)"
              value={capture}
              onChange={(e) => setCapture(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doCapture()}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="hud text-[10px] text-white/45 w-[70px]">⌕ Filtrer</span>
            <input className="field flex-1 min-w-[200px] !py-1.5" placeholder="mots, #tag…" value={q} onChange={(e) => setQ(e.target.value)} />
            <div className="flex flex-wrap gap-1.5">
              {chips.map((c) => (
                <button key={c.f} className="chip" data-on={filter === c.f ? '1' : '0'} style={c.nature ? natureVar(c.nature) : undefined} onClick={() => setFilter(c.f)}>
                  {c.nature && <Glyph nature={c.nature} size={9} />}
                  {c.label}
                  {c.n != null && <span className="opacity-45">{c.n}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto scroll-thin mt-4 pr-2">
          {groups.length === 0 && <div className="text-[13px] text-white/35 py-6 pl-2">Rien ici pour l'instant.</div>}
          {groups.map((g) => (
            <section key={g.day} className="mb-3">
              <div className="sticky top-0 z-10 flex items-center gap-3 py-2 bg-black/80 backdrop-blur-md border-b border-white/[0.05]">
                <span className="hud text-[11px] text-white/70">{g.day === 'Résultats' ? `Résultats · ${list.length}` : fmtDateLong(g.day)}</span>
                {g.day !== 'Résultats' && relativeDay(g.day) && <span className="hud text-[9px] px-1.5 py-px border border-white/15 text-white/50">{relativeDay(g.day)}</span>}
                <span className="ml-auto mono text-[10px] tracking-[0.1em] text-white/30">{g.items.length}</span>
              </div>
              {g.items.map((e) => (
                <Row key={e.id} e={e} degree={adj.get(e.id)?.length ?? 0} linking={linking === e.id} setLinking={setLinking} />
              ))}
            </section>
          ))}
          {list.length > limit && (
            <div className="flex justify-center py-4">
              <button className="btn" onClick={() => setLimit((l) => l + 200)}>
                Afficher plus ({list.length - limit})
              </button>
            </div>
          )}
        </div>
        <div className="hud text-[9px] text-white/30 mt-3 flex gap-4 justify-center">
          <span>Capture d'abord, structure plus tard : « Relier… » rattache une pensée à son contexte</span>
          <span>
            <Kbd>2</Kbd> flux
          </span>
          <span>
            <Kbd>Échap</Kbd> réseau
          </span>
        </div>
      </div>
    </div>
  );
}

export function FluxView() {
  const view = useUI((s) => s.view);
  return view === 'flux' ? <Flux /> : null;
}
