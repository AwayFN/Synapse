import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { displayTitle, useData } from '../store/data';
import { neighborsOf, projectSlots, projectTasks } from '../store/graph';
import { useUI } from '../store/ui';
import { NEON } from '../lib/color';
import { normalizeTag } from '../lib/text';
import { crossesMidnight, fmtDateShort, fmtDuration, fmtHM, fmtTime, slotDuration, todayISO } from '../lib/time';
import type { Note, Project, Slot, Task, TaskStatus } from '../types';
import { TASK_STATUS_LABEL } from '../types';
import { cvar } from './common';
import { EntityChip } from './EntityChip';
import { LinkPicker } from './LinkPicker';
import { TimeInput } from './TimeInput';
import { tagColor, useAllTags } from './TagBar';

export function Section({ label, children, right }: { label: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between mb-2">
        <span className="xs-label">{label}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

export function AutoTextarea({
  value,
  onChange,
  placeholder,
  className = '',
  minRows = 2,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  minRows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={minRows}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`field resize-none leading-relaxed ${className}`}
    />
  );
}

export function ColorSwatches({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="flex flex-wrap gap-[7px]">
      {NEON.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          title={c}
          className="w-[18px] h-[18px] transition-transform hover:scale-125"
          style={{
            background: c,
            boxShadow: value.toLowerCase() === c ? `0 0 0 2px #000, 0 0 0 3px ${c}, 0 0 14px ${c}` : `0 0 8px ${c}55`,
          }}
        />
      ))}
      <label className="w-[18px] h-[18px] border border-white/25 flex items-center justify-center text-[10px] text-white/50 cursor-pointer hover:text-white relative" title="Couleur libre">
        +
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 opacity-0 cursor-pointer" />
      </label>
    </div>
  );
}

/** Linked entities + "+ Lier à…" (en lecture seule : on peut ouvrir les liens, pas les changer) */
export function LinksSection({ id, label = 'Liens', readOnly = false }: { id: string; label?: string; readOnly?: boolean }) {
  const entities = useData((s) => s.entities);
  const links = useData((s) => s.links);
  const unlink = useData((s) => s.unlink);
  const [picking, setPicking] = useState(false);
  const self = entities[id];
  const neighbors = neighborsOf(entities, links, id).filter((n) => !(self?.type === 'project' && n.kind === 'parent'));
  return (
    <Section
      label={`${label} · ${neighbors.length}`}
      right={
        readOnly ? undefined : (
          <button className="btn !py-1 !px-2 !text-[9.5px]" onClick={() => setPicking((p) => !p)}>
            + Lier à…
          </button>
        )
      }
    >
      <div className="flex flex-wrap gap-1.5">
        {neighbors.length === 0 && !picking && <span className="text-[12px] text-white/30">Aucun lien pour l'instant.</span>}
        {neighbors.map((n) => (
          <EntityChip
            key={n.entity.id}
            id={n.entity.id}
            hint={n.kind === 'parent' ? (n.isParent ? 'projet' : n.entity.type === 'slot' ? 'créneau' : 'tâche') : undefined}
            onRemove={readOnly ? undefined : () => unlink(id, n.entity.id)}
          />
        ))}
      </div>
      {picking && !readOnly && <LinkPicker sourceId={id} onClose={() => setPicking(false)} />}
    </Section>
  );
}

function StatusSeg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string; c: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.v} data-on={value === o.v ? '1' : '0'} style={cvar(o.c)} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export const TASK_STATUS_OPTIONS: { v: TaskStatus; label: string; c: string }[] = [
  { v: 'todo', label: TASK_STATUS_LABEL.todo, c: '#00e5ff' },
  { v: 'doing', label: TASK_STATUS_LABEL.doing, c: '#ffb020' },
  { v: 'done', label: TASK_STATUS_LABEL.done, c: '#39ff88' },
];

function DateField({ value, onChange, allowEmpty = true }: { value: string | null; onChange: (v: string | null) => void; allowEmpty?: boolean }) {
  return (
    <div className="flex gap-1.5">
      <input
        type="date"
        className="field field-mono"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || (allowEmpty ? null : value))}
      />
      {allowEmpty && value && (
        <button className="btn btn-ghost !px-2" title="Effacer" onClick={() => onChange(null)}>
          ✕
        </button>
      )}
    </div>
  );
}

