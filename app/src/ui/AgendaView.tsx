import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { displayTitle, useData } from '../store/data';
import { useUI } from '../store/ui';
import { readKey, writeKey } from '../store/storage';
import { addDays, DAY_NAMES, DAY_SHORT, fmtDay, fmtHM, fmtTime, fromISODate, MONTH_NAMES, minutesNow, mondayOf, slotDuration, todayISO } from '../lib/time';
import { TYPE_ACCENT } from '../lib/color';
import { isNarrow, outsideClick, useNarrow } from '../lib/useNarrow';
import { bodyOf, hasProject, tagsOf, TYPE_LABEL, type Entity, type EntityType, type Note, type Project, type Slot, type Task } from '../types';
import { Corners, cvar, Kbd } from './common';
import { BodyPreview, LinksSection, NoteFields, ProjectFields, ProjectSelect, Section, TagEditor, TaskFields } from './fields';
import { TimeInput } from './TimeInput';
import { DeleteButton } from './DetailPanel';
import { LEVEL, useBackLayer } from '../lib/back';
import { useCoverMobileNav } from './MobileNav';

/**
 * Agenda (V8, l'ancien « emploi du temps ») : l'espace central d'organisation. Une semaine en grille, les heures à
 * gauche, un jour par colonne, qui accueille tout ce qui s'organise :
 *  - les créneaux (un bloc avec sa durée, son projet ou « Sans projet ») ;
 *  - les tâches (à leur heure ; « toute la journée » si elles n'ont qu'un jour) ;
 *  - les notes (V8 : une note peut avoir un jour, et une heure) ;
 *  - les projets (leur échéance, dans « toute la journée »).
 * Glisser dans la grille (ou toucher un vide) ajoute un créneau, comme avant ; le panneau qui s'ouvre permet d'en faire
 * une tâche, une note ou un projet. « + Ajouter » fait de même, maintenant. Glisser un créneau, une tâche ou une note le
 * déplace ; le bas d'un créneau change sa durée. « À planifier » : les tâches sans date, à glisser dans la semaine.
 * Tout s'ouvre à côté de la semaine, sans quitter l'agenda.
 */
const HOUR = 48; // px par heure
const SNAP = 15; // minutes
const GUTTER = 58; // colonne des heures (px)
/** une tâche ou une note occupe une demi-heure dans la grille (elles n'ont pas de durée) */
const ITEM_MIN = 30;
const PLAN_KEY = 'synapse-agenda-a-planifier';

const snap = (m: number) => Math.round(m / SNAP) * SNAP;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

type Kind = 'slot' | 'task' | 'note';

interface Seg {
  key: string;
  kind: Kind;
  id: string;
  day: number; // 0..6 dans la semaine affichée
  from: number;
  to: number;
  lane: number;
  lanes: number;
  /** 2e partie d'un créneau qui passe minuit */
  cont?: boolean;
}

