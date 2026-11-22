import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { displayTitle, useData } from '../store/data';
import { findLink, linkedActions, neighborsOf, secondDegree } from '../store/graph';
import { useUI } from '../store/ui';
import { suggestionsFor } from '../lib/similar';
import { mentionsIn, parseCapture, resolveRef } from '../lib/parse';
import { commitCapture } from '../lib/capture';
import { builtinKind, isHubKind, kindLabel, kindSuggestions, natureOf, natureOfKind, NATURE_ORDER, NATURES } from '../lib/kinds';
import { norm, normalizeTag } from '../lib/text';
import { addDays, crossesMidnight, fmtDay, fmtDuration, fmtWhen, slotDuration, todayISO } from '../lib/time';
import type { Entity, Status } from '../types';
import { STATUS_LABEL } from '../types';
import { can } from '../sync/perm';
import { useSession } from '../sync/session';
import { EntityGlyph, Glyph, natureVar, useKinds } from './common';
import { EntityChip } from './EntityChip';
import { LinkPicker } from './LinkPicker';
import { TimeInput } from './TimeInput';
import { useAllTags } from './TagBar';

export function Section({ label, children, right }: { label: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mt-5">
      <div className="flex items-center justify-between mb-2 gap-2">
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
  onBlur,
  onFocus,
  placeholder,
  className = '',
  minRows = 2,
  readOnly,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  placeholder?: string;
  className?: string;
  minRows?: number;
  readOnly?: boolean;
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
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onFocus={onFocus}
      className={`field resize-none leading-relaxed ${readOnly ? 'opacity-80 cursor-default' : ''} ${className}`}
    />
  );
}

/** Genres déjà utilisés (clé primitive pour un abonnement stable) */
function useUsedKinds(): string[] {
  const key = useData((s) => {
    const set = new Set<string>();
    for (const e of Object.values(s.entities)) if (e.kind) set.add(e.kind);
    return [...set].sort().join('\u0001');
  });
  return useMemo(() => (key ? key.split('\u0001') : []), [key]);
}

