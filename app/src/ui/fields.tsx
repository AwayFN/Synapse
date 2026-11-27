import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { displayTitle, useData } from '../store/data';
import { neighborsOf, projectNotes, projectSlots, projectTasks } from '../store/graph';
import { useUI } from '../store/ui';
import { NEON } from '../lib/color';
import { excerpt, normalizeTag } from '../lib/text';
import { crossesMidnight, fmtDateShort, fmtDuration, fmtHM, fmtTime, slotDuration, todayISO } from '../lib/time';
import type { Entity, Note, Project, Slot, Task, TaskStatus } from '../types';
import { bodyOf, TASK_STATUS_LABEL } from '../types';
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

/**
 * Le texte long d'un élément (description d'une tâche, d'un projet, d'un créneau ; contenu d'une note) : un aperçu
 * qui ouvre l'éditeur en grand, comme pour les notes, au lieu d'une petite zone où l'on écrit à l'étroit.
 */
export function BodyPreview({ e, placeholder }: { e: Entity; placeholder: string }) {
  const openEditor = useUI((s) => s.openEditor);
  const text = bodyOf(e).trim();
  const open = () => openEditor(e.id, { keepView: true });
  return (
    <div
      role="button"
      tabIndex={0}
      data-body-preview
      onClick={open}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          open();
        }
      }}
      className="w-full text-left text-[13px] leading-relaxed text-white/65 border border-white/[0.08] p-3 cursor-pointer hover:border-[rgb(var(--c)/0.6)] focus:border-[rgb(var(--c)/0.6)] outline-none transition-colors"
    >
      {text ? <span className="whitespace-pre-line break-words">{excerpt(text, 320)}</span> : <span className="text-white/30">{placeholder}</span>}
      <div className="hud text-[9.5px] text-[rgb(var(--c))] mt-2">{text ? 'Ouvrir en grand →' : 'Écrire en grand →'}</div>
    </div>
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

/** Linked entities + "+ Lier à…" */
export function LinksSection({ id, label = 'Liens', pickerLevel }: { id: string; label?: string; pickerLevel?: number }) {
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
        <button className="btn !py-1 !px-2 !text-[9.5px]" onClick={() => setPicking((p) => !p)}>
          + Lier à…
        </button>
      }
    >
      <div className="flex flex-wrap gap-1.5">
        {neighbors.length === 0 && !picking && <span className="text-[12px] text-white/30">Aucun lien pour l'instant.</span>}
        {neighbors.map((n) => (
          <EntityChip
            key={n.entity.id}
            id={n.entity.id}
            hint={n.kind === 'parent' ? (n.isParent ? 'projet' : n.entity.type === 'slot' ? 'créneau' : n.entity.type === 'note' ? 'note' : 'tâche') : undefined}
            onRemove={() => unlink(id, n.entity.id)}
          />
        ))}
      </div>
      {picking && <LinkPicker sourceId={id} onClose={() => setPicking(false)} level={pickerLevel} />}
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

export function DateField({ value, onChange, allowEmpty = true }: { value: string | null; onChange: (v: string | null) => void; allowEmpty?: boolean }) {
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
        <BodyPreview e={p} placeholder="De quoi s’agit-il ? Objectifs, idées, contexte…" />
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
      <ProjectNotes p={p} />
      <ProjectSlots p={p} />
    </>
  );
}

/** Les notes du projet (une note peut appartenir à un projet, ou rester indépendante) */
function ProjectNotes({ p }: { p: Project }) {
  const notes = useData(useShallow((s) => projectNotes(s.entities, p.id)));
  const createNote = useData((s) => s.createNote);
  const openEditor = useUI((s) => s.openEditor);
  const [title, setTitle] = useState('');
  return (
    <Section label={`Notes · ${notes.length}`}>
      <div className="flex flex-col">
        {notes.slice(0, 12).map((n) => (
          <div
            key={n.id}
            role="button"
            tabIndex={0}
            onClick={() => openEditor(n.id)}
            onKeyDown={(e) => e.key === 'Enter' && openEditor(n.id)}
            className="flex items-center gap-2.5 py-[5px] text-left group cursor-pointer outline-none"
            style={cvar(n.color)}
          >
            <span className="dot" />
            <span className="text-[13px] text-white/80 truncate flex-1 group-hover:text-white group-focus:text-white">{displayTitle(n)}</span>
            <span className="mono text-[9.5px] text-white/35 flex-none">{fmtDateShort(new Date(n.updatedAt).toISOString().slice(0, 10))}</span>
          </div>
        ))}
        {notes.length > 12 && <span className="xs-label mt-1">+ {notes.length - 12} autres (vue Notes)</span>}
      </div>
      <input
        className="field mt-2 !text-[12.5px]"
        placeholder="+ Nouvelle note du projet (Entrée)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const n = createNote({ title: title.trim(), projectId: p.id });
            setTitle('');
            openEditor(n.id, { keepView: true });
          }
        }}
      />
    </Section>
  );
}