/** Les créneaux, tâches et notes à heure fixe de la semaine, découpés par jour et rangés en colonnes s'ils se chevauchent */
function layoutWeek(week: string[], slots: Slot[], tasks: Task[], notes: Note[]): Seg[] {
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
    const d = t.date ? index.get(t.date) : undefined;
    if (d !== undefined && t.time != null) add({ key: t.id, kind: 'task', id: t.id, day: d, from: t.time, to: Math.min(1440, t.time + ITEM_MIN) });
  }
  for (const n of notes) {
    const d = n.date ? index.get(n.date) : undefined;
    if (d !== undefined && n.time != null) add({ key: n.id, kind: 'note', id: n.id, day: d, from: n.time, to: Math.min(1440, n.time + ITEM_MIN) });
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

/** Où ajouter : un jour, et une heure (ou rien : toute la journée), avec la durée d'un créneau */
interface At {
  date: string;
  start: number | null;
  end: number | null;
}

/** Ce qu'on garde d'un élément quand il change de sorte (tout juste créé : créneau → tâche…) */
interface Carry {
  title: string;
  tags: string[];
  projectId: string | null;
  body: string;
}
function carryOf(e: Entity): Carry {
  return { title: e.title, tags: tagsOf(e), projectId: hasProject(e) ? e.projectId : null, body: bodyOf(e) };
}

function createAt(type: EntityType, at: At, c?: Carry): Entity {
  const d = useData.getState();
  const base = c ? { title: c.title, tags: c.tags } : {};
  const projectId = c?.projectId ?? null;
  const body = c?.body ?? '';
  switch (type) {
    case 'slot': {
      const start = at.start ?? 9 * 60;
      const end = at.end ?? (start + 60) % 1440;
      return d.createSlot({ ...base, projectId, description: body, date: at.date, start, end });
    }
    case 'task':
      return d.createTask({ ...base, projectId, description: body, date: at.date, time: at.start });
    case 'note':
      return d.createNote({ ...base, projectId, content: body, date: at.date, time: at.start });
    case 'project':
      return d.createProject({ ...base, description: body, deadline: at.date });
  }
}

/** Un élément tout juste ajouté depuis l'agenda : on peut encore choisir ce que c'est */
interface Fresh {
  id: string;
  at: At;
}

const ADD_TYPES: EntityType[] = ['slot', 'task', 'note', 'project'];

type Drag =
  | { mode: 'create'; day: number; anchor: number; cur: number; moved: boolean }
  | { mode: 'move' | 'resize'; id: string; kind: Kind; x0: number; y0: number; dDay: number; dMin: number; moved: boolean; date: string; start: number; end: number };

/** Une tâche glissée depuis « À planifier » : où elle tomberait (un jour, une heure ou toute la journée) */
interface PlanDrag {
  id: string;
  x: number;
  y: number;
  at: { day: number; min: number | null } | null;
}

/** Le créneau ouvert : ses horaires, son projet, son jour… (comme avant) */
function SlotBody({ s }: { s: Slot }) {
  const update = useData((st) => st.update);
  const dur = slotDuration(s.start, s.end);
  return (
    <>
      <div className="mono text-[11px] tracking-[0.08em] text-white/55 mt-1">
        {fmtTime(s.start)} → {fmtTime(s.end)} · {fmtHM(dur)}
        {s.end <= s.start && <span className="text-[#ffb020]"> · finit le lendemain</span>}
      </div>
      <Section label="Projet">
        <ProjectSelect value={s.projectId ?? null} onChange={(id) => update(s.id, { projectId: id })} empty="Sans projet" />
      </Section>
      <Section label="Jour">
        <input type="date" className="field field-mono" value={s.date} onChange={(e) => e.target.value && update(s.id, { date: e.target.value })} />
      </Section>
      <Section label="Horaires">
        <div className="flex items-center gap-2">
          <TimeInput value={s.start} onChange={(m) => m != null && update(s.id, { start: m })} />
          <span className="text-white/40 mono">→</span>
          <TimeInput value={s.end} onChange={(m) => m != null && update(s.id, { end: m })} />
        </div>
      </Section>
      <Section label="Description">
        <BodyPreview e={s} placeholder="Ce que tu fais pendant ce créneau…" />
      </Section>
    </>
  );
}

const TITLE_HINT: Record<EntityType, string> = { slot: 'Sans projet', task: 'Nouvelle tâche', note: 'Nouvelle note', project: 'Nouveau projet' };

/** L'élément ouvert, à côté de la semaine : tout se règle sans quitter l'agenda */
function AgendaPanel({ e, fresh, onConvert, onClose }: { e: Entity; fresh: boolean; onConvert: (t: EntityType) => void; onClose: () => void }) {
  const update = useData((st) => st.update);
  const project = useData((st) => (e.type === 'slot' && e.projectId ? (st.entities[e.projectId] as Project | undefined) : undefined));
  const openEntity = useUI((st) => st.openEntity);
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!e.title) titleRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e.id]);
  return (
    <aside
      className="w-[380px] max-md:w-full flex-none glass neon bg-[rgb(7_7_12/0.96)] flex flex-col anim-panel min-h-0 max-md:fixed max-md:inset-0 max-md:z-50 max-md:pt-[env(safe-area-inset-top)] max-md:pb-[env(safe-area-inset-bottom)] max-md:bg-[rgb(7_7_12/0.99)]"
      style={cvar(e.color)}
      data-agenda-panel={e.type}
      data-slot-panel={e.type === 'slot' ? '' : undefined}
    >
      <Corners />
      <div className="flex items-center gap-2.5 px-5 pt-4 pb-1">
        <span className="dot" />
        <span className="hud text-[10px] text-[rgb(var(--c))]">{fresh ? 'Ajouter' : TYPE_LABEL[e.type]}</span>
        <button className="btn btn-ghost !px-2 ml-auto" title="Fermer (Échap)" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain scroll-thin px-5 max-md:px-4 pb-5">
        {/* tout juste ajouté : ce que c'est (un créneau, sinon une tâche, une note, un projet) */}
        {fresh && (
          <div className="seg mt-2 w-full" data-agenda-type>
            {ADD_TYPES.map((t) => (
              <button key={t} className="flex-1" data-on={e.type === t ? '1' : '0'} data-type={t} style={cvar(TYPE_ACCENT[t])} onClick={() => onConvert(t)}>
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        )}
        <input
          ref={titleRef}
          value={e.title}
          onChange={(ev) => update(e.id, { title: ev.target.value })}
          placeholder={e.type === 'slot' && project ? displayTitle(project) : TITLE_HINT[e.type]}
          className="w-full bg-transparent outline-none text-[22px] font-semibold tracking-tight text-white placeholder:text-white/35 mt-3 py-1 border-b border-transparent focus:border-[rgb(var(--c)/0.5)]"
          data-agenda-title
        />
        {e.type === 'slot' && <SlotBody s={e} />}
        {e.type === 'task' && <TaskFields t={e} />}
        {e.type === 'note' && <NoteFields n={e} />}
        {e.type === 'project' && <ProjectFields p={e} />}
        <Section label="Tags">
          <TagEditor id={e.id} tags={tagsOf(e)} />
        </Section>
        <LinksSection id={e.id} pickerLevel={LEVEL.inView + 1} />
        <div className="mt-7 pt-4 border-t border-white/[0.07] flex items-center justify-between gap-3 flex-wrap">
          <button className="btn" onClick={() => openEntity(e.id)}>
            Voir dans le réseau
          </button>
          <DeleteButton id={e.id} />
        </div>
      </div>
    </aside>
  );
}

/**
 * Les tâches sans date : à glisser dans la semaine (souris), ou à ouvrir pour leur donner un jour. Sur téléphone (V8.1),
 * elle prend tout l'écran, et chaque tâche a son bouton pour la mettre au jour affiché.
 */
function PlanTray({
  tasks,
  onOpen,
  onDragStart,
  overlay,
  onClose,
  dayLabel,
  onPlanDay,
}: {
  tasks: Task[];
  onOpen: (id: string) => void;
  onDragStart: (t: Task, e: RPointerEvent<HTMLElement>) => void;
  overlay: boolean;
  onClose: () => void;
  dayLabel: string;
  onPlanDay: (id: string) => void;
}) {
  const projects = useData((s) => s.entities);
  const createTask = useData((s) => s.createTask);
  const [title, setTitle] = useState('');
  return (
    <aside
      className={`w-[230px] flex-none glass bg-[rgb(7_7_12/0.94)] flex flex-col min-h-0 ${
        overlay ? 'fixed inset-0 z-50 w-full anim-panel bg-[rgb(7_7_12/0.99)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]' : ''
      }`}
      style={cvar('#00e5ff')}
      data-plan-tray
    >
      <div className="flex items-center gap-2 px-3 max-md:px-4 pt-3 pb-2 border-b border-white/[0.06]">
        <span className="hud text-[10px] text-[#00e5ff]">À planifier</span>
        <span className="mono text-[10px] text-white/40">{String(tasks.length).padStart(2, '0')}</span>
        <button className="btn btn-ghost !px-2 max-md:!px-3 max-md:!py-2 ml-auto" title="Fermer" aria-label="Fermer" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="px-3 max-md:px-4 pt-2.5">
        <input
          className="field !text-[12px] max-md:!text-[14px]"
          enterKeyHint="done"
          placeholder="+ Tâche à planifier (Entrée)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && title.trim()) {
              createTask({ title: title.trim() });
              setTitle('');
            }
          }}
        />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain scroll-thin p-2 max-md:p-3 flex flex-col gap-1.5 max-md:gap-2">
        {tasks.length === 0 && <div className="text-[11.5px] text-white/35 leading-relaxed p-2">Toutes tes tâches ont un jour. Les nouvelles tâches sans date arrivent ici.</div>}
        {tasks.map((t) => {
          const p = t.projectId ? (projects[t.projectId] as Project | undefined) : undefined;
          return (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              data-plan-task={t.id}
              className="relative glass px-2.5 py-2 max-md:px-3.5 max-md:py-3 cursor-grab touch-pan-y hover:border-[rgb(var(--c)/0.5)] select-none [-webkit-touch-callout:none] flex items-center gap-2"
              style={cvar(t.color)}
              onPointerDown={(e) => onDragStart(t, e)}
              onKeyDown={(e) => e.key === 'Enter' && onOpen(t.id)}
            >
              <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-[rgb(var(--c))]" />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] max-md:text-[14px] text-white/85 leading-snug truncate">{displayTitle(t)}</div>
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  {t.status === 'doing' && <span className="mono text-[8.5px] text-[#ffb020] tracking-[0.12em]">EN COURS</span>}
                  {p && (
                    <span className="mono text-[9px] text-[rgb(var(--c))] truncate max-w-full" style={cvar(p.color)}>
                      ↳ {displayTitle(p)}
                    </span>
                  )}
                </div>
              </div>
              {/* téléphone : un toucher la met au jour affiché */}
              <button
                className="md:hidden btn !py-2 !px-2.5 !text-[9.5px] flex-none"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onPlanDay(t.id);
                }}
                data-plan-day={t.id}
              >
                → {dayLabel}
              </button>
            </div>
          );
        })}
      </div>
      <div className="hud text-[8.5px] text-white/30 px-3 py-2 border-t border-white/[0.06] leading-relaxed max-md:hidden">Glisse une tâche dans la semaine</div>
    </aside>
  );
}

