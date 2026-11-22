import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { displayTitle, useData } from '../store/data';
import { neighborsOf } from '../store/graph';
import { useUI } from '../store/ui';
import {
  addDays,
  crossesMidnight,
  fmtDateLong,
  fmtDuration,
  fmtTime,
  fmtWhen,
  minutesNow,
  relativeDay,
  slotDuration,
  todayISO,
} from '../lib/time';
import { kindTag, isLate } from '../lib/entity';
import { natureOf, NATURES } from '../lib/kinds';
import { parseCapture, whenOf } from '../lib/parse';
import { commitCapture } from '../lib/capture';
import type { Entity } from '../types';
import { Corners, EntityGlyph, Kbd, natureVar, useKinds } from './common';
import { EntityChip } from './EntityChip';
import { DeleteButton } from './DetailPanel';
import { ConnectionsSection, WhenFields } from './fields';
import { can, useCan } from '../sync/perm';

/** Ruban de 24 h : où se place le moment dans la journée */
function DayBar({ start, end }: { start: number; end: number | null }) {
  const e = end ?? (start + 60) % 1440;
  const segs = crossesMidnight(start, e) ? [[start, 1440], [0, e]] : [[start, e]];
  return (
    <div className="relative h-[3px] bg-white/[0.05] mt-2.5 w-full max-w-[420px]">
      {[6, 12, 18].map((h) => (
        <span key={h} className="absolute top-[-2px] w-px h-[7px] bg-white/12" style={{ left: `${(h / 24) * 100}%` }} />
      ))}
      {segs.map(([a, b], i) => (
        <span key={i} className="absolute top-0 h-full bg-[rgb(var(--c)/0.85)]" style={{ left: `${(a / 1440) * 100}%`, width: `${Math.max(0.4, ((b - a) / 1440) * 100)}%` }} />
      ))}
    </div>
  );
}

function Check({ e }: { e: Entity }) {
  const setStatus = useData((s) => s.setStatus);
  if (!e.status) return null;
  return (
    <button
      disabled={!can.edit(e)}
      onClick={() => can.edit(e) && setStatus(e.id, e.status === 'done' ? 'todo' : 'done')}
      className={`w-[13px] h-[13px] border flex-none text-[9px] flex items-center justify-center ${
        e.status === 'done' ? 'border-white/25 text-white/60' : 'border-[rgb(var(--amber)/0.55)] hover:border-[rgb(var(--amber))]'
      }`}
      title={e.status === 'done' ? 'Rouvrir' : 'Marquer comme fait'}
    >
      {e.status === 'done' ? '✓' : ''}
    </button>
  );
}

