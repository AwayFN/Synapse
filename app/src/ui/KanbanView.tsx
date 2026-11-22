import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { displayTitle, useData } from '../store/data';
import { useUI } from '../store/ui';
import { degreeOf, linkedHubs } from '../store/graph';
import { fmtDay, fmtWhen, todayISO } from '../lib/time';
import { isHubKind, kindLabel, NATURES, PEARL_HEX } from '../lib/kinds';
import { isLate } from '../lib/entity';
import { parseCapture } from '../lib/parse';
import { commitCapture } from '../lib/capture';
import type { Entity, Status } from '../types';
import { Corners, cvar, Kbd, natureVar } from './common';
import { can, useCan } from '../sync/perm';

const COLUMNS: { status: Status; label: string; color: string; hint: string }[] = [
  { status: 'todo', label: 'À faire', color: PEARL_HEX, hint: 'file d’attente' },
  { status: 'doing', label: 'En cours', color: NATURES.action.hex, hint: 'focus' },
  { status: 'done', label: 'Fait', color: '#8a93a6', hint: 'accompli' },
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

function CardBody({ t }: { t: Entity }) {
  const hubs = useData(useShallow((s) => linkedHubs(s.entities, s.links, t.id)));
  const links = useData((s) => degreeOf(s.links, t.id));
  const setStatus = useData((s) => s.setStatus);
  const late = isLate(t, todayISO());
  return (
    <>
      <span className="absolute left-0 top-0 bottom-0 w-[2px] bg-[rgb(var(--c)/0.7)]" />
      <div className="flex items-start gap-2.5">
        <button
          onPointerDown={(e) => e.stopPropagation()}
          disabled={!can.edit(t)}
          onClick={(e) => {
            e.stopPropagation();
            if (can.edit(t)) setStatus(t.id, t.status === 'done' ? 'todo' : 'done');
          }}
          className={`mt-[3px] w-[14px] h-[14px] border flex-none flex items-center justify-center text-[9px] transition-all ${
            t.status === 'done' ? 'border-white/25 text-white/60' : 'border-[rgb(var(--amber)/0.5)] hover:border-[rgb(var(--amber))]'
          }`}
          title={t.status === 'done' ? 'Rouvrir' : 'Marquer comme fait'}
        >
          {t.status === 'done' ? '✓' : ''}
        </button>
        <div className={`text-[13.5px] leading-snug ${t.status === 'done' ? 'text-white/40 line-through' : 'text-white/90'}`}>{displayTitle(t)}</div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 mt-2.5 pl-[24px]">
        {t.kind && t.kind !== 'tâche' && <span className="mono text-[9px] tracking-[0.12em] uppercase text-[rgb(var(--c)/0.8)]">{kindLabel(t.kind)}</span>}
        {hubs.slice(0, 2).map((h) => (
          <span key={h.id} className="chip !text-[9.5px] !py-px max-w-full" style={natureVar('action')}>
            <span className="truncate">↳ {displayTitle(h)}</span>
          </span>
        ))}
        {t.when && <span className={`mono text-[9.5px] tracking-[0.1em] ${late ? 'text-[rgb(var(--alert))]' : 'text-white/45'}`}>{fmtWhen(t.when)}</span>}
        {t.due && <span className={`mono text-[9.5px] tracking-[0.1em] ${late ? 'text-[rgb(var(--alert))]' : 'text-white/45'}`}>⟶ {fmtDay(t.due)}</span>}
        {links > 0 && <span className="mono text-[9.5px] text-white/32">⟷ {links}</span>}
      </div>
    </>
  );
}

function Kanban() {
  const tasks = useData(useShallow((s) => Object.values(s.entities).filter((e) => !!e.status && !isHubKind(e.kind))));
  const hubs = useData(useShallow((s) => Object.values(s.entities).filter((e) => isHubKind(e.kind) && e.status !== 'done')));
  const links = useData((s) => s.links);
  const entities = useData((s) => s.entities);
  const moveCard = useData((s) => s.moveCard);
  const setView = useUI((s) => s.setView);
  const openEntity = useUI((s) => s.openEntity);
  const [filter, setFilter] = useState<string>('all');
  const [drag, setDrag] = useState<DragState | null>(null);
  const [drop, setDrop] = useState<{ status: Status; before: string | null } | null>(null);
  const [celebrate, setCelebrate] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const dragRef = useRef<DragState | null>(null);
  const dropRef = useRef<{ status: Status; before: string | null } | null>(null);
  const suppressClick = useRef(false);
  const perm = useCan();

  const hubOf = (t: Entity) => linkedHubs(entities, links, t.id).map((h) => h.id);
  const visible = tasks.filter((t) => (filter === 'all' ? true : filter === 'none' ? hubOf(t).length === 0 : hubOf(t).includes(filter)));
  const done = tasks.filter((t) => t.status === 'done').length;

  const computeDrop = (x: number, y: number, dragId: string) => {
    const col = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-col]');
    if (!col) return null;
    const status = col.dataset.col as Status;
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

  const onCardPointerDown = (t: Entity) => (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !can.edit(t)) return;
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
          const was = useData.getState().entities[d.id]?.status ?? null;
          moveCard(d.id, dr.status, dr.before);
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

  const indicator = <div className="h-[2px] -my-[1px] bg-white/80 rounded-full" />;
  const dragged = drag?.active ? tasks.find((t) => t.id === drag.id) : undefined;

  return (
    <div className={`fixed inset-0 z-30 anim-fade ${drag?.active ? 'cursor-grabbing select-none' : ''}`} data-ui>
      <div className="backdrop" onClick={() => setView('network')} />
      <div className="absolute inset-x-6 top-5 bottom-5 flex flex-col pointer-events-none">
        <div className="flex items-end justify-between pointer-events-auto mb-4 gap-6">
          <div>
            <div className="hud text-[10px]" style={{ color: NATURES.action.hex }}>
              Vue tâches · tout ce qui est à accomplir
            </div>
            <div className="text-[28px] font-semibold tracking-tight text-white mt-1">
              {done}
              <span className="text-white/30"> / {tasks.length}</span>
              <span className="text-[13px] font-normal text-white/40 ml-3">actions accomplies</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 justify-end">
            <button className="chip" data-on={filter === 'all' ? '1' : '0'} onClick={() => setFilter('all')}>
              Toutes
            </button>
            {hubs.map((p) => (
              <button key={p.id} className="chip" data-on={filter === p.id ? '1' : '0'} style={natureVar('action')} onClick={() => setFilter(p.id)}>
                {displayTitle(p)}
              </button>
            ))}
            <button className="chip chip-muted" data-on={filter === 'none' ? '1' : '0'} onClick={() => setFilter('none')}>
              Sans projet
            </button>
            <button className="btn ml-3" onClick={() => setView('network')}>
              ← Réseau <span className="text-white/35 ml-1">Échap</span>
            </button>
          </div>
        </div>

        <div className="flex-1 grid grid-cols-3 gap-4 min-h-0 pointer-events-auto kanban-cols max-md:flex max-md:overflow-x-auto max-md:snap-x max-md:snap-mandatory max-md:gap-3">
          {COLUMNS.map((col) => {
            const items = visible.filter((t) => t.status === col.status).sort((a, b) => a.order - b.order);
            const over = !!drag?.active && drop?.status === col.status;
            return (
              <div
                key={col.status}
                data-col={col.status}
                className={`glass neon flex flex-col min-h-0 transition-shadow max-md:min-w-[84vw] max-md:snap-center ${over ? 'shadow-[0_0_40px_rgb(var(--c)/0.14)]' : ''}`}
                style={cvar(col.color)}
              >
                <Corners />
                <div className="flex items-center gap-2.5 px-4 pt-3.5 pb-3 border-b border-white/[0.05]">
                  <span className="dot" />
                  <span className="hud text-[11px] text-[rgb(var(--c))]">{col.label}</span>
                  <span className="mono text-[11px] text-white/40">{String(items.length).padStart(2, '0')}</span>
                  <span className="hud text-[9px] text-white/25 ml-auto">{col.hint}</span>
                </div>
                {col.status === 'todo' && perm.write() && (
                  <div className="px-3 pt-3">
                    <input
                      className="field !text-[12.5px]"
                      placeholder="+ Nouvelle action (Entrée) — ex : Relire le contrat demain 9h"
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newTitle.trim()) {
                          const p = parseCapture(newTitle, useData.getState().entities);
                          commitCapture(p, {
                            context: filter !== 'all' && filter !== 'none' ? [filter] : [],
                            defaults: { kind: 'tâche', status: 'todo' },
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
                        className={`relative glass px-3.5 py-3 cursor-grab touch-none transition-all hover:border-white/15 ${
                          drag?.active && drag.id === t.id ? 'opacity-25 scale-[0.98]' : ''
                        } ${celebrate === t.id ? 'anim-celebrate' : ''}`}
                        style={natureVar('action')}
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
          <span>N'importe quel neurone devient une action : facette « Action » dans son panneau</span>
          <span>
            <Kbd>⇧ Tab</Kbd> basculer
          </span>
        </div>
      </div>

      {dragged && drag && (
        <div
          className="fixed z-50 pointer-events-none glass px-3.5 py-3 rotate-[1.5deg] shadow-[0_18px_50px_rgb(0_0_0/0.6)] border-white/20"
          style={natureVar('action', { left: drag.x - drag.dx, top: drag.y - drag.dy, width: drag.w })}
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
