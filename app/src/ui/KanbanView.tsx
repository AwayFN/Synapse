import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { displayTitle, useData } from '../store/data';
import { useUI } from '../store/ui';
import { fmtDay, fmtTime, todayISO } from '../lib/time';
import { outsideClick, useNarrow } from '../lib/useNarrow';
import { tagsOf, type Project, type Task, type TaskStatus } from '../types';
import { Corners, cvar, Kbd } from './common';
import { tagColor } from './TagBar';

const COLUMNS: { status: TaskStatus; label: string; color: string; hint: string }[] = [
  { status: 'todo', label: 'À faire', color: '#00e5ff', hint: 'file d’attente' },
  { status: 'doing', label: 'En cours', color: '#ffb020', hint: 'focus' },
  { status: 'done', label: 'Fait', color: '#39ff88', hint: 'accompli' },
];

/**
 * Au doigt : un appui long sur une carte la prend en main. Un glissement simple fait défiler, comme partout : vers le
 * haut ou le bas la colonne, vers la gauche ou la droite on passe à la colonne voisine (même en partant d'une carte).
 */
const LONG_PRESS_MS = 320;

interface DragState {
  id: string;
  sx: number;
  sy: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
  w: number;
  active: boolean;
  touch: boolean;
}

function CardBody({ t }: { t: Task }) {
  const project = useData((s) => (t.projectId ? s.entities[t.projectId] : undefined));
  const links = useData((s) => s.links.filter((l) => l.a === t.id || l.b === t.id).length);
  const setTaskStatus = useData((s) => s.setTaskStatus);
  const late = t.status !== 'done' && t.date && t.date < todayISO();
  return (
    <>
      <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-[rgb(var(--c))] shadow-[0_0_10px_rgb(var(--c))]" />
      <div className="flex items-start gap-2.5">
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            setTaskStatus(t.id, t.status === 'done' ? 'todo' : 'done');
          }}
          className={`mt-[3px] w-[14px] h-[14px] max-md:w-[20px] max-md:h-[20px] max-md:mt-0 border flex-none flex items-center justify-center text-[9px] max-md:text-[12px] transition-all ${
            t.status === 'done' ? 'border-[#39ff88] bg-[#39ff88]/20 text-[#39ff88] shadow-[0_0_8px_#39ff88]' : 'border-white/25 hover:border-white/80'
          }`}
          title={t.status === 'done' ? 'Rouvrir' : 'Marquer comme faite'}
          aria-label={t.status === 'done' ? 'Rouvrir la tâche' : 'Marquer la tâche comme faite'}
        >
          {t.status === 'done' ? '✓' : ''}
        </button>
        <div className={`text-[13.5px] max-md:text-[14.5px] leading-snug ${t.status === 'done' ? 'text-white/40 line-through' : 'text-white/90'}`}>
          {displayTitle(t)}
        </div>
      </div>
      {(project || t.date || links > 0 || tagsOf(t).length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2.5 pl-[24px] max-md:pl-[30px]">
          {project && (
            <span className="chip !text-[9.5px] !py-px" style={cvar(project.color)}>
              ↳ {displayTitle(project)}
            </span>
          )}
          {tagsOf(t)
            .slice(0, 3)
            .map((x) => (
              <span key={x} className="chip !text-[9.5px] !py-px" style={cvar(tagColor(x))}>
                #{x}
              </span>
            ))}
          {t.date && (
            <span className={`mono text-[9.5px] tracking-[0.1em] ${late ? 'text-[#ff4d6d]' : 'text-white/45'}`}>
              {fmtDay(t.date)}
              {t.time != null ? ` · ${fmtTime(t.time)}` : ''}
            </span>
          )}
          {links > 0 && <span className="mono text-[9.5px] text-white/35">⟷ {links}</span>}
        </div>
      )}
    </>
  );
}

/**
 * Vue tâches · kanban. Sur ordinateur : trois colonnes côte à côte, glisser-déposer à la souris. Sur téléphone (V8.1) :
 * une colonne à la fois (on passe de l'une à l'autre en glissant, ou par les onglets en haut), chaque colonne défile au
 * doigt ; un appui long prend une carte, qu'on dépose plus haut ou plus bas, ou sur l'onglet d'une autre colonne.
 */