function MomentRow({ e, continuation, editing, onEdit }: { e: Entity; continuation?: boolean; editing: boolean; onEdit: () => void }) {
  const entities = useData((st) => st.entities);
  const links = useData((st) => st.links);
  const unlink = useData((st) => st.unlink);
  const update = useData((st) => st.update);
  const kinds = useKinds();
  const openEntity = useUI((st) => st.openEntity);
  const w = e.when!;
  const linked = neighborsOf(entities, links, e.id);
  const timed = w.start != null;
  const dur = timed && w.end != null ? slotDuration(w.start!, w.end) : null;
  const crosses = timed && w.end != null && crossesMidnight(w.start!, w.end);
  const done = e.status === 'done';
  return (
    <div className={`relative ${continuation ? 'opacity-45' : ''}`} style={natureVar(natureOf(e, kinds))}>
      <div className="group grid grid-cols-[148px_1fr_auto] gap-5 items-start py-3 pl-4 pr-3 border-l-2 border-[rgb(var(--c)/0.75)] hover:bg-white/[0.02] transition-colors">
        <div className="mono">
          <div className="text-[15px] text-white tabular-nums tracking-wide">
            {!timed ? (
              <span className="text-white/55 text-[12px] tracking-[0.12em]">JOURNÉE</span>
            ) : (
              <>
                {continuation ? '00:00' : fmtTime(w.start)}
                {w.end != null && (
                  <>
                    <span className="text-white/30 mx-1.5">→</span>
                    {fmtTime(w.end)}
                  </>
                )}
              </>
            )}
          </div>
          <div className="text-[10px] tracking-[0.1em] text-white/38 mt-0.5">
            {continuation ? 'SUITE DE LA VEILLE' : dur != null ? fmtDuration(dur) : timed ? 'À CETTE HEURE' : 'SANS HEURE'}
            {crosses && !continuation && <span className="text-[rgb(var(--c))]"> · +1J</span>}
          </div>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Check e={e} />
            <EntityGlyph e={e} size={11} />
            <button onClick={() => (can.edit(e) ? onEdit() : openEntity(e.id))} className={`text-[14.5px] text-left truncate max-w-full hover:text-white ${done ? 'line-through text-white/40' : 'text-white/90'}`}>
              {displayTitle(e)}
            </button>
            <span className="mono text-[8.5px] tracking-[0.13em] text-[rgb(var(--c)/0.75)] flex-none">{kindTag(e)}</span>
          </div>
          {linked.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {linked.slice(0, 6).map((n) => (
                <EntityChip key={n.entity.id} id={n.entity.id} compact onRemove={() => unlink(e.id, n.entity.id)} />
              ))}
            </div>
          )}
          {timed && <DayBar start={w.start!} end={w.end} />}
        </div>
        <div className="flex gap-1 opacity-40 group-hover:opacity-100 transition-opacity">
          <button className="btn btn-ghost !px-2" title="Voir dans le réseau" onClick={() => openEntity(e.id)}>
            ◎
          </button>
          {can.edit(e) && (
            <button className="btn btn-ghost !px-2" title="Modifier" onClick={onEdit}>
              ✎
            </button>
          )}
        </div>
      </div>
      {editing && (
        <div className="ml-4 mb-3 p-4 glass border-l-2 border-[rgb(var(--c)/0.75)] anim-pop">
          <input
            value={e.title}
            onChange={(ev) => update(e.id, { title: ev.target.value })}
            placeholder="Titre"
            className="w-full bg-transparent outline-none text-[18px] font-semibold text-white placeholder:text-white/25"
            autoFocus
          />
          <div className="mt-3">
            <WhenFields e={e} compact />
          </div>
          <ConnectionsSection id={e.id} label="Relié à" />
          <div className="mt-4 flex justify-between">
            <button className="btn" onClick={onEdit}>
              Fermer
            </button>
            <DeleteButton id={e.id} />
          </div>
        </div>
      )}
    </div>
  );
}

function DueRow({ e }: { e: Entity }) {
  const openEntity = useUI((s) => s.openEntity);
  const kinds = useKinds();
  const late = isLate(e);
  return (
    <div className="flex items-center gap-3 py-1.5 pl-4 pr-3 border-l-2 border-dashed border-white/12" style={natureVar(natureOf(e, kinds))}>
      <Check e={e} />
      <span className={`mono text-[10px] tracking-[0.12em] w-[118px] flex-none ${late ? 'text-[rgb(var(--alert))]' : 'text-white/50'}`}>
        ⟶ {late ? 'EN RETARD' : 'ÉCHÉANCE'}
      </span>
      <EntityGlyph e={e} size={10} />
      <button onClick={() => openEntity(e.id)} className={`text-[13px] truncate hover:text-white ${e.status === 'done' ? 'line-through text-white/35' : 'text-white/75'}`}>
        {displayTitle(e)}
      </button>
    </div>
  );
}

/** Ajout rapide : la même capture qu'avec Ctrl K, posée sur le jour choisi */
function QuickAdd({ date, setDate, inputRef }: { date: string; setDate: (d: string) => void; inputRef: RefObject<HTMLInputElement | null> }) {
  const entities = useData((s) => s.entities);
  const toast = useUI((s) => s.toast);
  const [text, setText] = useState('');
  const parsed = useMemo(() => (text.trim() ? parseCapture(text, entities) : null), [text, entities]);
  const add = () => {
    if (!parsed) return;
    const { entity } = commitCapture(parsed, { defaults: { date, kind: parsed.kind || (parsed.start != null ? 'créneau' : '') } });
    toast({ text: `AGENDA · ${entity.when ? fmtWhen(entity.when) : ''} · ${displayTitle(entity)}`, color: NATURES.temps.hex });
    setText('');
  };
  const w = parsed ? whenOf(parsed) : null;
  return (
    <div className="glass neon p-3 flex flex-wrap items-center gap-2 relative" style={natureVar('temps')}>
      <Corners />
      <span className="hud text-[10px] text-[rgb(var(--c))] mr-1">+ Moment</span>
      <input type="date" className="field field-mono !w-[150px]" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
      <input
        ref={inputRef}
        className="field flex-1 min-w-[260px]"
        placeholder="ex : 14h-15h30 Dentiste @Santé · 7h02 Réveil course · Anniversaire de Léa"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && add()}
      />
      <button className="btn btn-primary" onClick={add} disabled={!parsed}>
        Ajouter
      </button>
      {parsed && (
        <div className="w-full mono text-[9.5px] tracking-[0.1em] text-white/40 pl-1">
          → {w ? fmtWhen({ ...w, date: parsed.date ?? date }) : `${relativeDay(date)?.toUpperCase() ?? date} · TOUTE LA JOURNÉE`} · « {parsed.title || 'sans titre'} »
          {parsed.refs.length > 0 && ` · relié à ${parsed.refs.map((r) => r.raw).join(', ')}`}
        </div>
      )}
    </div>
  );
}