/** Le temps passé (ou prévu) sur le projet, d'après les créneaux de l'agenda */
function ProjectSlots({ p }: { p: Project }) {
  const entities = useData((s) => s.entities);
  const openEntity = useUI((s) => s.openEntity);
  const slots = projectSlots(entities, p.id);
  const total = slots.reduce((acc, s) => acc + slotDuration(s.start, s.end), 0);
  return (
    <Section label={`Agenda · ${slots.length ? fmtHM(total) : 'aucun créneau'}`}>
      {slots.length === 0 ? (
        <div className="text-[12px] text-white/35 leading-relaxed">
          Dans l’agenda (touche Tab), crée un créneau et choisis ce projet : le temps qui lui est consacré s’affiche ici.
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
      <Section label="Dans l’agenda · date & heure (optionnelles)">
        <DayTimeField date={t.date} time={t.time} onChange={(date, time) => update(t.id, { date, time })} />
      </Section>
      <Section label="Description">
        <BodyPreview e={t} placeholder="Détails, contexte, étapes…" />
      </Section>
    </>
  );
}

/**
 * Le jour (et l'heure, s'il y en a une) d'une tâche ou d'une note : sa place dans l'agenda. Une heure sans jour
 * prend aujourd'hui ; effacer le jour efface aussi l'heure.
 */
export function DayTimeField({ date, time, onChange }: { date: string | null; time: number | null; onChange: (date: string | null, time: number | null) => void }) {
  return (
    <div className="flex gap-1.5" data-day-time>
      <div className="flex-1 min-w-0">
        <DateField value={date} onChange={(v) => onChange(v, v ? time : null)} />
      </div>
      <TimeInput value={time} allowEmpty placeholder="--:--" className="!w-[86px]" onChange={(m) => onChange(date ?? (m != null ? todayISO() : null), m)} />
    </div>
  );
}

/** Une note : son projet (ou indépendante), sa place dans l'agenda (V8), son contenu (écrit en grand) */
export function NoteFields({ n, compact }: { n: Note; compact?: boolean }) {
  const update = useData((s) => s.update);
  return (
    <>
      <Section label="Projet">
        <ProjectSelect value={n.projectId ?? null} onChange={(id) => update(n.id, { projectId: id })} empty="— Note indépendante —" />
      </Section>
      <Section label="Dans l’agenda · jour & heure (optionnels)">
        <DayTimeField date={n.date ?? null} time={n.time ?? null} onChange={(date, time) => update(n.id, { date, time })} />
      </Section>
      {!compact && (
        <Section label="Contenu">
          <BodyPreview e={n} placeholder="Note vide : écris-la en grand." />
        </Section>
      )}
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
          <BodyPreview e={s} placeholder="Ce que tu fais pendant ce créneau…" />
        </Section>
      )}
    </>
  );
}

/** Ce qui sépare deux tags pendant la saisie : espace, virgule, point-virgule, retour à la ligne */
const TAG_SEP = /[\s,;]+/;

/**
 * Les tags d'un élément, quel qu'il soit (projet, tâche, note, créneau). Les mêmes sur le PC et sur le téléphone :
 * Entrée, espace ou virgule valident un tag (sur Android, le clavier ne signale pas toujours ces touches : le texte
 * tapé est donc aussi découpé à chaque changement) ; les tags déjà utilisés sont proposés.
 */
export function TagEditor({ id, tags }: { id: string; tags: string[] }) {
  const update = useData((s) => s.update);
  const all = useAllTags();
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  const addMany = (raws: string[]) => {
    const next = [...tags];
    for (const raw of raws) {
      const t = normalizeTag(raw);
      if (t && !next.includes(t)) next.push(t);
    }
    if (next.length !== tags.length) update(id, { tags: next });
  };
  const add = (raw: string) => addMany([raw]);
  const suggestions = all
    .map(([t]) => t)
    .filter((t) => !tags.includes(t) && (!text || t.startsWith(normalizeTag(text))))
    .slice(0, 8);
  return (
    <div className="flex flex-wrap items-center gap-1.5 relative" data-tag-editor>
      {tags.map((t) => (
        <span key={t} className="chip" style={cvar(tagColor(t))}>
          #{t}
          <button
            className="opacity-50 hover:opacity-100 px-0.5 max-md:px-1.5 max-md:-my-1 max-md:py-1 max-md:text-[14px] leading-none"
            title={`Retirer #${t}`}
            aria-label={`Retirer le tag ${t}`}
            onClick={() => update(id, { tags: tags.filter((x) => x !== t) })}
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={text}
        enterKeyHint="done"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value;
          if (TAG_SEP.test(v)) {
            // « idee urgent » ou « idee, » : ce qui est complet devient tag, le reste continue d'être tapé
            const parts = v.split(TAG_SEP);
            const rest = /[\s,;]$/.test(v) ? '' : parts.pop() ?? '';
            addMany(parts.filter(Boolean));
            setText(rest);
          } else setText(v);
        }}
        onFocus={() => setFocus(true)}
        onBlur={() => setTimeout(() => setFocus(false), 150)}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ',' || e.key === ' ') && text.trim()) {
            e.preventDefault();
            add(text);
            setText('');
          } else if (e.key === 'Enter') {
            e.preventDefault();
          } else if (e.key === 'Backspace' && !text && tags.length) {
            update(id, { tags: tags.slice(0, -1) });
          }
        }}
        onBlurCapture={() => {
          // un tag tapé puis abandonné (clic ailleurs) n'est pas perdu
          if (text.trim()) {
            add(text);
            setText('');
          }
        }}
        placeholder={tags.length ? '+ tag' : '+ ajouter un tag (#idee, #urgent…)'}
        className="bg-transparent outline-none mono text-[11px] max-md:text-[13px] text-white/80 placeholder:text-white/25 min-w-[120px] py-1 max-md:py-1.5"
        data-tag-input
      />
      {focus && suggestions.length > 0 && (
        <div className="absolute left-0 top-full mt-1 glass z-30 flex flex-wrap gap-1 max-md:gap-1.5 p-2 max-w-[420px] anim-pop" data-tag-suggestions>
          {suggestions.map((t) => (
            <button
              key={t}
              className="chip max-md:!py-1.5 max-md:!px-2.5"
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