function Week() {
  const today = todayISO();
  const narrow = useNarrow();
  const [monday, setMonday] = useState(() => mondayOf(today));
  const [sel, setSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [plan, setPlan] = useState<PlanDrag | null>(null);
  const [menu, setMenu] = useState(false);
  const [now, setNow] = useState(minutesNow());
  // « À planifier » ouvert ou non, gardé d'une fois sur l'autre sur ordinateur ; sur téléphone (où il prend tout
  // l'écran), l'agenda s'ouvre toujours sur la journée
  const [planOpen, setPlanOpen] = useState(() => {
    if (isNarrow()) return false;
    const v = readKey(PLAN_KEY);
    return v === null ? window.innerWidth >= 1280 : v === '1';
  });
  const fresh = useRef<Fresh | null>(null);
  const setView = useUI((s) => s.setView);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const allDayRef = useRef<HTMLDivElement>(null);

  const week = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  /**
   * Téléphone (V8.1) : un jour à la fois, en pleine largeur (sept colonnes de quatre centimètres ne se lisent pas). On
   * choisit le jour dans la bande du haut, avec ‹ › ou en glissant le doigt sur la grille. Ordinateur : toute la semaine.
   */
  const [dayIdx, setDayIdx] = useState(() => Math.max(0, week.indexOf(today)));
  const cols = useMemo(() => (narrow ? [dayIdx] : [0, 1, 2, 3, 4, 5, 6]), [narrow, dayIdx]);
  const colOf = (day: number) => cols.indexOf(day);
  /** un jour avant / après, en passant à la semaine voisine au bord */
  const shiftDay = (d: number) => {
    const next = dayIdx + d;
    if (next < 0) {
      setMonday(addDays(monday, -7));
      setDayIdx(6);
    } else if (next > 6) {
      setMonday(addDays(monday, 7));
      setDayIdx(0);
    } else setDayIdx(next);
  };
  const goToday = () => {
    setMonday(mondayOf(today));
    setDayIdx((fromISODate(today).getDay() + 6) % 7);
  };
  const slots = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Slot => e.type === 'slot')));
  const tasks = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Task => e.type === 'task' && !!e.date)));
  const notes = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Note => e.type === 'note' && !!e.date)));
  const projects = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Project => e.type === 'project' && !!e.deadline)));
  const toPlan = useData(
    useShallow((s) =>
      Object.values(s.entities)
        .filter((e): e is Task => e.type === 'task' && !e.date && e.status !== 'done')
        .sort((a, b) => Number(b.status === 'doing') - Number(a.status === 'doing') || a.order - b.order),
    ),
  );
  const entities = useData((s) => s.entities);
  const selected = sel ? entities[sel] : undefined;

  const segs = useMemo(() => layoutWeek(week, slots, tasks, notes), [week, slots, tasks, notes]);
  const totals = useMemo(() => {
    const t = new Array(7).fill(0);
    for (const s of segs) if (s.kind === 'slot') t[s.day] += s.to - s.from;
    return t;
  }, [segs]);
  const weekTotal = totals.reduce((a, b) => a + b, 0);
  const counts = useMemo(() => {
    const inWeek = new Set(week);
    return { tasks: tasks.filter((t) => inWeek.has(t.date!)).length, notes: notes.filter((n) => inWeek.has(n.date!)).length };
  }, [week, tasks, notes]);
  const allDay = useMemo(() => {
    const m = week.map(() => [] as (Task | Note | Project)[]);
    const idx = new Map(week.map((d, i) => [d, i]));
    for (const t of tasks) if (t.time == null && idx.has(t.date!)) m[idx.get(t.date!)!].push(t);
    for (const n of notes) if (n.time == null && idx.has(n.date!)) m[idx.get(n.date!)!].push(n);
    for (const p of projects) if (idx.has(p.deadline!)) m[idx.get(p.deadline!)!].push(p);
    return m;
  }, [week, tasks, notes, projects]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(minutesNow()), 30000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (sel && !entities[sel]) setSel(null);
  }, [sel, entities]);

  // à l'ouverture et à chaque semaine : on montre la matinée (ou l'heure actuelle)
  useLayoutEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const target = week.includes(today) ? clamp(now - 90, 0, 1440) : 7 * 60 - 30;
    sc.scrollTop = (target / 60) * HOUR;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monday]);

  /** Fermer le panneau : un élément tout juste ajouté et laissé vide disparaît */
  const close = () => {
    const id = sel;
    setSel(null);
    const f = fresh.current;
    fresh.current = null;
    if (!id || !f || f.id !== id) return;
    const d = useData.getState();
    const e = d.entities[id];
    const linked = d.links.some((l) => l.a === id || l.b === id);
    if (e && !e.title.trim() && !bodyOf(e).trim() && !(hasProject(e) && e.projectId) && !tagsOf(e).length && !linked) d.remove(id, { silent: true });
  };
  const open = (id: string) => {
    if (sel && sel !== id) close();
    fresh.current = null;
    setSel(id);
  };
  const togglePlan = () => {
    setPlanOpen((o) => {
      if (!isNarrow()) writeKey(PLAN_KEY, o ? '0' : '1');
      return !o;
    });
  };

  // Échap (ou retour sur le téléphone) : d'abord le menu, l'élément ouvert, « À planifier » (téléphone), puis la vue
  useBackLayer(!!sel, close, LEVEL.inView);
  useBackLayer(menu, () => setMenu(false), LEVEL.inView + 2);
  useBackLayer(planOpen && narrow, () => setPlanOpen(false), LEVEL.inView - 1);
  // téléphone : l'élément ouvert et « À planifier » prennent tout l'écran ; la barre des vues s'efface en dessous
  useCoverMobileNav(narrow && (!!selected || planOpen));

  /** Position du pointeur dans la grille → jour (0..6) et minute (sur téléphone : le jour affiché) */
  const at = (e: { clientX: number; clientY: number }) => {
    const r = gridRef.current!.getBoundingClientRect();
    const col = (r.width - GUTTER) / cols.length;
    const c = clamp(Math.floor((e.clientX - r.left - GUTTER) / col), 0, cols.length - 1);
    return { day: cols[c], min: clamp(((e.clientY - r.top) / HOUR) * 60, 0, 1440), col };
  };

  /** Ajouter à cet endroit : un créneau d'abord (comme avant), le panneau propose d'en faire autre chose */
  const add = (type: EntityType, where: At) => {
    if (sel) close();
    const e = createAt(type, where);
    fresh.current = { id: e.id, at: where };
    setSel(e.id);
  };
  const create = (day: number, from: number, to: number) => add('slot', { date: week[day], start: from, end: to >= 1440 ? 0 : to });

  /** Tout juste ajouté : il devient une tâche, une note, un projet… (titre, tags, texte et projet suivent) */
  const convert = (to: EntityType) => {
    const f = fresh.current;
    const d = useData.getState();
    const cur = sel ? d.entities[sel] : undefined;
    if (!f || !cur || cur.id !== f.id || cur.type === to) return;
    const next = createAt(to, f.at, carryOf(cur));
    d.remove(cur.id, { silent: true });
    fresh.current = { ...f, id: next.id };
    setSel(next.id);
  };

  /**
   * « + Ajouter » : maintenant (ou le lundi à 9 h, si la semaine affichée n'est pas celle-ci) ; sur téléphone, au jour
   * affiché (à l'heure actuelle si c'est aujourd'hui, sinon à 9 h)
   */
  const addNow = (type: EntityType) => {
    setMenu(false);
    const shownDay = narrow ? week[dayIdx] : week.includes(today) ? today : week[0];
    const isToday = shownDay === today;
    const start = isToday ? clamp(Math.ceil(now / SNAP) * SNAP, 0, 1440 - 60) : 9 * 60;
    const date = shownDay;
    // un projet ajouté par ce bouton n'a pas encore d'échéance (elle se choisit dans son panneau)
    if (type === 'project') {
      if (sel) close();
      const p = useData.getState().createProject({});
      fresh.current = { id: p.id, at: { date, start, end: start + 60 } };
      setSel(p.id);
      return;
    }
    add(type, { date, start, end: start + 60 });
  };

  const onGridDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.pointerType === 'touch') return;
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
    const col = (r.width - GUTTER) / cols.length;
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
      open(d.id);
      return;
    }
    const update = useData.getState().update;
    if (d.kind === 'slot') {
      const dur = slotDuration(d.start, d.end);
      if (d.mode === 'move') {
        const start = clamp(d.start + d.dMin, 0, 1440 - SNAP);
        update(d.id, { date: addDays(d.date, d.dDay), start, end: (start + dur) % 1440 });
      } else {
        const nd = clamp(dur + d.dMin, SNAP, 1440 - SNAP);
        update(d.id, { end: (d.start + nd) % 1440 });
      }
    } else {
      // une tâche ou une note : un autre jour, une autre heure
      update(d.id, { date: addDays(d.date, d.dDay), time: clamp(d.start + d.dMin, 0, 1440 - SNAP) });
    }
  };

  /** Sur un écran tactile : toucher un vide ajoute un créneau d'une heure (le panneau propose d'en faire autre chose) */
  const onGridTap = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.nativeEvent as PointerEvent).pointerType !== 'touch') return;
    if (performance.now() - swipe.current.at < 400) return;
    if ((e.target as HTMLElement).closest('[data-block]')) return;
    const p = at(e);
    const from = clamp(Math.floor(p.min / 30) * 30, 0, 1440 - 60);
    create(p.day, from, from + 60);
  };

  /** Téléphone : glisser le doigt vers la gauche ou la droite sur la grille change de jour */
  const swipe = useRef({ x: 0, y: 0, id: -1, at: 0 });
  const onSwipeDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (!narrow || e.pointerType !== 'touch') return;
    swipe.current = { ...swipe.current, x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onSwipeUp = (e: RPointerEvent<HTMLDivElement>) => {
    const s = swipe.current;
    if (!narrow || e.pointerId !== s.id) return;
    s.id = -1;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      s.at = performance.now();
      shiftDay(dx < 0 ? 1 : -1);
    }
  };

  const blockDown = (e: RPointerEvent<HTMLElement>, id: string, kind: Kind, mode: 'move' | 'resize') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.pointerType === 'touch') {
      open(id);
      return;
    }
    const ent = useData.getState().entities[id];
    if (!ent) return;
    const date = ent.type === 'slot' ? ent.date : ent.type === 'task' || ent.type === 'note' ? ent.date : null;
    const start = ent.type === 'slot' ? ent.start : ent.type === 'task' || ent.type === 'note' ? ent.time : null;
    if (!date || start == null) return;
    gridRef.current?.setPointerCapture(e.pointerId);
    setDrag({ mode, id, kind, x0: e.clientX, y0: e.clientY, dDay: 0, dMin: 0, moved: false, date, start, end: ent.type === 'slot' ? ent.end : start + ITEM_MIN });
  };

  /** Glisser une tâche depuis « À planifier » : dans la grille (un jour, une heure) ou « toute la journée » */
  const planHit = (x: number, y: number): PlanDrag['at'] => {
    const g = gridRef.current?.getBoundingClientRect();
    const sc = scrollRef.current?.getBoundingClientRect();
    const ad = allDayRef.current?.getBoundingClientRect();
    const dayAt = (r: DOMRect) => cols[clamp(Math.floor((x - r.left - GUTTER) / ((r.width - GUTTER) / cols.length)), 0, cols.length - 1)];
    if (ad && x >= ad.left + GUTTER && x <= ad.right && y >= ad.top && y <= ad.bottom) return { day: dayAt(ad), min: null };
    if (g && sc && x >= g.left + GUTTER && x <= g.right && y >= sc.top && y <= sc.bottom) {
      return { day: dayAt(g), min: clamp(Math.floor((((y - g.top) / HOUR) * 60) / SNAP) * SNAP, 0, 1440 - SNAP) };
    }
    return null;
  };
  const planStart = (t: Task, e: RPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    // au doigt : la liste défile, un toucher ouvre la tâche (pour lui donner un jour)
    if (e.pointerType === 'touch') {
      const x0 = e.clientX;
      const y0 = e.clientY;
      const end = (ev: PointerEvent) => {
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        // la liste a défilé (pointercancel) ou le doigt a bougé : ce n'est pas un toucher
        if (ev.type === 'pointerup' && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 10) open(t.id);
      };
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      return;
    }
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      moved = true;
      setPlan({ id: t.id, x: ev.clientX, y: ev.clientY, at: planHit(ev.clientX, ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setPlan(null);
      if (!moved) {
        open(t.id);
        return;
      }
      const hit = ev.type === 'pointerup' ? planHit(ev.clientX, ev.clientY) : null;
      if (hit) useData.getState().update(t.id, { date: week[hit.day], time: hit.min });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const isToday = (i: number) => week[i] === today;
  const ghost = drag?.mode === 'create' && drag.moved ? { day: drag.day, from: Math.min(drag.anchor, drag.cur), to: Math.max(drag.anchor + SNAP, drag.cur) } : null;
  const planned = plan ? (entities[plan.id] as Task | undefined) : undefined;
  const isFresh = !!selected && fresh.current?.id === selected.id;
  const trayOverlay = narrow;
  /** largeur d'une colonne (%) : un septième de la semaine, ou toute la largeur pour le jour affiché (téléphone) */
  const W = 100 / cols.length;
  const shownDate = week[dayIdx];
  const shownLabel = `${DAY_NAMES[fromISODate(shownDate).getDay()]} ${fromISODate(shownDate).getDate()} ${MONTH_NAMES[fromISODate(shownDate).getMonth()]}`;
  /** téléphone : une tâche de « À planifier » mise au jour affiché, en un toucher */
  const planDay = (id: string) => {
    useData.getState().update(id, { date: shownDate, time: null });
    useUI.getState().toast({ text: `TÂCHE PLANIFIÉE · ${fmtDay(shownDate)}`, color: '#00e5ff' });
  };
  /** les jours qui ont quelque chose (un point dans la bande des jours, sur téléphone) */
  const busy = useMemo(() => {
    const b = new Array(7).fill(false);
    for (const s of segs) b[s.day] = true;
    allDay.forEach((items, i) => {
      if (items.length) b[i] = true;
    });
    return b;
  }, [segs, allDay]);

  return (
    <div className={`fixed inset-0 z-30 anim-fade ${plan ? 'cursor-grabbing select-none' : ''}`} data-ui data-week data-agenda>
      <div className="backdrop bg-black/85" onClick={outsideClick(() => setView('network'))} />
      {/* sur téléphone : tout l'écran, de la place en bas pour la barre des vues */}
      <div className="absolute inset-x-4 top-4 bottom-4 max-md:inset-x-0 max-md:top-0 max-md:bottom-[calc(64px+env(safe-area-inset-bottom))] flex flex-col">
        {/* en-tête : la semaine (ou, sur téléphone, le jour), son résumé, navigation, ajouter */}
        <div className="flex items-end justify-between mb-3 max-md:mb-2 gap-4 max-md:gap-2.5 flex-wrap max-md:px-3 max-md:pt-[calc(14px+env(safe-area-inset-top))]">
          <div className="max-md:w-full">
            <div className="hud text-[10px] text-[#ffb020]">Agenda</div>
            <div className="text-[24px] max-md:text-[20px] font-semibold tracking-tight text-white mt-1 max-md:first-letter:uppercase" data-agenda-title-day>
              <span className="max-md:hidden">{weekTitle(monday)}</span>
              <span className="md:hidden">{shownLabel}</span>
              <span className="mono text-[13px] font-normal text-white/45 ml-3 max-md:hidden">
                {weekTotal ? `${fmtHM(weekTotal)} de créneaux` : 'aucun créneau'}
                {counts.tasks ? ` · ${counts.tasks} tâche${counts.tasks > 1 ? 's' : ''}` : ''}
                {counts.notes ? ` · ${counts.notes} note${counts.notes > 1 ? 's' : ''}` : ''}
              </span>
            </div>
          </div>
          <div className="flex gap-2 max-md:gap-1.5 flex-wrap max-md:flex-nowrap items-center max-md:w-full">
            <button className="btn max-md:!px-3.5" title={narrow ? 'Jour précédent' : 'Semaine précédente'} aria-label={narrow ? 'Jour précédent' : 'Semaine précédente'} onClick={() => (narrow ? shiftDay(-1) : setMonday(addDays(monday, -7)))}>
              ‹
            </button>
            <button className="btn max-md:!px-2.5" onClick={goToday}>
              <span className="max-md:hidden">Aujourd’hui</span>
              <span className="md:hidden">Auj.</span>
            </button>
            <button className="btn max-md:!px-3.5" title={narrow ? 'Jour suivant' : 'Semaine suivante'} aria-label={narrow ? 'Jour suivant' : 'Semaine suivante'} onClick={() => (narrow ? shiftDay(1) : setMonday(addDays(monday, 7)))}>
              ›
            </button>
            <button className={`btn max-md:!px-2.5 max-md:ml-auto ${planOpen ? 'btn-primary' : ''}`} style={cvar('#00e5ff')} onClick={togglePlan} data-plan-toggle title="Les tâches sans date, à glisser dans la semaine">
              <span className="max-md:hidden">À planifier · </span>
              <span className="md:hidden">Plan. </span>
              {toPlan.length}
            </button>
            <div className="relative">
              <button className="btn btn-primary max-md:!px-3" style={cvar('#ffb020')} onClick={() => setMenu((m) => !m)} data-agenda-add aria-expanded={menu}>
                + Ajouter <span className="max-md:hidden">▾</span>
              </button>
              {menu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setMenu(false)} />
                  <div className="absolute right-0 top-full mt-1 z-50 glass neon bg-[rgb(7_7_12/0.97)] p-1.5 flex flex-col min-w-[190px] max-md:min-w-[220px] anim-pop" style={cvar('#ffb020')} data-agenda-add-menu>
                    {ADD_TYPES.map((t) => (
                      <button key={t} className="flex items-center gap-2.5 px-3 py-2 max-md:py-3 text-left hover:bg-white/[0.06] text-[13px] max-md:text-[14px] text-white/85" style={cvar(TYPE_ACCENT[t])} onClick={() => addNow(t)} data-add-type={t}>
                        <span className="dot" />
                        {TYPE_LABEL[t]}
                        <span className="mono text-[9px] text-white/35 ml-auto">{t === 'project' ? 'échéance' : t === 'slot' ? 'durée' : 'jour · heure'}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            <button className="btn max-md:hidden" onClick={() => setView('network')}>
              ← Réseau <span className="text-white/35 ml-1">Tab</span>
            </button>
          </div>
          {/* téléphone : la bande des sept jours (un point = quelque chose ce jour-là) */}
          <div className="md:hidden flex w-full gap-1" data-day-strip>
            {week.map((d, i) => {
              const dt = fromISODate(d);
              const on = i === dayIdx;
              return (
                <button
                  key={d}
                  onClick={() => setDayIdx(i)}
                  data-day={i}
                  className={`flex-1 min-w-0 flex flex-col items-center py-1.5 border transition-colors ${
                    on ? 'border-[#ffb020]/70 bg-[#ffb020]/[0.12]' : isToday(i) ? 'border-[#00e5ff]/40' : 'border-white/[0.07]'
                  }`}
                >
                  <span className={`hud text-[8.5px] tracking-[0.08em] ${on ? 'text-[#ffb020]' : isToday(i) ? 'text-[#00e5ff]' : 'text-white/45'}`}>{DAY_SHORT[dt.getDay()]}</span>
                  <span className={`mono text-[14px] leading-tight ${on ? 'text-white' : 'text-white/70'}`}>{dt.getDate()}</span>
                  <span className={`w-1 h-1 rounded-full mt-0.5 ${busy[i] ? 'bg-[#ffb020]' : 'bg-transparent'}`} />
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 min-h-0 flex gap-3 relative max-md:px-2">
          {planOpen && <PlanTray tasks={toPlan} onOpen={open} onDragStart={planStart} overlay={trayOverlay} onClose={togglePlan} dayLabel={fmtDay(shownDate)} onPlanDay={planDay} />}
          <div className="flex-1 min-w-0 glass bg-[rgb(7_7_12/0.94)] flex flex-col min-h-0">
            {/* jours (sur téléphone, la bande du haut les remplace) */}
            <div className="flex border-b border-white/[0.08] flex-none max-md:hidden" style={{ paddingLeft: GUTTER }}>
              {cols.map((i) => {
                const d = week[i];
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
            {/* toute la journée : tâches et notes datées sans heure, échéances des projets */}
            <div ref={allDayRef} className="flex border-b border-white/[0.08] flex-none max-h-[96px] max-md:max-h-[120px] overflow-y-auto overscroll-contain scroll-thin relative" data-all-day>
              <div className="flex-none flex items-start justify-end pr-1 pt-1.5 mono text-[8.5px] tracking-[0.1em] text-white/30" style={{ width: GUTTER }}>
                JOURNÉE
              </div>
              {cols.map((i) => (
                <div
                  key={week[i]}
                  className={`flex-1 min-w-0 px-1 py-1 border-l border-white/[0.06] flex flex-col gap-1 min-h-[30px] ${plan?.at && plan.at.min === null && plan.at.day === i ? 'bg-[#00e5ff]/[0.12]' : ''}`}
                >
                  {allDay[i].map((e) => (
                    <button
                      key={e.id}
                      onClick={() => open(e.id)}
                      data-all-day-item={e.id}
                      className={`text-left truncate mono text-[9.5px] max-md:text-[11.5px] tracking-[0.04em] px-1.5 py-0.5 max-md:py-1.5 border bg-[rgb(var(--c)/0.1)] text-white/85 hover:bg-[rgb(var(--c)/0.2)] ${
                        e.type === 'note' ? 'border-dotted border-[rgb(var(--c)/0.7)]' : 'border-[rgb(var(--c)/0.5)]'
                      } ${sel === e.id ? 'shadow-[0_0_0_1px_rgb(var(--c))]' : ''}`}
                      style={cvar(e.color)}
                      title={e.type === 'project' ? `Échéance du projet ${displayTitle(e)}` : `${TYPE_LABEL[e.type]} : ${displayTitle(e)}`}
                    >
                      {e.type === 'project' ? '⚑ ' : e.type === 'note' ? '✎ ' : e.status === 'done' ? '✓ ' : '◆ '}
                      <span className={e.type === 'task' && e.status === 'done' ? 'line-through opacity-60' : ''}>{displayTitle(e)}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            {/* la grille des heures */}
            <div
              ref={scrollRef}
              className="flex-1 min-h-0 overflow-y-auto overscroll-contain scroll-thin relative"
              onPointerDown={onSwipeDown}
              onPointerUp={onSwipeUp}
              onPointerCancel={() => (swipe.current.id = -1)}
              data-agenda-scroll
            >
              <div
                ref={gridRef}
                className="relative select-none"
                style={{ height: 24 * HOUR, cursor: 'crosshair', touchAction: drag ? 'none' : 'pan-y' }}
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
                  {cols.map((i) => (
                    <div key={week[i]} className={`flex-1 border-l border-white/[0.06] ${isToday(i) ? 'bg-[#00e5ff]/[0.035]' : i >= 5 ? 'bg-white/[0.015]' : ''}`} />
                  ))}
                </div>
                {/* créneaux, tâches et notes */}
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
                    // sur téléphone, seul le jour affiché
                    const c = colOf(day);
                    if (c < 0) return null;
                    const w = W;
                    const style = {
                      ...cvar(e.color),
                      top: (from / 60) * HOUR + 1,
                      height: Math.max(18, ((to - from) / 60) * HOUR - 2),
                      left: `calc(${c * w}% + ${(g.lane / g.lanes) * w}% + 2px)`,
                      width: `calc(${w / g.lanes}% - 4px)`,
                    };
                    if (g.kind === 'task' || g.kind === 'note') {
                      const isTask = e.type === 'task';
                      const t = e as Task | Note;
                      const done = isTask && (e as Task).status === 'done';
                      return (
                        <div
                          key={g.key}
                          data-block
                          data-agenda-item={g.id}
                          data-kind={g.kind}
                          role="button"
                          tabIndex={0}
                          className={`absolute text-left px-1.5 border bg-black/55 hover:bg-[rgb(var(--c)/0.14)] overflow-hidden flex items-center ${
                            isTask ? 'border-dashed border-[rgb(var(--c)/0.7)]' : 'border-dotted border-[rgb(var(--c)/0.85)]'
                          } ${sel === g.id ? 'shadow-[0_0_0_1px_rgb(var(--c)),0_0_18px_rgb(var(--c)/0.45)]' : ''} ${moving ? 'opacity-85 z-10' : ''}`}
                          style={{ ...style, height: narrow ? 24 : 20, cursor: moving ? 'grabbing' : 'grab' }}
                          onPointerDown={(ev) => blockDown(ev, g.id, g.kind, 'move')}
                          onKeyDown={(ev) => ev.key === 'Enter' && open(g.id)}
                          title={`${TYPE_LABEL[e.type]} · ${displayTitle(e)} · ${fmtTime(t.time)}`}
                        >
                          <span className={`mono text-[9.5px] max-md:text-[11px] text-white/85 truncate block pointer-events-none ${done ? 'line-through opacity-60' : ''}`}>
                            {isTask ? '◆' : '✎'} {fmtTime(moving ? from : t.time)} {displayTitle(e)}
                          </span>
                        </div>
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
                        style={{ ...style, cursor: moving ? 'grabbing' : 'grab' }}
                        onPointerDown={(ev) => blockDown(ev, s.id, 'slot', 'move')}
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
                        {!g.cont && (
                          <div className="absolute left-0 right-0 bottom-0 h-[7px] cursor-ns-resize" onPointerDown={(ev) => blockDown(ev, s.id, 'slot', 'resize')} title="Glisser pour changer la durée" />
                        )}
                      </div>
                    );
                  })}
                  {/* créneau en train d'être dessiné */}
                  {ghost && (
                    <div
                      className="absolute border-l-[3px] border-[#ffb020] bg-[#ffb020]/20 pointer-events-none"
                      style={{ top: (ghost.from / 60) * HOUR, height: ((ghost.to - ghost.from) / 60) * HOUR, left: `calc(${Math.max(0, colOf(ghost.day)) * W}% + 2px)`, width: `calc(${W}% - 4px)` }}
                    >
                      <div className="mono text-[10px] text-white px-2 py-1">
                        {fmtTime(ghost.from)} → {fmtTime(ghost.to)} · {fmtHM(ghost.to - ghost.from)}
                      </div>
                    </div>
                  )}
                  {/* une tâche glissée depuis « À planifier » : là où elle tomberait */}
                  {plan?.at && plan.at.min !== null && planned && colOf(plan.at.day) >= 0 && (
                    <div
                      className="absolute border border-dashed border-[rgb(var(--c))] bg-[rgb(var(--c)/0.18)] pointer-events-none z-20"
                      style={{ ...cvar(planned.color), top: (plan.at.min / 60) * HOUR + 1, height: 20, left: `calc(${colOf(plan.at.day) * W}% + 2px)`, width: `calc(${W}% - 4px)` }}
                    >
                      <span className="mono text-[9.5px] text-white px-1.5">◆ {fmtTime(plan.at.min)}</span>
                    </div>
                  )}
                  {/* maintenant */}
                  {colOf(week.indexOf(today)) >= 0 && (
                    <div className="absolute h-0 pointer-events-none z-20" style={{ top: (now / 60) * HOUR, left: `${colOf(week.indexOf(today)) * W}%`, width: `${W}%` }}>
                      <div className="h-px bg-[#ff2e88] shadow-[0_0_8px_#ff2e88]" />
                      <div className="absolute -left-1 -top-[4px] w-2 h-2 rotate-45 bg-[#ff2e88] shadow-[0_0_10px_#ff2e88]" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
          {selected && <AgendaPanel key={selected.id} e={selected} fresh={isFresh} onConvert={convert} onClose={close} />}
        </div>

        <div className="hud text-[9px] text-white/30 mt-2.5 flex gap-4 justify-center flex-wrap max-md:hidden">
          <span>Glisse dans la grille pour ajouter (créneau, tâche, note, projet)</span>
          <span>Glisse un élément pour le déplacer · le bas d’un créneau pour sa durée</span>
          <span>Clic pour l’ouvrir</span>
          <span>
            <Kbd>Tab</Kbd> fermer
          </span>
        </div>
      </div>

      {/* la tâche glissée suit le pointeur */}
      {plan && planned && (
        <div
          className="fixed z-50 pointer-events-none glass px-2.5 py-1.5 rotate-[1.5deg] shadow-[0_12px_40px_rgb(0_0_0/0.6),0_0_24px_rgb(var(--c)/0.35)] border-[rgb(var(--c)/0.7)] mono text-[11px] text-white/90 max-w-[220px] truncate"
          style={cvar(planned.color, { left: plan.x + 12, top: plan.y + 8 })}
        >
          ◆ {displayTitle(planned)}
          {plan.at ? <span className="text-[rgb(var(--c))]"> · {DAY_SHORT[fromISODate(week[plan.at.day]).getDay()]} {plan.at.min !== null ? fmtTime(plan.at.min) : 'journée'}</span> : null}
        </div>
      )}
    </div>
  );
}

export function AgendaView() {
  const view = useUI((s) => s.view);
  return view === 'agenda' ? <Week /> : null;
}