function Agenda() {
  const today = todayISO();
  const [range, setRange] = useState({ from: addDays(today, -3), to: addDays(today, 24) });
  const [editing, setEditing] = useState<string | null>(null);
  const [addDate, setAddDate] = useState(today);
  const setView = useUI((s) => s.setView);
  const moments = useData(useShallow((s) => Object.values(s.entities).filter((e) => !!e.when)));
  const dues = useData(useShallow((s) => Object.values(s.entities).filter((e) => !!e.due)));
  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const todayRef = useRef<HTMLElement>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const prependFrom = useRef<number | null>(null);
  const [now, setNow] = useState(minutesNow());
  const perm = useCan();

  useEffect(() => {
    const id = window.setInterval(() => setNow(minutesNow()), 30000);
    return () => window.clearInterval(id);
  }, []);

  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) out.push(d);
    return out;
  }, [range]);

  const byDay = useMemo(() => {
    const m = new Map<string, { e: Entity; cont: boolean }[]>();
    const push = (d: string, e: Entity, cont: boolean) => {
      if (!m.has(d)) m.set(d, []);
      m.get(d)!.push({ e, cont });
    };
    for (const e of moments) {
      const w = e.when!;
      push(w.date, e, false);
      if (w.start != null && w.end != null && crossesMidnight(w.start, w.end) && w.end > 0) push(addDays(w.date, 1), e, true);
    }
    const key = (x: { e: Entity; cont: boolean }) => (x.cont ? -1 : x.e.when!.start == null ? -2 : x.e.when!.start);
    for (const list of m.values()) list.sort((a, b) => key(a) - key(b));
    return m;
  }, [moments]);

  const dueByDay = useMemo(() => {
    const m = new Map<string, Entity[]>();
    for (const e of dues) {
      if (!m.has(e.due!)) m.set(e.due!, []);
      m.get(e.due!)!.push(e);
    }
    return m;
  }, [dues]);

  useLayoutEffect(() => {
    const sc = scrollRef.current;
    const t = todayRef.current;
    if (sc && t) sc.scrollTop = t.offsetTop - 8;
  }, []);

  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    let armed = false;
    const arm = window.setTimeout(() => (armed = true), 300);
    const io = new IntersectionObserver(
      (entries) => {
        if (!armed) return;
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          if (en.target === bottomRef.current) setRange((r) => ({ ...r, to: addDays(r.to, 21) }));
          if (en.target === topRef.current && prependFrom.current == null) {
            prependFrom.current = sc.scrollHeight;
            setRange((r) => ({ ...r, from: addDays(r.from, -14) }));
          }
        }
      },
      { root: sc, rootMargin: '300px 0px' },
    );
    if (topRef.current) io.observe(topRef.current);
    if (bottomRef.current) io.observe(bottomRef.current);
    return () => {
      window.clearTimeout(arm);
      io.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (sc && prependFrom.current != null) {
      sc.scrollTop += sc.scrollHeight - prependFrom.current;
      prependFrom.current = null;
    }
  }, [range.from]);

  const jumpToday = () => {
    const sc = scrollRef.current;
    const t = todayRef.current;
    if (sc && t) sc.scrollTo({ top: t.offsetTop - 8, behavior: 'smooth' });
  };

  return (
    <div className="fixed inset-0 z-30 anim-fade" data-ui>
      <div className="backdrop" onClick={() => setView('network')} />
      <div className="absolute left-1/2 -translate-x-1/2 top-5 bottom-5 w-[min(1080px,calc(100vw-48px))] flex flex-col">
        <div className="flex items-end justify-between mb-4 gap-4">
          <div>
            <div className="hud text-[10px]" style={{ color: NATURES.temps.hex }}>
              Vue agenda · tout ce qui a un moment
            </div>
            <div className="text-[28px] font-semibold tracking-tight text-white mt-1">
              {fmtDateLong(today).replace(/^./, (c) => c.toUpperCase())}
              <span className="mono text-[14px] font-normal text-white/40 ml-3">{fmtTime(now)}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <button className="btn" onClick={jumpToday}>
              Aujourd'hui
            </button>
            <button className="btn" onClick={() => setView('network')}>
              ← Réseau <span className="text-white/35 ml-1">Tab</span>
            </button>
          </div>
        </div>

        {perm.write() && <QuickAdd date={addDate} setDate={setAddDate} inputRef={addRef} />}

        <div ref={scrollRef} className="flex-1 overflow-y-auto scroll-thin mt-4 pr-2 relative">
          <div ref={topRef} className="h-px" />
          {days.map((d) => {
            const items = byDay.get(d) ?? [];
            const due = dueByDay.get(d) ?? [];
            const isToday = d === today;
            const past = d < today;
            const total = items.filter((x) => !x.cont && x.e.when!.start != null && x.e.when!.end != null).reduce((acc, x) => acc + slotDuration(x.e.when!.start!, x.e.when!.end!), 0);
            const rel = relativeDay(d);
            let nowPlaced = !isToday;
            return (
              <section key={d} ref={isToday ? todayRef : undefined} className={`mb-2 ${past ? 'opacity-55' : ''}`}>
                <div className="sticky top-0 z-10 flex items-center gap-3 py-2.5 bg-black/80 backdrop-blur-md border-b border-white/[0.05]">
                  <span className={`hud text-[11.5px] ${isToday ? 'text-white' : 'text-white/70'}`}>{fmtDateLong(d)}</span>
                  {rel && (
                    <span className={`hud text-[9px] px-1.5 py-px border ${isToday ? 'text-[rgb(var(--aqua))] border-[rgb(var(--aqua)/0.5)]' : 'text-white/50 border-white/15'}`}>{rel}</span>
                  )}
                  <span className="ml-auto mono text-[10px] tracking-[0.1em] text-white/35">
                    {items.filter((x) => !x.cont).length} MOMENT{items.filter((x) => !x.cont).length > 1 ? 'S' : ''}
                    {total > 0 && ` · ${fmtDuration(total)}`}
                  </span>
                  <button
                    className="btn btn-ghost !px-2 !py-0.5"
                    title="Ajouter un moment ce jour-là"
                    onClick={() => {
                      setAddDate(d);
                      addRef.current?.focus();
                    }}
                  >
                    +
                  </button>
                </div>
                <div className="pt-1">
                  {items.length === 0 && due.length === 0 && <div className="mono text-[10.5px] text-white/18 py-2 pl-4 tracking-[0.14em]">— LIBRE —</div>}
                  {items.map(({ e, cont }) => {
                    const row = (
                      <MomentRow
                        key={`${e.id}${cont ? '-c' : ''}`}
                        e={e}
                        continuation={cont}
                        editing={!cont && editing === e.id}
                        onEdit={() => setEditing((x) => (x === e.id ? null : e.id))}
                      />
                    );
                    if (!nowPlaced && !cont && e.when!.start != null && e.when!.start > now) {
                      nowPlaced = true;
                      return [<NowLine key="now" now={now} />, row];
                    }
                    return row;
                  })}
                  {!nowPlaced && <NowLine now={now} />}
                  {due.map((e) => (
                    <DueRow key={e.id} e={e} />
                  ))}
                </div>
              </section>
            );
          })}
          <div ref={bottomRef} className="h-10 flex items-center justify-center hud text-[9px] text-white/20">
            chargement des jours suivants…
          </div>
        </div>
        <div className="hud text-[9px] text-white/30 mt-3 flex gap-4 justify-center">
          <span>Heures libres à la minute près : 12h01 → 17h38</span>
          <span>Tout neurone peut avoir un moment : facette « Moment » dans son panneau</span>
          <span>
            <Kbd>Tab</Kbd> fermer
          </span>
        </div>
      </div>
    </div>
  );
}

function NowLine({ now }: { now: number }) {
  return (
    <div className="flex items-center gap-2 my-1.5 pl-1">
      <span className="w-2 h-2 rotate-45 bg-[rgb(var(--alert))]" />
      <span className="mono text-[10px] tracking-[0.16em] text-[rgb(var(--alert))]">MAINTENANT · {fmtTime(now)}</span>
      <span className="flex-1 h-px bg-gradient-to-r from-[rgb(var(--alert)/0.8)] to-transparent" />
    </div>
  );
}

export function AgendaView() {
  const view = useUI((s) => s.view);
  return view === 'agenda' ? <Agenda /> : null;
}