export function ProjectFields({ p }: { p: Project }) {
  const update = useData((s) => s.update);
  const entities = useData((s) => s.entities);
  const createTask = useData((s) => s.createTask);
  const setTaskStatus = useData((s) => s.setTaskStatus);
  const openEntity = useUI((s) => s.openEntity);
  const [newTask, setNewTask] = useState('');
  const tasks = projectTasks(entities, p.id).sort(
    (a, b) => Number(a.status === 'done') - Number(b.status === 'done') || a.order - b.order,
  );
  const done = tasks.filter((t) => t.status === 'done').length;
  return (
    <>
      <Section label="Statut">
        <StatusSeg
          value={p.status}
          onChange={(v) => update(p.id, { status: v })}
          options={[
            { v: 'active', label: 'En cours', c: '#00e5ff' },
            { v: 'done', label: 'Terminé', c: '#39ff88' },
          ]}
        />
      </Section>
      <Section label="Deadline (optionnelle)">
        <DateField value={p.deadline} onChange={(v) => update(p.id, { deadline: v })} />
      </Section>
      <Section label="Description">
        <AutoTextarea value={p.description} onChange={(v) => update(p.id, { description: v })} placeholder="De quoi s'agit-il ?" />
      </Section>
      <Section label={`Tâches · ${done}/${tasks.length}`}>
        <div className="h-px bg-white/10 mb-3 relative">
          <div className="absolute inset-y-0 left-0 bg-[#39ff88] shadow-[0_0_8px_#39ff88] transition-all duration-500" style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }} />
        </div>
        <div className="flex flex-col">
          {tasks.map((t) => (
            <div key={t.id} className="flex items-center gap-2.5 py-[5px] group" style={cvar(t.color)}>
              <button
                onClick={() => setTaskStatus(t.id, t.status === 'done' ? 'todo' : 'done')}
                className={`w-[15px] h-[15px] border flex-none flex items-center justify-center text-[10px] transition-all ${
                  t.status === 'done' ? 'border-[#39ff88] bg-[#39ff88]/20 text-[#39ff88] shadow-[0_0_8px_#39ff88]' : 'border-white/25 hover:border-white/70'
                }`}
                title={t.status === 'done' ? 'Rouvrir' : 'Marquer comme faite'}
              >
                {t.status === 'done' ? '✓' : ''}
              </button>
              <button
                onClick={() => openEntity(t.id)}
                className={`text-[13px] text-left truncate flex-1 hover:text-white ${t.status === 'done' ? 'line-through text-white/35' : 'text-white/80'}`}
              >
                {displayTitle(t)}
              </button>
              {t.status === 'doing' && <span className="mono text-[9px] text-[#ffb020] tracking-[0.12em]">EN COURS</span>}
            </div>
          ))}
        </div>
        <input
          className="field mt-2 !text-[12.5px]"
          placeholder="+ Nouvelle tâche (Entrée)"
          value={newTask}
          onChange={(e) => setNewTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newTask.trim()) {
              createTask({ title: newTask.trim(), projectId: p.id });
              setNewTask('');
            }
          }}
        />
      </Section>
      <ProjectSlots p={p} />
    </>
  );
}

/** Le temps passé (ou prévu) sur le projet, d'après l'emploi du temps */
function ProjectSlots({ p }: { p: Project }) {
  const entities = useData((s) => s.entities);
  const openEntity = useUI((s) => s.openEntity);
  const slots = projectSlots(entities, p.id);
  const total = slots.reduce((acc, s) => acc + slotDuration(s.start, s.end), 0);
  return (
    <Section label={`Emploi du temps · ${slots.length ? fmtHM(total) : 'aucun créneau'}`}>
      {slots.length === 0 ? (
        <div className="text-[12px] text-white/35 leading-relaxed">
          Dans l’emploi du temps (touche Tab), crée un créneau et choisis ce projet : le temps s’affiche ici.
        </div>
      ) : (
        <div className="flex flex-col">
          {slots.slice(0, 8).map((s) => (
            <button key={s.id} onClick={() => openEntity(s.id)} className="flex items-center gap-2.5 py-[5px] text-left group" style={cvar(s.color)}>
              <span className="dot" />
              <span className="mono text-[10px] tracking-[0.08em] text-white/45 w-[86px] flex-none">{fmtDateShort(s.date)}</span>
              <span className="text-[12.5px] text-white/80 truncate flex-1 group-hover:text-white">{displayTitle(s)}</span>
              <span className="mono text-[10px] text-white/45 flex-none">
                {fmtTime(s.start)} → {fmtTime(s.end)} · {fmtHM(slotDuration(s.start, s.end))}
              </span>
            </button>
          ))}
          {slots.length > 8 && <span className="xs-label mt-1">+ {slots.length - 8} autres</span>}
        </div>
      )}
    </Section>
  );
}