function Kanban() {
  const tasks = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Task => e.type === 'task')));
  const projects = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Project => e.type === 'project')));
  const moveTask = useData((s) => s.moveTask);
  const createTask = useData((s) => s.createTask);
  const setView = useUI((s) => s.setView);
  const openEntity = useUI((s) => s.openEntity);
  const narrow = useNarrow();
  const [filter, setFilter] = useState<string>('all');
  const [tag, setTag] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [drop, setDrop] = useState<{ status: TaskStatus; before: string | null } | null>(null);
  const [celebrate, setCelebrate] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [activeCol, setActiveCol] = useState(0);
  const dragRef = useRef<DragState | null>(null);
  const dropRef = useRef<{ status: TaskStatus; before: string | null } | null>(null);
  const suppressClick = useRef(false);
  const colsRef = useRef<HTMLDivElement>(null);

  const visible = tasks.filter((t) => (filter === 'all' ? true : filter === 'none' ? !t.projectId : t.projectId === filter) && (!tag || tagsOf(t).includes(tag)));
  const done = tasks.filter((t) => t.status === 'done').length;
  const taskTags = (() => {
    const m = new Map<string, number>();
    for (const t of tasks) for (const x of tagsOf(t)) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  })();
  const countOf = (s: TaskStatus) => visible.filter((t) => t.status === s).length;

  // téléphone : les onglets amènent à une colonne ; faire glisser les colonnes met l'onglet à jour
  const goCol = (i: number) => {
    setActiveCol(i);
    const el = colsRef.current;
    if (el) el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };
  const onColsScroll = () => {
    const el = colsRef.current;
    if (!el || !narrow || !el.clientWidth) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== activeCol) setActiveCol(Math.max(0, Math.min(2, i)));
  };

  // pendant qu'on déplace une carte au doigt, la page ne défile pas
  useEffect(() => {
    if (!drag?.active || !drag.touch) return;
    const stop = (e: TouchEvent) => e.preventDefault();
    window.addEventListener('touchmove', stop, { passive: false });
    return () => window.removeEventListener('touchmove', stop);
  }, [drag?.active, drag?.touch]);

  const computeDrop = (x: number, y: number, dragId: string) => {
    const under = document.elementFromPoint(x, y);
    // déposée sur l'onglet d'une colonne (téléphone) : à la fin de cette colonne
    const tab = under?.closest<HTMLElement>('[data-col-tab]');
    if (tab) return { status: tab.dataset.colTab as TaskStatus, before: null };
    const col = under?.closest<HTMLElement>('[data-col]');
    if (!col) return null;
    const status = col.dataset.col as TaskStatus;
    let before: string | null = null;
    for (const c of col.querySelectorAll<HTMLElement>('[data-card]')) {
      if (c.dataset.card === dragId) continue;
      const r = c.getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        before = c.dataset.card ?? null;
        break;
      }
    }
    return { status, before };
  };

  // pointer-based drag & drop: mouse and pen right away, finger after a long press (a simple swipe scrolls)
  const onCardPointerDown = (t: Task) => (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const touch = e.pointerType === 'touch';
    const r = e.currentTarget.getBoundingClientRect();
    const st: DragState = { id: t.id, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, active: false, touch };
    dragRef.current = st;
    let timer: number | undefined;
    if (touch) {
      timer = window.setTimeout(() => {
        const d = dragRef.current;
        if (!d || d.id !== t.id || d.active) return;
        const next = { ...d, active: true };
        dragRef.current = next;
        setDrag(next);
        try {
          navigator.vibrate?.(12);
        } catch {
          /* pas de vibreur */
        }
      }, LONG_PRESS_MS);
    }
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const far = Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) > (touch ? 8 : 6);
      // au doigt, bouger avant l'appui long : c'est un défilement, pas un déplacement
      if (touch && !d.active) {
        if (far) cleanup();
        return;
      }
      const active = d.active || far;
      const next = { ...d, x: ev.clientX, y: ev.clientY, active };
      dragRef.current = next;
      if (active) {
        setDrag(next);
        const dr = computeDrop(ev.clientX, ev.clientY, d.id);
        dropRef.current = dr;
        setDrop((p) => (p?.status === dr?.status && p?.before === dr?.before ? p : dr));
      }
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      dragRef.current = null;
      dropRef.current = null;
      setDrag(null);
      setDrop(null);
    };
    const up = () => {
      const d = dragRef.current;
      const dr = dropRef.current;
      if (d?.active) {
        suppressClick.current = true;
        window.setTimeout(() => (suppressClick.current = false), 0);
        if (dr) {
          const cur = useData.getState().entities[d.id];
          const was = cur?.type === 'task' ? cur.status : null;
          moveTask(d.id, dr.status, dr.before);
          if (dr.status === 'done' && was !== 'done') {
            setCelebrate(d.id);
            window.setTimeout(() => setCelebrate((c) => (c === d.id ? null : c)), 1000);
          }
          // téléphone : on suit la carte dans sa nouvelle colonne
          if (narrow) goCol(COLUMNS.findIndex((c) => c.status === dr.status));
        }
      }
      cleanup();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const indicator = <div className="h-[2px] -my-[1px] bg-white shadow-[0_0_12px_rgb(var(--c)),0_0_4px_#fff] rounded-full" />;
  const dragged = drag?.active ? tasks.find((t) => t.id === drag.id) : undefined;

  const projectChips = (
    <>
      <button className="chip flex-none max-md:!py-1.5" data-on={filter === 'all' ? '1' : '0'} style={cvar('#ffffff')} onClick={() => setFilter('all')}>
        Toutes
      </button>
      {projects.map((p) => (
        <button key={p.id} className="chip flex-none max-md:!py-1.5" data-on={filter === p.id ? '1' : '0'} style={cvar(p.color)} onClick={() => setFilter(p.id)}>
          {displayTitle(p)}
        </button>
      ))}
      <button className="chip flex-none max-md:!py-1.5" data-on={filter === 'none' ? '1' : '0'} style={cvar('#9aa0b4')} onClick={() => setFilter('none')}>
        Indépendantes
      </button>
    </>
  );

  return (
    <div className={`fixed inset-0 z-30 anim-fade ${drag?.active ? 'cursor-grabbing select-none' : ''}`} data-ui data-tasks-view>
      <div className="backdrop" onClick={outsideClick(() => setView('network'))} />
      <div className="absolute inset-x-6 top-5 bottom-5 max-md:inset-x-0 max-md:top-0 max-md:bottom-[calc(64px+env(safe-area-inset-bottom))] flex flex-col pointer-events-none">
        <div className="flex items-end justify-between pointer-events-auto mb-4 max-md:mb-2 gap-6 max-md:px-4 max-md:pt-[calc(14px+env(safe-area-inset-top))]">
          <div>
            <div className="hud text-[10px] text-[#00e5ff]">Vue tâches · kanban</div>
            <div className="text-[28px] max-md:text-[22px] font-semibold tracking-tight text-white mt-1">
              {done}
              <span className="text-white/30"> / {tasks.length}</span>
              <span className="text-[13px] font-normal text-white/40 ml-3">tâches accomplies</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 justify-end max-md:hidden">
            {projectChips}
            <button className="btn ml-3" onClick={() => setView('network')}>
              ← Réseau <span className="text-white/35 ml-1">Échap</span>
            </button>
          </div>
        </div>
        {/* téléphone : les projets sur une ligne qui défile au doigt */}
        <div className="md:hidden flex gap-1.5 overflow-x-auto scroll-none px-4 pb-2 pointer-events-auto" data-filter-row>
          {projectChips}
        </div>
        {taskTags.length > 0 && (
          <div className="flex flex-wrap max-md:flex-nowrap max-md:overflow-x-auto scroll-none items-center gap-1.5 pointer-events-auto -mt-2 max-md:mt-0 mb-3 max-md:mb-2 max-md:px-4">
            {taskTags.map(([x, n]) => (
              <button key={x} className="chip flex-none max-md:!py-1.5" data-on={tag === x ? '1' : '0'} style={cvar(tagColor(x))} onClick={() => setTag(tag === x ? null : x)}>
                #{x}
                <span className="opacity-50">{n}</span>
              </button>
            ))}
          </div>
        )}
        {/* téléphone : les trois colonnes en onglets (on peut aussi y déposer une carte tenue) */}
        <div className="md:hidden seg mx-4 mb-2 pointer-events-auto" data-col-tabs>
          {COLUMNS.map((c, i) => {
            const target = !!drag?.active && drop?.status === c.status && drop.before === null;
            return (
              <button
                key={c.status}
                data-col-tab={c.status}
                data-on={activeCol === i || target ? '1' : '0'}
                style={cvar(c.color)}
                className={`flex-1 !py-2.5 ${drag?.active ? 'outline outline-1 outline-dashed outline-[rgb(var(--c)/0.6)]' : ''}`}
                onClick={() => goCol(i)}
              >
                {c.label} <span className="opacity-60 tabular-nums">{countOf(c.status)}</span>
              </button>
            );
          })}
        </div>

        <div
          ref={colsRef}
          onScroll={onColsScroll}
          className="flex-1 grid grid-cols-3 gap-4 min-h-0 pointer-events-auto max-md:flex max-md:gap-0 max-md:overflow-x-auto max-md:snap-x max-md:snap-mandatory scroll-none"
          data-columns
        >
          {COLUMNS.map((col) => {
            const items = visible.filter((t) => t.status === col.status).sort((a, b) => a.order - b.order);
            const over = !!drag?.active && drop?.status === col.status;
            return (
              <div key={col.status} className="min-h-0 flex max-md:w-full max-md:flex-none max-md:snap-start max-md:px-3">
                <div
                  data-col={col.status}
                  className={`flex-1 glass neon flex flex-col min-h-0 transition-shadow ${over ? 'shadow-[0_0_44px_rgb(var(--c)/0.22)]' : ''}`}
                  style={cvar(col.color)}
                >
                  <Corners />
                  <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-3 border-b border-white/[0.06] max-md:hidden">
                    <span className="dot" />
                    <span className="hud text-[11px] text-[rgb(var(--c))]">{col.label}</span>
                    <span className="mono text-[11px] text-white/40">{String(items.length).padStart(2, '0')}</span>
                    <span className="hud text-[9px] text-white/25 ml-auto">{col.hint}</span>
                  </div>
                  {col.status === 'todo' && (
                    <div className="px-3 pt-3">
                      <input
                        className="field !text-[12.5px] max-md:!text-[14px]"
                        placeholder="+ Nouvelle tâche (Entrée)"
                        enterKeyHint="done"
                        value={newTitle}
                        onChange={(e) => setNewTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && newTitle.trim()) {
                            createTask({
                              title: newTitle.trim(),
                              projectId: filter !== 'all' && filter !== 'none' ? filter : null,
                              tags: tag ? [tag] : [],
                            });
                            setNewTitle('');
                          }
                        }}
                      />
                    </div>
                  )}
                  <div className="flex-1 overflow-y-auto overscroll-contain scroll-thin p-3 flex flex-col gap-2" data-col-scroll>
                    {items.map((t) => (
                      <div key={t.id} className="flex flex-col gap-2">
                        {over && drop?.before === t.id && indicator}
                        <div
                          data-card={t.id}
                          onPointerDown={onCardPointerDown(t)}
                          onContextMenu={(e) => e.preventDefault()}
                          onClick={() => {
                            if (!suppressClick.current) openEntity(t.id, { keepView: true });
                          }}
                          className={`relative glass px-3.5 py-3 max-md:py-3.5 cursor-grab select-none touch-pan-x touch-pan-y [-webkit-touch-callout:none] transition-all hover:border-[rgb(var(--c)/0.5)] hover:shadow-[0_0_24px_rgb(var(--c)/0.12)] ${
                            drag?.active && drag.id === t.id ? 'opacity-25 scale-[0.98]' : ''
                          } ${celebrate === t.id ? 'anim-celebrate' : ''}`}
                          style={cvar(t.color)}
                        >
                          <CardBody t={t} />
                        </div>
                      </div>
                    ))}
                    {over && drop?.before === null && indicator}
                    {items.length === 0 && !over && (
                      <div className="flex-1 min-h-[80px] border border-dashed border-white/10 flex items-center justify-center hud text-[9.5px] text-white/25 text-center px-4">
                        {narrow ? 'Aucune tâche ici' : 'Déposer ici'}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="hud text-[9px] text-white/30 mt-3 flex gap-4 justify-center pointer-events-none max-md:hidden">
          <span>Glisser-déposer entre colonnes</span>
          <span>
            <Kbd>⇧ Tab</Kbd> basculer
          </span>
          <span>Clic = ouvrir la fiche</span>
        </div>
        <div className="md:hidden hud text-[8.5px] text-white/30 text-center pt-1.5 pointer-events-none">Appui long sur une carte pour la déplacer</div>
      </div>

      {dragged && drag && (
        <div
          className="fixed z-50 pointer-events-none glass px-3.5 py-3 rotate-[1.5deg] shadow-[0_18px_50px_rgb(0_0_0/0.6),0_0_30px_rgb(var(--c)/0.35)] border-[rgb(var(--c)/0.7)]"
          style={cvar(dragged.color, { left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.w })}
        >
          <CardBody t={dragged} />
        </div>
      )}
    </div>
  );
}

export function KanbanView() {
  const view = useUI((s) => s.view);
  return view === 'tasks' ? <Kanban /> : null;
}
