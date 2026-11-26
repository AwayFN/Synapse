import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { displayTitle, useData } from '../store/data';
import { useUI } from '../store/ui';
import { fx } from '../store/fx';
import { parseCommand, type Parsed } from '../lib/parse';
import { matchScore, normalizeTag } from '../lib/text';
import { fmtDay, fmtTime, minutesNow, todayISO } from '../lib/time';
import { TYPE_ACCENT } from '../lib/color';
import { exportData, importData } from '../lib/io';
import { newNote } from '../lib/actions';
import { bodyOf, tagsOf, TYPE_LABEL, type Entity, type EntityType } from '../types';
import { Corners, cvar, Kbd } from './common';
import { TYPE_TAG } from './Labels';
import { tagColor } from './TagBar';

type Row =
  | { kind: 'create'; type: EntityType }
  | { kind: 'prefix'; type: EntityType; word: string; example: string }
  | { kind: 'cmd'; id: string; label: string; hint?: string; run: () => void; keep?: boolean }
  | { kind: 'entity'; e: Entity };

const PREFIXES: { type: EntityType; word: string; example: string }[] = [
  { type: 'note', word: 'note', example: 'note Idée startup #idee #business' },
  { type: 'task', word: 'tâche', example: 'tâche Finir la maquette @Projet_App demain 14h' },
  { type: 'project', word: 'projet', example: 'projet Site vitrine deadline 30/12' },
  { type: 'slot', word: 'créneau', example: 'créneau 12h01-17h38 Deep work @Projet_App' },
];

function createFromParsed(p: Parsed): Entity | null {
  if (!p.type) return null;
  const d = useData.getState();
  const refs = p.refs.filter((r) => r.entity).map((r) => r.entity!) as Entity[];
  const today = todayISO();
  // @Projet : le projet parent d'une tâche, d'une note ou d'un créneau ; les autres @ deviennent des liens
  const proj = p.type !== 'project' ? refs.find((r) => r.type === 'project') : undefined;
  const others = refs.filter((r) => r !== proj).map((r) => r.id);
  switch (p.type) {
    case 'note':
      return d.createNote({ title: p.title, tags: p.tags, projectId: proj?.id ?? null }, { linkTo: others });
    case 'task': {
      const time = p.time ?? p.start;
      return d.createTask({ title: p.title, projectId: proj?.id ?? null, date: p.date ?? (time != null ? today : null), time, tags: p.tags }, { linkTo: others });
    }
    case 'project':
      return d.createProject({ title: p.title, deadline: p.date, tags: p.tags }, { linkTo: refs.map((r) => r.id) });
    case 'slot': {
      const start = p.start ?? p.time ?? Math.min(1380, Math.ceil(minutesNow() / 15) * 15);
      const end = p.end ?? (start + 60) % 1440;
      return d.createSlot({ title: p.title, date: p.date ?? today, start, end, projectId: proj?.id ?? null, tags: p.tags }, { linkTo: others });
    }
  }
}

