import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { displayTitle, useData } from '../store/data';
import { useUI } from '../store/ui';
import { addDays, DAY_SHORT, fmtHM, fmtTime, fromISODate, MONTH_NAMES, minutesNow, mondayOf, slotDuration, todayISO } from '../lib/time';
import { tagsOf, type Project, type Slot, type Task } from '../types';
import { Corners, cvar, Kbd } from './common';
import { BodyPreview, LinksSection, ProjectSelect, Section, TagEditor } from './fields';
import { TimeInput } from './TimeInput';
import { DeleteButton } from './DetailPanel';
import { useCanWrite, useEditLock } from '../sync/lock';
import { LEVEL, useBackLayer } from '../lib/back';

/**
 * Emploi du temps : une semaine en grille, les heures à gauche, un jour par colonne (comme un relevé d'heures).
 * Chaque créneau affiche son projet (ou « Sans projet ») et « 07:00 → 17:20 · 10 h 20 ».
 * Glisser dans la grille crée un créneau ; on déplace un créneau en le glissant, on change sa durée par le bas.
 */
const HOUR = 48; // px par heure
const SNAP = 15; // minutes
const GUTTER = 58; // colonne des heures (px)

const snap = (m: number) => Math.round(m / SNAP) * SNAP;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

interface Seg {
  key: string;
  kind: 'slot' | 'task';
  id: string;
  day: number; // 0..6 dans la semaine affichée
  from: number;
  to: number;
  lane: number;
  lanes: number;
  /** 2e partie d'un créneau qui passe minuit */
  cont?: boolean;
}

/** Les créneaux et tâches horodatées de la semaine, découpés par jour et rangés en colonnes s'ils se chevauchent */
function layoutWeek(week: string[], slots: Slot[], tasks: Task[]): Seg[] {
  const index = new Map(week.map((d, i) => [d, i]));
  const segs: Seg[] = [];
  const add = (s: Omit<Seg, 'lane' | 'lanes'>) => {
    if (s.day >= 0 && s.to > s.from) segs.push({ ...s, lane: 0, lanes: 1 });
  };
  for (const s of slots) {
    const d0 = index.get(s.date);
    const crosses = s.end <= s.start;
    if (d0 !== undefined) add({ key: s.id, kind: 'slot', id: s.id, day: d0, from: s.start, to: crosses ? 1440 : s.end });
    if (crosses && s.end > 0) {
      const d1 = index.get(addDays(s.date, 1));
      if (d1 !== undefined) add({ key: `${s.id}-c`, kind: 'slot', id: s.id, day: d1, from: 0, to: s.end, cont: true });
    }
  }
  for (const t of tasks) {
    const d = index.get(t.date!);
    if (d !== undefined && t.time != null) add({ key: t.id, kind: 'task', id: t.id, day: d, from: t.time, to: Math.min(1440, t.time + 30) });
  }
  // par jour : groupes qui se chevauchent, puis une colonne par élément simultané
  for (let day = 0; day < 7; day++) {
    const list = segs.filter((s) => s.day === day).sort((a, b) => a.from - b.from || b.to - a.to);
    let group: Seg[] = [];
    let groupEnd = -1;
    const flush = () => {
      const ends: number[] = [];
      for (const s of group) {
        let lane = ends.findIndex((e) => e <= s.from);
        if (lane < 0) {
          lane = ends.length;
          ends.push(s.to);
        } else ends[lane] = s.to;
        s.lane = lane;
      }
      for (const s of group) s.lanes = ends.length;
      group = [];
    };
    for (const s of list) {
      if (group.length && s.from >= groupEnd) flush();
      group.push(s);
      groupEnd = Math.max(groupEnd, s.to);
    }
    if (group.length) flush();
  }
  return segs;
}

function weekTitle(monday: string): string {
  const a = fromISODate(monday);
  const b = fromISODate(addDays(monday, 6));
  const same = a.getMonth() === b.getMonth();
  return `Semaine du ${a.getDate()}${same ? '' : ` ${MONTH_NAMES[a.getMonth()]}`} au ${b.getDate()} ${MONTH_NAMES[b.getMonth()]} ${b.getFullYear()}`;
}

type Drag =
  | { mode: 'create'; day: number; anchor: number; cur: number; moved: boolean }
  | { mode: 'move' | 'resize'; id: string; x0: number; y0: number; dDay: number; dMin: number; moved: boolean; slot: Slot };

