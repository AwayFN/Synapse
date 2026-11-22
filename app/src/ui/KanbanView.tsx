import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { displayTitle, useData } from '../store/data';
import { useUI } from '../store/ui';
import { fmtDay, fmtTime, todayISO } from '../lib/time';
import type { Project, Task, TaskStatus } from '../types';
import { Corners, cvar, Kbd } from './common';

const COLUMNS: { status: TaskStatus; label: string; color: string; hint: string }[] = [
  { status: 'todo', label: 'À faire', color: '#00e5ff', hint: 'file d’attente' },
  { status: 'doing', label: 'En cours', color: '#ffb020', hint: 'focus' },
  { status: 'done', label: 'Fait', color: '#39ff88', hint: 'accompli' },
];

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
          className={`mt-[3px] w-[14px] h-[14px] border flex-none flex items-center justify-center text-[9px] transition-all ${
            t.status === 'done' ? 'border-[#39ff88] bg-[#39ff88]/20 text-[#39ff88] shadow-[0_0_8px_#39ff88]' : 'border-white/25 hover:border-white/80'
          }`}
          title={t.status === 'done' ? 'Rouvrir' : 'Marquer comme faite'}
        >
          {t.status === 'done' ? '✓' : ''}
        </button>
        <div className={`text-[13.5px] leading-snug ${t.status === 'done' ? 'text-white/40 line-through' : 'text-white/90'}`}>
          {displayTitle(t)}
        </div>
      </div>
      {(project || t.date || links > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-2.5 pl-[24px]">
          {project && (
            <span className="chip !text-[9.5px] !py-px" style={cvar(project.color)}>
              ↳ {displayTitle(project)}
            </span>
          )}
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

function Kanban() {
  const tasks = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Task => e.type === 'task')));
  const projects = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Project => e.type === 'project')));
  const moveTask = useData((s) => s.moveTask);
  const createTask = useData((s) => s.createTask);
  const setView = useUI((s) => s.setView);
  const openEntity = useUI((s) => s.openEntity);
  const [filter, setFilter] = useState<string>('all');
  const [drag, setDrag] = useState<DragState | null>(null);
  const [drop, setDrop] = useState<{ status: TaskStatus; before: string | null } | null>(null);
  const [celebrate, setCelebrate] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const dragRef = useRef<DragState | null>(null);
  const dropRef = useRef<{ status: TaskStatus; before: string | null } | null>(null);
  const suppressClick = useRef(false);

  const visible = tasks.filter((t) => (filter === 'all' ? true : filter === 'none' ? !t.projectId : t.projectId === filter));
  const done = tasks.filter((t) => t.status === 'done').length;

  const computeDrop = (x: number, y: number, dragId: string) => {
    const col = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-col]');
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

  // pointer-based drag & drop: works with mouse, pen and touch, with a glowing ghost card
  const onCardPointerDown = (t: Task) => (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const st: DragState = { id: t.id, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, active: false };
    dragRef.current = st;
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const active = d.active || Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) > 6;
      const next = { ...d, x: ev.clientX, y: ev.clientY, active };
      dragRef.current = next;
      if (active) {
        setDrag(next);
        const dr = computeDrop(ev.clientX, ev.clientY, d.id);
        dropRef.current = dr;
        setDrop((p) => (p?.status === dr?.status && p?.before === dr?.before ? p : dr));
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
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
        }
      }
      dragRef.current = null;
      dropRef.current = null;
      setDrag(null);
      setDrop(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const indicator = <div className="h-[2px] -my-[1px] bg-white shadow-[0_0_12px_rgb(var(--c)),0_0_4px_#fff] rounded-full" />;
  const dragged = drag?.active ? tasks.find((t) => t.id === drag.id) : undefined;

  return (
    <div className={`fixed inset-0 z-30 anim-fade ${drag?.active ? 'cursor-grabbing select-none' : ''}`} data-ui>
      <div className="backdrop" onClick={() => setView('network')} />
      <div className="absolute inset-x-6 top-5 bottom-5 max-md:inset-x-2 max-md:top-2 max-md:bottom-2 flex flex-col pointer-events-none">
        <div className="flex items-end justify-between pointer-events-auto mb-4 gap-6">
          <div>
            <div className="hud text-[10px] text-[#00e5ff]">Vue tâches · kanban</div>
            <div className="text-[28px] font-semibold tracking-tight text-white mt-1">
              {done}
              <span className="text-white/30"> / {tasks.length}</span>
              <span className="text-[13px] font-normal text-white/40 ml-3">tâches accomplies</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 justify-end">
            <button className="chip" data-on={filter === 'all' ? '1' : '0'} style={cvar('#ffffff')} onClick={() => setFilter('all')}>
              Toutes
            </button>
            {projects.map((p) => (
              <button key={p.id} className="chip" data-on={filter === p.id ? '1' : '0'} style={cvar(p.color)} onClick={() => setFilter(p.id)}>
                {displayTitle(p)}
              </button>
            ))}
            <button className="chip" data-on={filter === 'none' ? '1' : '0'} style={cvar('#9aa0b4')} onClick={() => setFilter('none')}>
              Indépendantes
            </button>
            <button className="btn ml-3" onClick={() => setView('network')}>
              ← Réseau <span className="text-white/35 ml-1">Échap</span>
            </button>
          </div>
        </div>

        <div className="flex-1 grid grid-cols-3 max-md:grid-cols-[85%_85%_85%] max-md:overflow-x-auto max-md:snap-x max-md:snap-mandatory gap-4 max-md:gap-2 min-h-0 pointer-events-auto">
          {COLUMNS.map((col) => {
            const items = visible.filter((t) => t.status === col.status).sort((a, b) => a.order - b.order);
            const over = !!drag?.active && drop?.status === col.status;
            return (
              <div
                key={col.status}
                data-col={col.status}
                className={`glass neon flex flex-col min-h-0 transition-shadow ${over ? 'shadow-[0_0_44px_rgb(var(--c)/0.22)]' : ''}`}
                style={cvar(col.color)}
              >
                <Corners />
                <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-3 border-b border-white/[0.06]">
                  <span className="dot" />
                  <span className="hud text-[11px] text-[rgb(var(--c))]">{col.label}</span>
                  <span className="mono text-[11px] text-white/40">{String(items.length).padStart(2, '0')}</span>
                  <span className="hud text-[9px] text-white/25 ml-auto">{col.hint}</span>
                </div>
                {col.status === 'todo' && (
                  <div className="px-3 pt-3">
                    <input
                      className="field !text-[12.5px]"
                      placeholder="+ Nouvelle tâche (Entrée)"
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newTitle.trim()) {
                          createTask({
                            title: newTitle.trim(),
                            projectId: filter !== 'all' && filter !== 'none' ? filter : null,
                          });
                          setNewTitle('');
                        }
                      }}
                    />
                  </div>
                )}
                <div className="flex-1 overflow-y-auto scroll-thin p-3 flex flex-col gap-2">
                  {items.map((t) => (
                    <div key={t.id} className="flex flex-col gap-2">
                      {over && drop?.before === t.id && indicator}
                      <div
                        data-card={t.id}
                        onPointerDown={onCardPointerDown(t)}
                        onClick={() => {
                          if (!suppressClick.current) openEntity(t.id);
                        }}
                        className={`relative glass px-3.5 py-3 cursor-grab touch-none transition-all hover:border-[rgb(var(--c)/0.5)] hover:shadow-[0_0_24px_rgb(var(--c)/0.12)] ${
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
                    <div className="flex-1 min-h-[80px] border border-dashed border-white/10 flex items-center justify-center hud text-[9.5px] text-white/25">
                      Déposer ici
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="hud text-[9px] text-white/30 mt-3 flex gap-4 justify-center pointer-events-none">
          <span>Glisser-déposer entre colonnes</span>
          <span>
            <Kbd>⇧ Tab</Kbd> basculer
          </span>
          <span>Clic = ouvrir dans le réseau</span>
        </div>
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