/** Choisir le projet d'une tâche ou d'un créneau */
export function ProjectSelect({ value, onChange, empty }: { value: string | null; onChange: (id: string | null) => void; empty: string }) {
  const projects = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Project => e.type === 'project')));
  const sorted = [...projects].sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || displayTitle(a).localeCompare(displayTitle(b)));
  return (
    <select className="field" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">{empty}</option>
      {sorted.map((p) => (
        <option key={p.id} value={p.id}>
          {displayTitle(p)}
          {p.status === 'done' ? ' (terminé)' : ''}
        </option>
      ))}
    </select>
  );
}

export function TaskFields({ t }: { t: Task }) {
  const update = useData((s) => s.update);
  return (
    <>
      <Section label="Statut">
        <StatusSeg value={t.status} onChange={(v) => update(t.id, { status: v })} options={TASK_STATUS_OPTIONS} />
      </Section>
      <Section label="Projet parent">
        <ProjectSelect value={t.projectId} onChange={(id) => update(t.id, { projectId: id })} empty="— Tâche indépendante —" />
      </Section>
      <Section label="Date & heure (optionnelles)">
        <div className="flex gap-1.5">
          <div className="flex-1">
            <DateField value={t.date} onChange={(v) => update(t.id, { date: v })} />
          </div>
          <TimeInput value={t.time} allowEmpty placeholder="--:--" className="!w-[86px]" onChange={(m) => update(t.id, { time: m, date: t.date ?? (m != null ? todayISO() : null) })} />
        </div>
      </Section>
      <Section label="Description">
        <AutoTextarea value={t.description} onChange={(v) => update(t.id, { description: v })} placeholder="Détails, contexte…" />
      </Section>
    </>
  );
}

export function SlotFields({ s, compact }: { s: Slot; compact?: boolean }) {
  const update = useData((st) => st.update);
  const dur = slotDuration(s.start, s.end);
  return (
    <>
      <Section label="Projet">
        <ProjectSelect value={s.projectId ?? null} onChange={(id) => update(s.id, { projectId: id })} empty="Sans projet" />
      </Section>
      <Section label="Date">
        <DateField value={s.date} allowEmpty={false} onChange={(v) => v && update(s.id, { date: v })} />
      </Section>
      <Section label="Horaires libres">
        <div className="flex items-center gap-2">
          <TimeInput value={s.start} onChange={(m) => m != null && update(s.id, { start: m })} />
          <span className="text-white/40 mono">→</span>
          <TimeInput value={s.end} onChange={(m) => m != null && update(s.id, { end: m })} />
        </div>
        <div className="mono text-[10.5px] tracking-[0.1em] text-white/45 mt-2 flex gap-3">
          <span>DURÉE {fmtDuration(dur)}</span>
          {crossesMidnight(s.start, s.end) && <span className="text-[#ffb020]">FIN LE LENDEMAIN (+1J)</span>}
        </div>
      </Section>
      {!compact && (
        <Section label="Description">
          <AutoTextarea value={s.description} onChange={(v) => update(s.id, { description: v })} placeholder="Notes sur ce créneau…" />
        </Section>
      )}
    </>
  );
}

export function TagEditor({ note }: { note: Note }) {
  const update = useData((s) => s.update);
  const all = useAllTags();
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  const add = (raw: string) => {
    const t = normalizeTag(raw);
    if (!t || note.tags.includes(t)) return;
    update(note.id, { tags: [...note.tags, t] });
  };
  const suggestions = all
    .map(([t]) => t)
    .filter((t) => !note.tags.includes(t) && (!text || t.startsWith(normalizeTag(text))))
    .slice(0, 8);
  return (
    <div className="flex flex-wrap items-center gap-1.5 relative">
      {note.tags.map((t) => (
        <span key={t} className="chip" style={cvar(tagColor(t))}>
          #{t}
          <button className="opacity-50 hover:opacity-100" onClick={() => update(note.id, { tags: note.tags.filter((x) => x !== t) })}>
            ×
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setTimeout(() => setFocus(false), 150)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && text.trim()) {
            e.preventDefault();
            add(text);
            setText('');
          } else if (e.key === 'Backspace' && !text && note.tags.length) {
            update(note.id, { tags: note.tags.slice(0, -1) });
          }
        }}
        placeholder={note.tags.length ? '+ tag' : '+ ajouter un tag (#idee, #urgent…)'}
        className="bg-transparent outline-none mono text-[11px] text-white/80 placeholder:text-white/25 min-w-[120px] py-1"
      />
      {focus && suggestions.length > 0 && (
        <div className="absolute left-0 top-full mt-1 glass z-30 flex flex-wrap gap-1 p-2 max-w-[420px] anim-pop">
          {suggestions.map((t) => (
            <button
              key={t}
              className="chip"
              style={cvar(tagColor(t))}
              onMouseDown={(e) => {
                e.preventDefault();
                add(t);
                setText('');
              }}
            >
              #{t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