/** Genre libre (avec suggestions) + nature de ce genre : la seule chose qui décide de la couleur */
export function KindField({ e, ro }: { e: Entity; ro?: boolean }) {
  const update = useData((s) => s.update);
  const setKindNature = useData((s) => s.setKindNature);
  const kinds = useKinds();
  const used = useUsedKinds();
  const [text, setText] = useState(e.kind);
  const [open, setOpen] = useState(false);
  useEffect(() => setText(e.kind), [e.kind]);
  const nature = natureOfKind(e.kind, kinds);
  if (ro) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-white/80" style={natureVar(nature)}>
        <Glyph nature={nature} size={10} />
        {kindLabel(e.kind)}
        <span className="mono text-[9px] tracking-[0.1em] text-white/35 uppercase">· {NATURES[nature].label}</span>
      </div>
    );
  }
  const sugg = kindSuggestions(kinds, used)
    .filter((k) => k.label !== e.kind && (!text || text === e.kind || norm(k.label).startsWith(norm(text))))
    .slice(0, 14);
  const commit = (v: string) => {
    const k = v.trim().toLowerCase();
    const label = builtinKind(k)?.label ?? k;
    if (label !== e.kind) update(e.id, { kind: label });
    setText(label);
  };
  const natures = can.natures();
  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <input
          className="field !py-1.5 !text-[12.5px] flex-1"
          value={text}
          placeholder="pensée — aucun genre"
          onFocus={() => setOpen(true)}
          onBlur={() =>
            setTimeout(() => {
              setOpen(false);
              commit(text);
            }, 140)
          }
          onChange={(ev) => setText(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter') {
              ev.preventDefault();
              (ev.target as HTMLInputElement).blur();
            } else if (ev.key === 'Escape') {
              ev.stopPropagation();
              setText(e.kind);
              (ev.target as HTMLInputElement).blur();
            }
          }}
        />
        <div className="seg" title={e.kind ? `Nature de tous les neurones « ${e.kind} »` : 'Une pensée brute est de nature « pensée »'}>
          {NATURE_ORDER.map((n) => (
            <button
              key={n}
              data-on={nature === n ? '1' : '0'}
              style={natureVar(n)}
              disabled={!e.kind || !natures}
              className="!px-2.5 disabled:opacity-30"
              onClick={() => e.kind && nature !== n && setKindNature(e.kind, n)}
              title={`${NATURES[n].plural} · ${NATURES[n].hint}`}
            >
              <span className="dot !w-[6px] !h-[6px] inline-block" />
            </button>
          ))}
        </div>
      </div>
      <div className="mono text-[9px] tracking-[0.1em] text-white/30 mt-1.5">
        {NATURES[nature].label.toUpperCase()} · {NATURES[nature].hint}
      </div>
      {open && sugg.length > 0 && (
        <div className="absolute left-0 top-[38px] glass z-30 flex flex-wrap gap-1 p-2 max-w-[380px] anim-pop">
          {sugg.map((k) => (
            <button
              key={k.label}
              className="chip !text-[10px]"
              style={natureVar(k.nature)}
              onMouseDown={(ev) => {
                ev.preventDefault();
                commit(k.label);
                setOpen(false);
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Facettes facultatives : n'importe quel neurone peut devenir une action, un moment, avoir une échéance */
export function FacetBar({ e, ro }: { e: Entity; ro?: boolean }) {
  const update = useData((s) => s.update);
  const mode = useSession((s) => s.mode);
  if (ro) {
    const on = [e.status && '◆ Action', e.when && '○ Moment', e.due && '⟶ Échéance', e.pinned && '★ Important'].filter(Boolean);
    return on.length ? (
      <div className="flex flex-wrap gap-1.5">
        {on.map((x) => (
          <span key={String(x)} className="facet" data-on="1">
            {x}
          </span>
        ))}
      </div>
    ) : (
      <span className="text-[12px] text-white/35">Aucune</span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      <button
        className="facet"
        data-on={e.status ? '1' : '0'}
        style={natureVar('action')}
        onClick={() => update(e.id, { status: e.status ? null : 'todo' })}
        title="À accomplir : apparaît dans la vue Tâches"
      >
        <Glyph nature="action" shape={1} size={10} done={!e.status} /> Action
      </button>
      <button
        className="facet"
        data-on={e.when ? '1' : '0'}
        style={natureVar('temps')}
        onClick={() => update(e.id, { when: e.when ? null : { date: todayISO(), start: null, end: null } })}
        title="Un jour, une heure : apparaît dans l'agenda"
      >
        <Glyph nature="temps" shape={2} size={10} done={!e.when} hour={e.when?.start ?? null} /> Moment
      </button>
      <button className="facet" data-on={e.due ? '1' : '0'} onClick={() => update(e.id, { due: e.due ? null : addDays(todayISO(), 7) })} title="À faire avant une date">
        ⟶ Échéance
      </button>
      <button className="facet" data-on={e.pinned ? '1' : '0'} onClick={() => update(e.id, { pinned: !e.pinned })} title="Plus grand et toujours lumineux dans le réseau">
        ★ Important
      </button>
      {can.private() && (
        <button
          className="facet"
          data-on={e.private ? '1' : '0'}
          onClick={() => update(e.id, { private: !e.private })}
          title={mode === 'local' ? 'Ne sera jamais montré si tu partages ton cerveau' : 'Invisible pour tous tes invités, même avec un accès « tout le cerveau »'}
        >
          🔒 Privé
        </button>
      )}
    </div>
  );
}

export function StatusSeg({ value, onChange, disabled }: { value: Status; onChange: (v: Status) => void; disabled?: boolean }) {
  return (
    <div className="seg" style={natureVar('action')}>
      {(['todo', 'doing', 'done'] as Status[]).map((s) => (
        <button key={s} data-on={value === s ? '1' : '0'} disabled={disabled} onClick={() => onChange(s)} className="disabled:cursor-default">
          {STATUS_LABEL[s]}
        </button>
      ))}
    </div>
  );
}

function DateField({ value, onChange, allowEmpty = true }: { value: string | null; onChange: (v: string | null) => void; allowEmpty?: boolean }) {
  return (
    <div className="flex gap-1.5">
      <input type="date" className="field field-mono" value={value ?? ''} onChange={(e) => onChange(e.target.value || (allowEmpty ? null : value))} />
      {allowEmpty && value && (
        <button className="btn btn-ghost !px-2" title="Effacer" onClick={() => onChange(null)}>
          ✕
        </button>
      )}
    </div>
  );
}

/** Moment : jour + heures libres à la minute près (vide = toute la journée) */
export function WhenFields({ e, compact, ro }: { e: Entity; compact?: boolean; ro?: boolean }) {
  const update = useData((s) => s.update);
  const w = e.when;
  if (!w) return null;
  if (ro) return <div className="mono text-[12px] text-white/75" style={natureVar('temps')}>○ {fmtWhen(w)}</div>;
  const set = (patch: Partial<NonNullable<Entity['when']>>) => update(e.id, { when: { ...w, ...patch } });
  return (
    <div style={natureVar('temps')}>
      <div className={`flex ${compact ? 'flex-wrap' : ''} items-center gap-1.5`}>
        <div className="flex-1 min-w-[140px]">
          <DateField value={w.date} allowEmpty={false} onChange={(v) => v && set({ date: v })} />
        </div>
        <TimeInput value={w.start} allowEmpty placeholder="--:--" className="!w-[78px]" onChange={(m) => set({ start: m, end: m == null ? null : w.end })} />
        <span className="text-white/35 mono">→</span>
        <TimeInput value={w.end} allowEmpty placeholder="fin" className="!w-[78px]" onChange={(m) => set({ end: m, start: w.start ?? (m != null ? Math.max(0, m - 60) : null) })} />
      </div>
      <div className="mono text-[10px] tracking-[0.1em] text-white/40 mt-2 flex gap-3">
        {w.start == null ? (
          <span>TOUTE LA JOURNÉE · écris une heure pour la préciser</span>
        ) : w.end == null ? (
          <span>
            À {String(Math.floor(w.start / 60)).padStart(2, '0')}:{String(w.start % 60).padStart(2, '0')} · ajoute une fin si besoin
          </span>
        ) : (
          <>
            <span>DURÉE {fmtDuration(slotDuration(w.start, w.end))}</span>
            {crossesMidnight(w.start, w.end) && <span className="text-[rgb(var(--c))]">FIN LE LENDEMAIN (+1J)</span>}
          </>
        )}
      </div>
    </div>
  );
}

export function DueField({ e, ro }: { e: Entity; ro?: boolean }) {
  const update = useData((s) => s.update);
  if (ro) return <span className="mono text-[12px] text-white/75">{e.due ? fmtDay(e.due) : '—'}</span>;
  return <DateField value={e.due} onChange={(v) => update(e.id, { due: v })} />;
}

/** Tags de n'importe quel neurone */
export function TagEditor({ e, ro }: { e: Entity; ro?: boolean }) {
  const update = useData((s) => s.update);
  const all = useAllTags();
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  if (ro) {
    return e.tags.length ? (
      <div className="flex flex-wrap gap-1.5">
        {e.tags.map((t) => (
          <span key={t} className="chip">
            #{t}
          </span>
        ))}
      </div>
    ) : (
      <span className="text-[12px] text-white/35">Aucun</span>
    );
  }
  const add = (raw: string) => {
    const t = normalizeTag(raw);
    if (!t || e.tags.includes(t)) return;
    update(e.id, { tags: [...e.tags, t] });
  };
  const suggestions = all
    .map(([t]) => t)
    .filter((t) => !e.tags.includes(t) && (!text || t.startsWith(normalizeTag(text))))
    .slice(0, 10);
  return (
    <div className="flex flex-wrap items-center gap-1.5 relative">
      {e.tags.map((t) => (
        <span key={t} className="chip">
          #{t}
          <button className="opacity-45 hover:opacity-100" onClick={() => update(e.id, { tags: e.tags.filter((x) => x !== t) })}>
            ×
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(ev) => setText(ev.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setTimeout(() => setFocus(false), 150)}
        onKeyDown={(ev) => {
          if ((ev.key === 'Enter' || ev.key === ',' || ev.key === ' ') && text.trim()) {
            ev.preventDefault();
            add(text);
            setText('');
          } else if (ev.key === 'Backspace' && !text && e.tags.length) {
            update(e.id, { tags: e.tags.slice(0, -1) });
          }
        }}
        placeholder={e.tags.length ? '+ tag' : '+ tag (#idee, #urgent…)'}
        className="bg-transparent outline-none mono text-[11px] text-white/80 placeholder:text-white/25 min-w-[110px] py-1"
      />
      {focus && suggestions.length > 0 && (
        <div className="absolute left-0 top-full mt-1 glass z-30 flex flex-wrap gap-1 p-2 max-w-[420px] anim-pop">
          {suggestions.map((t) => (
            <button
              key={t}
              className="chip"
              onMouseDown={(ev) => {
                ev.preventDefault();
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

/** Quelqu'un d'autre écrit dans ce neurone en ce moment ? */
export function useOtherWriter(id: string): string | null {
  return useSession((s) => s.online.find((p) => p.id !== s.me.id && p.editing === id)?.name ?? null);
}

/** Annonce aux autres que j'écris dans ce neurone */
export const writing = {
  start: (id: string) => useSession.setState({ editing: id }),
  stop: (id: string) => {
    if (useSession.getState().editing === id) useSession.setState({ editing: null });
  },
};

/** Contenu libre ; écrire [[Titre]] relie au neurone de ce nom */
export function BodyField({ e, onExpand, ro }: { e: Entity; onExpand?: () => void; ro?: boolean }) {
  const update = useData((s) => s.update);
  const entities = useData((s) => s.entities);
  const other = useOtherWriter(e.id);
  const [force, setForce] = useState(false);
  const locked = !!other && !force;
  const pending = useMemo(() => {
    return mentionsIn(e.body)
      .map((t) => ({ t, ent: resolveRef(t, entities) }))
      .filter((m) => !m.ent || norm(m.ent.title) !== norm(m.t));
  }, [e.body, entities]);
  const linkMentions = () => {
    const d = useData.getState();
    for (const t of mentionsIn(e.body)) {
      const ent = Object.values(d.entities).find((x) => x.id !== e.id && norm(x.title) === norm(t));
      if (ent && !findLink(d.links, e.id, ent.id)) d.link(e.id, ent.id, { origin: 'mention', strength: 0.4 });
    }
  };
  return (
    <div>
      {other && !ro && (
        <div className="flex items-center gap-2 mb-2 mono text-[9.5px] tracking-[0.1em] text-white/60">
          <span className="w-1.5 h-1.5 rounded-full bg-[rgb(var(--pearl))] breathe" />
          {other.toUpperCase()} ÉCRIT ICI EN CE MOMENT
          {locked && (
            <button className="ml-auto text-white/45 hover:text-white underline underline-offset-2" onClick={() => setForce(true)}>
              écrire quand même
            </button>
          )}
        </div>
      )}
      <AutoTextarea
        value={e.body}
        readOnly={ro || locked}
        onChange={(v) => update(e.id, { body: v })}
        onFocus={() => !ro && writing.start(e.id)}
        onBlur={() => {
          writing.stop(e.id);
          if (!ro) linkMentions();
        }}
        placeholder={ro ? 'Aucun contenu.' : 'Développe, colle un texte, écris [[Titre]] pour relier…'}
        minRows={3}
        className="!text-[13px]"
      />
      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
        {!ro &&
          pending.map((m) => (
            <button
              key={m.t}
              className="chip !text-[9.5px]"
              title="Ce titre n'existe pas encore"
              onClick={() => useData.getState().create({ title: m.t }, { linkTo: [e.id], origin: 'mention', strength: 0.4, near: e.id })}
            >
              ＋ créer « {m.t} » et relier
            </button>
          ))}
        {onExpand && (
          <button className="ml-auto mono text-[9.5px] tracking-[0.12em] text-white/40 hover:text-white" onClick={onExpand}>
            {ro ? 'LIRE EN PLEIN ÉCRAN ⤢' : 'DÉVELOPPER EN PLEIN ÉCRAN ⤢'} <span className="text-white/25">ENTRÉE</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** Connexions directes, groupées par nature, avec leur force */
export function ConnectionsSection({ id, label = 'Connexions' }: { id: string; label?: string }) {
  const entities = useData((s) => s.entities);
  const links = useData((s) => s.links);
  const unlink = useData((s) => s.unlink);
  const kinds = useKinds();
  useSession((s) => s.role);
  const [picking, setPicking] = useState(false);
  const nbrs = neighborsOf(entities, links, id);
  const groups = NATURE_ORDER.map((n) => ({ n, items: nbrs.filter((x) => natureOf(x.entity, kinds) === n) })).filter((g) => g.items.length);
  return (
    <Section
      label={`${label} · ${nbrs.length}`}
      right={
        can.link() ? (
          <button className="btn !py-1 !px-2 !text-[9.5px]" onClick={() => setPicking((p) => !p)}>
            + Relier…
          </button>
        ) : undefined
      }
    >
      {nbrs.length === 0 && !picking && (
        <div className="text-[12px] text-white/35 leading-relaxed">
          {can.link() ? (
            <>
              Aucune connexion. Relie-la à ce qui l'a fait naître : <span className="text-white/55">+ Relier…</span>, ou <span className="text-white/55">Maj+clic</span> sur un neurone du
              réseau.
            </>
          ) : (
            'Aucune connexion.'
          )}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {groups.map((g) => (
          <div key={g.n} className="flex items-start gap-2">
            <span className="mt-[5px]" title={NATURES[g.n].plural}>
              <Glyph nature={g.n} size={9} />
            </span>
            <div className="flex flex-wrap gap-1.5 min-w-0">
              {g.items.map((x) => (
                <EntityChip key={x.entity.id} id={x.entity.id} strength={x.strength} onRemove={can.unlink(x.link) ? () => unlink(id, x.entity.id) : undefined} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {picking && <LinkPicker sourceId={id} onClose={() => setPicking(false)} />}
    </Section>
  );
}

/** Plus loin : le contexte au deuxième degré */
export function ContextSection({ id }: { id: string }) {
  const entities = useData((s) => s.entities);
  const links = useData((s) => s.links);
  const far = secondDegree(entities, links, id, 6);
  if (!far.length) return null;
  return (
    <Section label="Plus loin dans le réseau">
      <div className="flex flex-wrap gap-1.5">
        {far.map((d) => (
          <EntityChip key={d.entity.id} id={d.entity.id} compact hint={`via ${displayTitle(d.via).slice(0, 18)}`} />
        ))}
      </div>
    </Section>
  );
}

/** Associations que Synapse propose : un clic pour relier */
export function SuggestionsSection({ id }: { id: string }) {
  const entities = useData((s) => s.entities);
  const links = useData((s) => s.links);
  const kinds = useKinds();
  const sugg = useMemo(() => suggestionsFor(entities, links, id, 4), [entities, links, id]);
  if (!sugg.length) return null;
  return (
    <Section label="Connexions possibles">
      <div className="flex flex-col">
        {sugg.map((s) => (
          <div key={s.e.id} className="flex items-center gap-2.5 py-[5px] group" style={natureVar(natureOf(s.e, kinds))}>
            <EntityGlyph e={s.e} size={11} />
            <button className="min-w-0 flex-1 text-left" onClick={() => useUI.getState().openEntity(s.e.id)}>
              <div className="text-[12.5px] text-white/80 truncate group-hover:text-white">{displayTitle(s.e)}</div>
              <div className="mono text-[9px] tracking-[0.08em] text-white/32 truncate">{s.reasons.join(' · ')}</div>
            </button>
            {can.link() && (
              <button className="btn !py-0.5 !px-2 !text-[9px] opacity-60 group-hover:opacity-100" onClick={() => useData.getState().link(id, s.e.id, { strength: 0.45 })}>
                Relier
              </button>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

/** Actions reliées (pour un projet, un objectif… ou n'importe quel neurone) */
export function LinkedActionsSection({ e }: { e: Entity }) {
  const entities = useData((s) => s.entities);
  const links = useData((s) => s.links);
  const setStatus = useData((s) => s.setStatus);
  const openEntity = useUI((s) => s.openEntity);
  useSession((s) => s.role);
  const [text, setText] = useState('');
  const acts = linkedActions(entities, links, e.id);
  if (!acts.length && !isHubKind(e.kind)) return null;
  const done = acts.filter((a) => a.status === 'done').length;
  return (
    <Section label={`Actions reliées · ${done}/${acts.length}`}>
      <div className="h-px bg-white/10 mb-3 relative">
        <div className="absolute inset-y-0 left-0 bg-[rgb(var(--amber))] transition-all duration-500" style={{ width: `${acts.length ? (done / acts.length) * 100 : 0}%` }} />
      </div>
      <div className="flex flex-col">
        {acts.map((t) => (
          <div key={t.id} className="flex items-center gap-2.5 py-[4px] group">
            <button
              onClick={() => can.edit(t) && setStatus(t.id, t.status === 'done' ? 'todo' : 'done')}
              disabled={!can.edit(t)}
              className={`w-[14px] h-[14px] border flex-none flex items-center justify-center text-[9px] transition-all disabled:cursor-default ${
                t.status === 'done' ? 'border-white/25 text-white/60' : 'border-[rgb(var(--amber)/0.55)] hover:border-[rgb(var(--amber))]'
              }`}
              title={!can.edit(t) ? 'Tu ne peux pas modifier cette action' : t.status === 'done' ? 'Rouvrir' : 'Marquer comme fait'}
            >
              {t.status === 'done' ? '✓' : ''}
            </button>
            <button onClick={() => openEntity(t.id)} className={`text-[13px] text-left truncate flex-1 hover:text-white ${t.status === 'done' ? 'line-through text-white/35' : 'text-white/80'}`}>
              {displayTitle(t)}
            </button>
            {t.status === 'doing' && <span className="mono text-[9px] text-[rgb(var(--amber))] tracking-[0.12em]">EN COURS</span>}
          </div>
        ))}
      </div>
      {can.write() && (
        <input
          className="field mt-2 !text-[12.5px]"
          placeholder="+ Nouvelle action reliée (Entrée) — ex : Appeler l'imprimeur demain 10h"
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' && text.trim()) {
              const p = parseCapture(text, useData.getState().entities);
              commitCapture(p, { context: [e.id], defaults: { kind: 'tâche' } });
              setText('');
            }
          }}
        />
      )}
    </Section>
  );
}