function Preview({ p }: { p: Parsed }) {
  const items: ReactNode[] = [];
  const proj = p.type && p.type !== 'project' ? p.refs.find((r) => r.entity?.type === 'project')?.entity : undefined;
  if (proj) items.push(<span key="proj" className="chip !text-[10px]" style={cvar(proj.color)}>↳ {displayTitle(proj)}</span>);
  if (p.type === 'slot') {
    const start = p.start ?? p.time;
    items.push(
      <span key="time" className="chip !text-[10px]" style={cvar('#ffb020')}>
        {fmtDay(p.date ?? todayISO())} · {start != null ? fmtTime(start) : 'maintenant'} → {p.end != null ? fmtTime(p.end) : start != null ? fmtTime((start + 60) % 1440) : '+1h'}
      </span>,
    );
  } else if (p.date || p.time != null) {
    items.push(
      <span key="date" className="chip !text-[10px]" style={cvar('#ffb020')}>
        {p.type === 'project' ? 'deadline ' : ''}
        {p.date ? fmtDay(p.date) : "AUJOURD'HUI"}
        {p.time != null ? ` · ${fmtTime(p.time)}` : ''}
      </span>,
    );
  }
  for (const t of p.tags) items.push(<span key={`t${t}`} className="chip !text-[10px]" style={cvar(tagColor(t))}>#{t}</span>);
  for (const r of p.refs) {
    if (r.entity && r.entity === proj) continue;
    items.push(
      r.entity ? (
        <span key={`r${r.raw}`} className="chip !text-[10px]" style={cvar(r.entity.color)}>⟷ {displayTitle(r.entity)}</span>
      ) : (
        <span key={`r${r.raw}`} className="chip !text-[10px]" style={cvar('#ff4d6d')}>@{r.raw} ?</span>
      ),
    );
  }
  return <div className="flex flex-wrap gap-1.5 mt-1.5">{items}</div>;
}

function Palette() {
  const seed = useUI((s) => s.paletteSeed);
  const close = useUI((s) => s.closePalette);
  const entities = useData((s) => s.entities);
  const activeTags = useUI((s) => s.activeTags);
  const [q, setQ] = useState(seed);
  const [active, setActive] = useState(0);
  const [armedClear, setArmedClear] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const parsed = useMemo(() => parseCommand(q, entities), [q, entities]);
  const seedCount = useMemo(() => Object.values(entities).filter((e) => e.seed).length, [entities]);

  const rows: Row[] = useMemo(() => {
    const ui = useUI.getState();
    const cmds: Row[] = [
      { kind: 'cmd', id: 'agenda', label: 'Vue agenda · emploi du temps', hint: 'TAB', run: () => ui.setView('agenda') },
      { kind: 'cmd', id: 'tasks', label: 'Vue tâches · kanban', hint: '⇧TAB', run: () => ui.setView('tasks') },
      { kind: 'cmd', id: 'notes', label: 'Vue notes · toutes les notes, indépendantes ou par projet', run: () => ui.setView('notes') },
      { kind: 'cmd', id: 'network', label: 'Vue réseau', hint: 'ÉCHAP', run: () => ui.setView('network') },
      { kind: 'cmd', id: 'overview', label: "Vue d'ensemble · recentrer la caméra", hint: 'H', run: () => { ui.setView('network'); fx.emit({ kind: 'overview' }); } },
      { kind: 'cmd', id: 'home', label: 'Revenir aux neurones · tout de suite', hint: '◎', run: () => { ui.setView('network'); fx.emit({ kind: 'home' }); } },
      { kind: 'cmd', id: 'newnote', label: 'Nouvelle note vide', hint: 'CTRL N', run: () => newNote() },
      { kind: 'cmd', id: 'export', label: 'Exporter mes données (JSON)', run: exportData },
      { kind: 'cmd', id: 'import', label: 'Importer des données (JSON)', run: importData },
      { kind: 'cmd', id: 'help', label: 'Aide · raccourcis & syntaxe', hint: '?', run: () => ui.setHelp(true) },
    ];
    if (activeTags.length) cmds.push({ kind: 'cmd', id: 'cleartags', label: 'Effacer le filtre de tags', run: () => ui.clearTags() });
    if (seedCount) {
      cmds.push({
        kind: 'cmd',
        id: 'clearseed',
        label: armedClear ? `Confirmer : supprimer les ${seedCount} exemples ?` : `Supprimer les données d'exemple (${seedCount})`,
        keep: !armedClear,
        run: () => {
          if (!armedClear) {
            setArmedClear(true);
            return;
          }
          const n = useData.getState().clearSeed();
          ui.toast({ text: `${n} EXEMPLES SUPPRIMÉS · RÉSEAU VIERGE`, color: '#ff4d6d' });
          setTimeout(() => fx.emit({ kind: 'overview' }), 300);
        },
      });
    }

    const out: Row[] = [];
    const query = q.trim();
    if (parsed.type) out.push({ kind: 'create', type: parsed.type });
    if (!query) {
      for (const p of PREFIXES) out.push({ kind: 'prefix', ...p });
    }
    // entity search (skip when clearly writing a create command)
    const searchQ = parsed.type ? '' : query.replace(/^>/, '');
    if (searchQ) {
      // « #tag » : tout ce qui porte ce tag (projets, tâches, notes, créneaux)
      const tagQ = /^#\S+$/.test(searchQ) ? normalizeTag(searchQ) : '';
      const found = Object.values(entities)
        .map((e) => ({
          e,
          s: tagQ
            ? tagsOf(e).some((t) => t.startsWith(tagQ))
              ? 90
              : 0
            : Math.max(matchScore(searchQ, displayTitle(e)), matchScore(searchQ, bodyOf(e)) * 0.5, matchScore(searchQ, tagsOf(e).join(' ')) * 0.7),
        }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || b.e.updatedAt - a.e.updatedAt)
        .slice(0, 7);
      for (const f of found) out.push({ kind: 'entity', e: f.e });
      for (const c of cmds) if (c.kind === 'cmd' && matchScore(searchQ, c.label) > 0) out.push(c);
      if (!found.length && !out.length) {
        for (const p of PREFIXES) out.push({ kind: 'prefix', ...p, example: `${p.word} ${searchQ}` });
      }
    } else if (!parsed.type) {
      const recent = Object.values(entities)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 4);
      for (const e of recent) out.push({ kind: 'entity', e });
      out.push(...cmds);
    }
    return out;
  }, [q, parsed, entities, activeTags, seedCount, armedClear]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (row: Row | undefined, open: boolean) => {
    if (!row) return;
    const ui = useUI.getState();
    if (row.kind === 'create') {
      const e = createFromParsed(parsed);
      if (!e) return;
      ui.toast({ text: `${TYPE_LABEL[e.type].toUpperCase()} CRÉÉ${e.type === 'task' || e.type === 'note' ? 'E' : ''} · ${displayTitle(e)}`, color: e.color, action: open ? undefined : { label: 'OUVRIR', run: () => useUI.getState().openEntity(e.id) } });
      close();
      if (open) ui.openEntity(e.id);
      return;
    }
    if (row.kind === 'prefix') {
      setQ(row.example.startsWith(row.word + ' ') && q.trim() ? row.example : `${row.word} `);
      inputRef.current?.focus();
      return;
    }
    if (row.kind === 'entity') {
      close();
      ui.openEntity(row.e.id);
      return;
    }
    row.run();
    if (!row.keep) close();
  };

  const accent = parsed.type ? TYPE_ACCENT[parsed.type] : '#00e5ff';

  return (
    <div className="fixed inset-0 z-50" data-ui>
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[3px] anim-fade" onClick={close} />
      <div className="absolute left-1/2 -translate-x-1/2 top-[14vh] w-[min(680px,calc(100vw-32px))] glass neon anim-pop" style={cvar(accent)}>
        <Corners />
        <div className="flex items-center gap-3 px-4 border-b border-white/[0.07]">
          <span className="mono text-[rgb(var(--c))] text-lg leading-none" style={{ textShadow: '0 0 10px rgb(var(--c))' }}>
            {parsed.type ? '+' : '⌕'}
          </span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(rows.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                run(rows[active], e.ctrlKey || e.metaKey || e.shiftKey);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
              } else if (e.key === 'Tab' && rows[active]?.kind === 'prefix') {
                e.preventDefault();
                run(rows[active], false);
              }
            }}
            placeholder="note, tâche, projet, créneau… ou chercher"
            spellCheck={false}
            className="flex-1 bg-transparent outline-none py-4 text-[16px] text-white placeholder:text-white/30"
          />
          <Kbd>Échap</Kbd>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto scroll-thin py-1.5">
          {rows.map((row, i) => {
            const on = i === active;
            const base = `w-full text-left px-4 flex items-center gap-3 transition-colors ${on ? 'bg-white/[0.06]' : ''}`;
            if (row.kind === 'create') {
              const c = TYPE_ACCENT[row.type];
              return (
                <button key="create" data-i={i} onMouseEnter={() => setActive(i)} onClick={() => run(row, false)} className={`${base} py-3`} style={cvar(c)}>
                  <span className="w-8 h-8 flex-none flex items-center justify-center border border-[rgb(var(--c)/0.6)] bg-[rgb(var(--c)/0.12)] text-[rgb(var(--c))] mono shadow-[0_0_14px_rgb(var(--c)/0.3)]">+</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] text-white">
                      <span className="hud text-[10.5px] text-[rgb(var(--c))] mr-2">Créer {TYPE_LABEL[row.type]}</span>
                      {parsed.title ? `« ${parsed.title} »` : <span className="text-white/35">sans titre</span>}
                    </div>
                    <Preview p={parsed} />
                  </div>
                  <div className="flex flex-col items-end gap-1 mono text-[9px] text-white/35">
                    <span>ENTRÉE créer</span>
                    <span>CTRL+ENTRÉE ouvrir</span>
                  </div>
                </button>
              );
            }
            if (row.kind === 'prefix') {
              return (
                <button key={`p-${row.type}`} data-i={i} onMouseEnter={() => setActive(i)} onClick={() => run(row, false)} className={`${base} py-2`} style={cvar(TYPE_ACCENT[row.type])}>
                  <span className="dot" />
                  <span className="hud text-[10.5px] text-[rgb(var(--c))] w-[70px]">{row.word}</span>
                  <span className="mono text-[11.5px] text-white/45 truncate">{row.example}</span>
                  {on && <span className="ml-auto mono text-[9px] text-white/35">TAB</span>}
                </button>
              );
            }
            if (row.kind === 'entity') {
              const e = row.e;
              return (
                <button key={e.id} data-i={i} onMouseEnter={() => setActive(i)} onClick={() => run(row, true)} className={`${base} py-2`} style={cvar(e.color)}>
                  <span className="dot" />
                  <span className="mono text-[8.5px] tracking-[0.14em] text-[rgb(var(--c))] w-9">{TYPE_TAG[e.type]}</span>
                  <span className="text-[13.5px] text-white/85 truncate">{displayTitle(e)}</span>
                  {on && <span className="ml-auto mono text-[9px] text-white/35 flex-none">ENTRÉE ◎ voler vers</span>}
                </button>
              );
            }
            return (
              <button key={row.id} data-i={i} onMouseEnter={() => setActive(i)} onClick={() => run(row, false)} className={`${base} py-2`}>
                <span className="mono text-white/40 w-[7px] text-center">›</span>
                <span className={`text-[13px] ${row.id === 'clearseed' && armedClear ? 'text-[#ff4d6d]' : 'text-white/75'}`}>{row.label}</span>
                {row.hint && <span className="ml-auto mono text-[9px] text-white/30">{row.hint}</span>}
              </button>
            );
          })}
        </div>
        <div className="px-4 py-2 border-t border-white/[0.06] hud text-[9px] text-white/30 flex flex-wrap gap-x-4 gap-y-1">
          <span>@nom = lier / projet parent</span>
          <span>#tag</span>
          <span>12h01-17h38</span>
          <span>demain · lundi · 24/12</span>
        </div>
      </div>
    </div>
  );
}

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen);
  return open ? <Palette /> : null;
}