/** Panneau du créneau ouvert (à droite de la grille) : tout se règle sans quitter l'emploi du temps */
function SlotPanel({ s, onClose }: { s: Slot; onClose: () => void }) {
  const update = useData((st) => st.update);
  const project = useData((st) => (s.projectId ? (st.entities[s.projectId] as Project | undefined) : undefined));
  const openEntity = useUI((st) => st.openEntity);
  const lock = useEditLock(s.id);
  const ro = !lock.canWrite;
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!s.title && !ro) titleRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id]);
  const dur = slotDuration(s.start, s.end);
  return (
    <aside
      className="w-[380px] max-md:w-full flex-none glass neon bg-[rgb(7_7_12/0.96)] flex flex-col anim-panel min-h-0 max-md:absolute max-md:inset-0 max-md:z-20"
      style={cvar(s.color)}
      data-slot-panel
    >
      <Corners />
      <div className="flex items-center gap-2.5 px-5 pt-4 pb-1">
        <span className="dot" />
        <span className="hud text-[10px] text-[rgb(var(--c))]">Créneau</span>
        {lock.holder && <span className="hud text-[9px] text-[#ffb020]">✎ {lock.holder} modifie</span>}
        <button className="btn btn-ghost !px-2 ml-auto" title="Fermer (Échap)" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto scroll-thin px-5 pb-5">
        <input
          ref={titleRef}
          value={s.title}
          readOnly={ro}
          onFocus={lock.claim}
          onChange={(e) => update(s.id, { title: e.target.value })}
          placeholder={project ? displayTitle(project) : 'Sans projet'}
          className="w-full bg-transparent outline-none text-[22px] font-semibold tracking-tight text-white placeholder:text-white/35 mt-2 py-1 border-b border-transparent focus:border-[rgb(var(--c)/0.5)]"
        />
        <div className="mono text-[11px] tracking-[0.08em] text-white/55 mt-1">
          {fmtTime(s.start)} → {fmtTime(s.end)} · {fmtHM(dur)}
          {s.end <= s.start && <span className="text-[#ffb020]"> · finit le lendemain</span>}
        </div>
        <fieldset disabled={ro} className="m-0 p-0 border-0 min-w-0">
          <Section label="Projet">
            <ProjectSelect value={s.projectId ?? null} onChange={(id) => update(s.id, { projectId: id })} empty="Sans projet" />
          </Section>
          <Section label="Jour">
            <input type="date" className="field field-mono" value={s.date} onFocus={lock.claim} onChange={(e) => e.target.value && update(s.id, { date: e.target.value })} />
          </Section>
          <Section label="Horaires">
            <div className="flex items-center gap-2" onFocus={lock.claim}>
              <TimeInput value={s.start} onChange={(m) => m != null && update(s.id, { start: m })} />
              <span className="text-white/40 mono">→</span>
              <TimeInput value={s.end} onChange={(m) => m != null && update(s.id, { end: m })} />
            </div>
          </Section>
          <Section label="Description">
            <BodyPreview e={s} placeholder="Ce que tu fais pendant ce créneau…" readOnly={ro} />
          </Section>
          <Section label="Tags">
            {ro ? <span className="mono text-[11px] text-white/55">{tagsOf(s).length ? tagsOf(s).map((t) => `#${t}`).join('  ') : '—'}</span> : <TagEditor id={s.id} tags={tagsOf(s)} />}
          </Section>
        </fieldset>
        <LinksSection id={s.id} readOnly={ro} pickerLevel={LEVEL.inView + 1} />
        <div className="mt-7 pt-4 border-t border-white/[0.07] flex items-center justify-between gap-3 flex-wrap">
          <button className="btn" onClick={() => openEntity(s.id)}>
            Voir dans le réseau
          </button>
          {!ro && <DeleteButton id={s.id} />}
        </div>
      </div>
    </aside>
  );
}

function Week() {
  const today = todayISO();
  const [monday, setMonday] = useState(() => mondayOf(today));
  const [sel, setSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [now, setNow] = useState(minutesNow());
  const fresh = useRef<string | null>(null);
  const setView = useUI((s) => s.setView);
  const openEntity = useUI((s) => s.openEntity);
  // invité « peut regarder » : il voit l'emploi du temps sans pouvoir le changer
  const lockedView = !useCanWrite();
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const slots = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Slot => e.type === 'slot')));
  const tasks = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Task => e.type === 'task' && !!e.date)));
  const projects = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Project => e.type === 'project' && !!e.deadline)));
  const entities = useData((s) => s.entities);
  const selected = sel ? (entities[sel] as Slot | undefined) : undefined;

  const segs = useMemo(() => layoutWeek(week, slots, tasks), [week, slots, tasks]);
  const totals = useMemo(() => {
    const t = new Array(7).fill(0);
    for (const s of segs) if (s.kind === 'slot') t[s.day] += s.to - s.from;
    return t;
  }, [segs]);
  const weekTotal = totals.reduce((a, b) => a + b, 0);
  const allDay = useMemo(() => {
    const m = week.map(() => [] as (Task | Project)[]);
    const idx = new Map(week.map((d, i) => [d, i]));
    for (const t of tasks) if (t.time == null && idx.has(t.date!)) m[idx.get(t.date!)!].push(t);
    for (const p of projects) if (idx.has(p.deadline!)) m[idx.get(p.deadline!)!].push(p);
    return m;
  }, [week, tasks, projects]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(minutesNow()), 30000);
    return () => window.clearInterval(id);
  }, []);

  // à l'ouverture et à chaque semaine : on montre la matinée (ou l'heure actuelle)
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const target = week.includes(today) ? clamp(now - 90, 0, 1440) : 7 * 60 - 30;
    sc.scrollTop = (target / 60) * HOUR;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monday]);

  /** Fermer le panneau : un créneau créé d'un clic et laissé vide disparaît */
  const close = () => {
    const id = sel;
    setSel(null);
    if (id && fresh.current === id) {
      const d = useData.getState();
      const s = d.entities[id] as Slot | undefined;
      const linked = d.links.some((l) => l.a === id || l.b === id);
      if (s && !s.title.trim() && !s.description.trim() && !s.projectId && !tagsOf(s).length && !linked) d.remove(id, { silent: true });
    }
    fresh.current = null;
  };

  // Échap (ou retour sur le téléphone) : d'abord le panneau du créneau, puis la vue (voir lib/back.ts)
  useBackLayer(!!sel, close, LEVEL.inView);

  /** Position du pointeur dans la grille → jour (0..6) et minute */
  const at = (e: { clientX: number; clientY: number }) => {
    const r = gridRef.current!.getBoundingClientRect();
    const col = (r.width - GUTTER) / 7;
    return { day: clamp(Math.floor((e.clientX - r.left - GUTTER) / col), 0, 6), min: clamp(((e.clientY - r.top) / HOUR) * 60, 0, 1440), col };
  };

  const create = (day: number, from: number, to: number) => {
    const d = useData.getState();
    const end = to >= 1440 ? 0 : to;
    const s = d.createSlot({ date: week[day], start: from, end });
    fresh.current = s.id;
    setSel(s.id);
  };

  const onGridDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (lockedView || e.button !== 0 || e.pointerType === 'touch') return;
    if ((e.target as HTMLElement).closest('[data-block]')) return;
    const p = at(e);
    const m = clamp(Math.floor(p.min / SNAP) * SNAP, 0, 1440 - SNAP);
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ mode: 'create', day: p.day, anchor: m, cur: m, moved: false });
  };
  const onGridMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    if (drag.mode === 'create') {
      const p = at(e);
      const cur = clamp(snap(p.min), 0, 1440);
      if (cur !== drag.cur) setDrag({ ...drag, cur, moved: drag.moved || Math.abs(cur - drag.anchor) >= SNAP });
      return;
    }
    const r = gridRef.current!.getBoundingClientRect();
    const col = (r.width - GUTTER) / 7;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    const moved = drag.moved || Math.abs(dx) > 4 || Math.abs(dy) > 4;
    const dMin = snap((dy / HOUR) * 60);
    const dDay = drag.mode === 'move' ? Math.round(dx / col) : 0;
    if (moved !== drag.moved || dMin !== drag.dMin || dDay !== drag.dDay) setDrag({ ...drag, moved, dMin, dDay });
  };
  const onGridUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag;
    setDrag(null);
    if (!d) return;
    if (d.mode === 'create') {
      if (d.moved) {
        const from = Math.min(d.anchor, d.cur);
        const to = Math.max(d.anchor + SNAP, d.cur);
        create(d.day, from, to);
      } else {
        // un simple clic : un créneau d'une heure à cet endroit
        const from = clamp(Math.floor(at(e).min / SNAP) * SNAP, 0, 1440 - 60);
        create(d.day, from, from + 60);
      }
      return;
    }
    if (!d.moved) {
      setSel(d.id);
      return;
    }
    const s = d.slot;
    const dur = slotDuration(s.start, s.end);
    const update = useData.getState().update;
    if (d.mode === 'move') {
      const start = clamp(s.start + d.dMin, 0, 1440 - SNAP);
      update(s.id, { date: addDays(s.date, d.dDay), start, end: (start + dur) % 1440 });
    } else {
      const nd = clamp(dur + d.dMin, SNAP, 1440 - SNAP);
      update(s.id, { end: (s.start + nd) % 1440 });
    }
  };

  /** Sur un écran tactile : toucher un vide crée un créneau d'une heure */
  const onGridTap = (e: React.MouseEvent<HTMLDivElement>) => {
    if (lockedView || (e.nativeEvent as PointerEvent).pointerType !== 'touch') return;
    if ((e.target as HTMLElement).closest('[data-block]')) return;
    const p = at(e);
    const from = clamp(Math.floor(p.min / 30) * 30, 0, 1440 - 60);
    create(p.day, from, from + 60);
  };

  const blockDown = (e: RPointerEvent<HTMLElement>, s: Slot, mode: 'move' | 'resize') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.pointerType === 'touch' || lockedView) {
      setSel(s.id);
      return;
    }
    gridRef.current?.setPointerCapture(e.pointerId);
    setDrag({ mode, id: s.id, x0: e.clientX, y0: e.clientY, dDay: 0, dMin: 0, moved: false, slot: s });
  };

  const isToday = (i: number) => week[i] === today;
  const ghost = drag?.mode === 'create' && drag.moved ? { day: drag.day, from: Math.min(drag.anchor, drag.cur), to: Math.max(drag.anchor + SNAP, drag.cur) } : null;

  return (
    <div className="fixed inset-0 z-30 anim-fade" data-ui data-week>
      <div className="backdrop bg-black/85" onClick={() => setView('network')} />
      <div className="absolute inset-x-4 top-4 bottom-4 max-md:inset-x-2 max-md:top-2 max-md:bottom-2 flex flex-col">
        {/* en-tête : la semaine, son total, navigation */}
        <div className="flex items-end justify-between mb-3 gap-4 flex-wrap">
          <div>
            <div className="hud text-[10px] text-[#ffb020]">Emploi du temps</div>
            <div className="text-[24px] max-md:text-[18px] font-semibold tracking-tight text-white mt-1">
              {weekTitle(monday)}
              <span className="mono text-[13px] font-normal text-white/45 ml-3">{weekTotal ? `${fmtHM(weekTotal)} planifiées` : 'aucun créneau'}</span>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button className="btn" title="Semaine précédente" onClick={() => setMonday(addDays(monday, -7))}>
              ‹
            </button>
            <button className="btn" onClick={() => setMonday(mondayOf(today))}>
              Aujourd’hui
            </button>
            <button className="btn" title="Semaine suivante" onClick={() => setMonday(addDays(monday, 7))}>
              ›
            </button>
            {!lockedView && (
              <button
                className="btn btn-primary"
                style={cvar('#ffb020')}
                onClick={() => {
                  const i = week.includes(today) ? week.indexOf(today) : 0;
                  const from = week.includes(today) ? clamp(Math.ceil(now / SNAP) * SNAP, 0, 1440 - 60) : 9 * 60;
                  create(i, from, from + 60);
                }}
              >
                + Créneau
              </button>
            )}
            <button className="btn" onClick={() => setView('network')}>
              ← Réseau <span className="text-white/35 ml-1 max-md:hidden">Tab</span>
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 flex gap-3 relative">
          <div className="flex-1 min-w-0 glass bg-[rgb(7_7_12/0.94)] flex flex-col min-h-0">
            {/* jours */}
            <div className="flex border-b border-white/[0.08] flex-none" style={{ paddingLeft: GUTTER }}>
              {week.map((d, i) => {
                const dt = fromISODate(d);
                return (
                  <div key={d} className={`flex-1 min-w-0 px-2 py-2 border-l border-white/[0.06] ${isToday(i) ? 'bg-[#00e5ff]/[0.07]' : ''}`}>
                    <div className={`hud text-[10.5px] ${isToday(i) ? 'text-[#00e5ff]' : i >= 5 ? 'text-white/45' : 'text-white/75'}`}>
                      {DAY_SHORT[dt.getDay()]} {dt.getDate()}
                    </div>
                    <div className="mono text-[9.5px] text-white/35 mt-0.5 truncate">{totals[i] ? fmtHM(totals[i]) : '—'}</div>
                  </div>
                );
              })}
            </div>
            {/* toute la journée : tâches datées sans heure, échéances des projets */}
            {allDay.some((x) => x.length) && (
              <div className="flex border-b border-white/[0.08] flex-none max-h-[84px] overflow-y-auto scroll-thin" style={{ paddingLeft: GUTTER }}>
                {allDay.map((items, i) => (
                  <div key={week[i]} className="flex-1 min-w-0 px-1 py-1 border-l border-white/[0.06] flex flex-col gap-1">
                    {items.map((e) => (
                      <button
                        key={e.id}
                        onClick={() => openEntity(e.id)}
                        className="text-left truncate mono text-[9.5px] tracking-[0.04em] px-1.5 py-0.5 border border-[rgb(var(--c)/0.5)] bg-[rgb(var(--c)/0.1)] text-white/85 hover:bg-[rgb(var(--c)/0.2)]"
                        style={cvar(e.color)}
                        title={e.type === 'project' ? `Échéance du projet ${displayTitle(e)}` : `Tâche : ${displayTitle(e)}`}
                      >
                        {e.type === 'project' ? '⚑ ' : e.status === 'done' ? '✓ ' : '◆ '}
                        <span className={e.type === 'task' && e.status === 'done' ? 'line-through opacity-60' : ''}>{displayTitle(e)}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {/* la grille des heures */}
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scroll-thin relative">
              <div
                ref={gridRef}
                className="relative select-none"
                style={{ height: 24 * HOUR, cursor: lockedView ? 'default' : 'crosshair', touchAction: drag ? 'none' : 'pan-y' }}
                onPointerDown={onGridDown}
                onPointerMove={onGridMove}
                onPointerUp={onGridUp}
                onPointerCancel={() => setDrag(null)}
                onClick={onGridTap}
              >
                {/* lignes des heures et des demi-heures */}
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="absolute left-0 right-0 pointer-events-none" style={{ top: h * HOUR }}>
                    <div className="absolute left-0 w-[52px] text-right mono text-[10px] text-white/35 -translate-y-1/2 pr-1">{h ? `${String(h).padStart(2, '0')}:00` : ''}</div>
                    <div className="absolute right-0 h-px bg-white/[0.07]" style={{ left: GUTTER }} />
                    <div className="absolute right-0 h-px bg-white/[0.03]" style={{ left: GUTTER, top: HOUR / 2 }} />
                  </div>
                ))}
                {/* colonnes des jours */}
                <div className="absolute top-0 bottom-0 right-0 flex pointer-events-none" style={{ left: GUTTER }}>
                  {week.map((d, i) => (
                    <div key={d} className={`flex-1 border-l border-white/[0.06] ${isToday(i) ? 'bg-[#00e5ff]/[0.035]' : i >= 5 ? 'bg-white/[0.015]' : ''}`} />
                  ))}
                </div>
                {/* les créneaux */}
                <div className="absolute top-0 bottom-0 right-0" style={{ left: GUTTER }}>
                  {segs.map((g) => {
                    const e = entities[g.id];
                    if (!e) return null;
                    const moving = drag && drag.mode !== 'create' && drag.id === g.id && drag.moved ? drag : null;
                    let from = g.from;
                    let to = g.to;
                    let day = g.day;
                    if (moving && !g.cont) {
                      if (moving.mode === 'move') {
                        from = clamp(g.from + moving.dMin, 0, 1440 - SNAP);
                        to = from + (g.to - g.from);
                        day = clamp(g.day + moving.dDay, 0, 6);
                      } else to = clamp(g.to + moving.dMin, g.from + SNAP, 1440);
                    }
                    const w = 100 / 7;
                    const style = {
                      ...cvar(e.color),
                      top: (from / 60) * HOUR + 1,
                      height: Math.max(18, ((to - from) / 60) * HOUR - 2),
                      left: `calc(${day * w}% + ${(g.lane / g.lanes) * (100 / 7)}% + 2px)`,
                      width: `calc(${w / g.lanes}% - 4px)`,
                    };
                    if (g.kind === 'task') {
                      const t = e as Task;
                      return (
                        <button
                          key={g.key}
                          data-block
                          className="absolute text-left px-1.5 border border-dashed border-[rgb(var(--c)/0.7)] bg-black/50 hover:bg-[rgb(var(--c)/0.12)] overflow-hidden"
                          style={{ ...style, height: 20 }}
                          onPointerDown={(ev) => ev.stopPropagation()}
                          onClick={() => openEntity(t.id)}
                          title={`Tâche · ${displayTitle(t)} · ${fmtTime(t.time)}`}
                        >
                          <span className={`mono text-[9.5px] text-white/85 truncate block ${t.status === 'done' ? 'line-through opacity-60' : ''}`}>
                            ◆ {fmtTime(t.time)} {displayTitle(t)}
                          </span>
                        </button>
                      );
                    }
                    const s = e as Slot;
                    const proj = s.projectId ? (entities[s.projectId] as Project | undefined) : undefined;
                    const name = s.title.trim() || (proj ? displayTitle(proj) : 'Sans projet');
                    const h = (to - from) / 60;
                    return (
                      <div
                        key={g.key}
                        data-block
                        data-slot={s.id}
                        className={`absolute overflow-hidden border-l-[3px] border-[rgb(var(--c))] bg-[rgb(var(--c)/0.16)] hover:bg-[rgb(var(--c)/0.24)] transition-colors ${
                          sel === s.id ? 'shadow-[0_0_0_1px_rgb(var(--c)),0_0_22px_rgb(var(--c)/0.45)]' : ''
                        } ${moving ? 'opacity-85 z-10' : ''}`}
                        style={{ ...style, cursor: lockedView ? 'pointer' : moving ? 'grabbing' : 'grab' }}
                        onPointerDown={(ev) => blockDown(ev, s, 'move')}
                      >
                        <div className="px-2 py-1 pointer-events-none">
                          <div className="text-[12px] font-semibold text-white truncate leading-tight">{name}</div>
                          {h >= 0.6 && (
                            <div className="mono text-[10px] text-white/70 truncate mt-0.5">
                              {fmtTime(s.start)} → {fmtTime(s.end)} · {fmtHM(slotDuration(s.start, s.end))}
                            </div>
                          )}
                          {h >= 1.1 && s.title.trim() && <div className="mono text-[9.5px] text-[rgb(var(--c))] truncate mt-0.5">{proj ? displayTitle(proj) : 'Sans projet'}</div>}
                        </div>
                        {!g.cont && !lockedView && (
                          <div className="absolute left-0 right-0 bottom-0 h-[7px] cursor-ns-resize" onPointerDown={(ev) => blockDown(ev, s, 'resize')} title="Glisser pour changer la durée" />
                        )}
                      </div>
                    );
                  })}
                  {/* créneau en train d'être dessiné */}
                  {ghost && (
                    <div
                      className="absolute border-l-[3px] border-[#ffb020] bg-[#ffb020]/20 pointer-events-none"
                      style={{ top: (ghost.from / 60) * HOUR, height: ((ghost.to - ghost.from) / 60) * HOUR, left: `calc(${(ghost.day * 100) / 7}% + 2px)`, width: `calc(${100 / 7}% - 4px)` }}
                    >
                      <div className="mono text-[10px] text-white px-2 py-1">
                        {fmtTime(ghost.from)} → {fmtTime(ghost.to)} · {fmtHM(ghost.to - ghost.from)}
                      </div>
                    </div>
                  )}
                  {/* maintenant */}
                  {week.includes(today) && (
                    <div className="absolute h-0 pointer-events-none z-20" style={{ top: (now / 60) * HOUR, left: `${(week.indexOf(today) * 100) / 7}%`, width: `${100 / 7}%` }}>
                      <div className="h-px bg-[#ff2e88] shadow-[0_0_8px_#ff2e88]" />
                      <div className="absolute -left-1 -top-[4px] w-2 h-2 rotate-45 bg-[#ff2e88] shadow-[0_0_10px_#ff2e88]" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          {selected && selected.type === 'slot' && <SlotPanel key={selected.id} s={selected} onClose={close} />}
        </div>

        <div className="hud text-[9px] text-white/30 mt-2.5 flex gap-4 justify-center flex-wrap max-md:hidden">
          <span>Glisse dans la grille pour créer un créneau</span>
          <span>Glisse un créneau pour le déplacer · son bas pour changer sa durée</span>
          <span>Clic pour l’ouvrir</span>
          <span>
            <Kbd>Tab</Kbd> fermer
          </span>
        </div>
      </div>
    </div>
  );
}

export function AgendaView() {
  const view = useUI((s) => s.view);
  return view === 'agenda' ? <Week /> : null;
}
