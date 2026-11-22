import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { displayTitle, useData } from '../store/data';
import { useUI } from '../store/ui';
import { fx } from '../store/fx';
import { hasStructure, parseCapture, whenOf, type Parsed } from '../lib/parse';
import { commitCapture } from '../lib/capture';
import { searchEntities } from '../lib/search';
import { matchScore, norm } from '../lib/text';
import { fmtDay, fmtWhen } from '../lib/time';
import { ALERT_HEX, kindLabel, natureOf, natureOfKind, NATURES, PEARL_HEX } from '../lib/kinds';
import { kindTag, metaLine } from '../lib/entity';
import { exportData, importData } from '../lib/io';
import { newThought } from '../lib/actions';
import { can } from '../sync/perm';
import { useSession } from '../sync/session';
import { PULSE_LABEL, pulseLevel, setPulseLevel, type PulseLevel } from '../scene/pulses';
import type { Entity } from '../types';
import { Corners, cvar, EntityGlyph, Glyph, Kbd, natureVar } from './common';

/**
 * Le point d'entrée unique de Synapse.
 *   texte brut + Entrée      → capturé tel quel, comme une pensée (aucun classement obligatoire)
 *   syntaxe facultative       → genre, moment, échéance, liens, tags (aperçu en direct)
 *   « / mots »                → recherche (les résultats s'éclairent dans le réseau)
 *   « > »                     → commandes
 */
type Row =
  | { kind: 'capture' }
  | { kind: 'entity'; e: Entity; snippet: string | null }
  | { kind: 'cmd'; id: string; label: string; hint?: string; run: () => void; keep?: boolean }
  | { kind: 'example'; text: string; note: string };

const EXAMPLES: { text: string; note: string }[] = [
  { text: 'Les meilleures idées arrivent quand je marche', note: 'une pensée brute, sans rien préciser' },
  { text: 'tâche Appeler Léa @Voyage demain 14h', note: 'une action datée, reliée à un projet' },
  { text: 'idée: une app qui range mes photos toute seule #business', note: 'un genre et un tag' },
  { text: 'rdv Dentiste jeudi 7h02', note: 'un moment à la minute près' },
  { text: 'Rendre le dossier avant vendredi !', note: 'une échéance, marquée importante' },
  { text: 'recette: tarte aux pommes de mamie', note: "n'importe quel genre inventé" },
];

function Preview({ p, context, dupe }: { p: Parsed; context: Entity | null; dupe: Entity | null }) {
  const kinds = useData((s) => s.kinds);
  const items: ReactNode[] = [];
  const nature = natureOfKind(p.kind, kinds);
  items.push(
    <span key="k" className="chip !text-[10px]" style={natureVar(nature)}>
      {kindLabel(p.kind)}
      <span className="opacity-50">· {NATURES[nature].label.toLowerCase()}</span>
    </span>,
  );
  if (p.status) items.push(<span key="s" className="chip !text-[10px]" style={natureVar('action')}>◆ {p.status === 'done' ? 'fait' : 'à accomplir'}</span>);
  const w = whenOf(p);
  if (w) items.push(<span key="w" className="chip !text-[10px]" style={natureVar('temps')}>○ {fmtWhen(w)}</span>);
  if (p.due) items.push(<span key="d" className="chip !text-[10px]" style={cvar(ALERT_HEX)}>⟶ avant {fmtDay(p.due)}</span>);
  if (p.pinned) items.push(<span key="pin" className="chip !text-[10px]">★ important</span>);
  if (p.private && can.private()) items.push(<span key="priv" className="chip !text-[10px]">🔒 privé</span>);
  for (const t of p.tags) items.push(<span key={`t${t}`} className="chip !text-[10px]">#{t}</span>);
  if (context) items.push(<span key="ctx" className="chip !text-[10px]" style={natureVar(natureOf(context, kinds))}>⟷ {displayTitle(context)}</span>);
  for (const r of p.refs) {
    if (r.entity && r.entity.id === context?.id) continue;
    items.push(
      r.entity ? (
        <span key={`r${r.raw}`} className="chip !text-[10px]" style={natureVar(natureOf(r.entity, kinds))}>⟷ {displayTitle(r.entity)}</span>
      ) : (
        <span key={`r${r.raw}`} className="chip !text-[10px]" title="N'existe pas encore : sera créé et relié">＋ {r.raw}</span>
      ),
    );
  }
  if (p.url) items.push(<span key="u" className="chip !text-[10px]" style={natureVar('monde')}>↗ lien web</span>);
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
      {items}
      {dupe && <span className="mono text-[9px] tracking-[0.1em] text-white/40 ml-1">≈ « {displayTitle(dupe)} » existe déjà · ↓ pour l'ouvrir</span>}
    </div>
  );
}

function Palette() {
  const seed = useUI((s) => s.paletteSeed);
  const close = useUI((s) => s.closePalette);
  const entities = useData((s) => s.entities);
  const kinds = useData((s) => s.kinds);
  const activeTags = useUI((s) => s.activeTags);
  const orphansOnly = useUI((s) => s.orphansOnly);
  const [q, setQ] = useState(seed);
  const [active, setActive] = useState(0);
  const [armedClear, setArmedClear] = useState(false);
  const [context, setContext] = useState<string | null>(() => {
    const ui = useUI.getState();
    const id = ui.selectedId ?? ui.editorId;
    return id && useData.getState().entities[id] ? id : null;
  });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // en lecture seule, le champ ne sert qu'à chercher (et aux commandes)
  const canWrite = can.write();
  const mode: 'capture' | 'search' | 'command' = q.startsWith('>') ? 'command' : q.startsWith('/') || !canWrite ? 'search' : 'capture';
  const text = mode === 'capture' ? q : q.replace(/^[/>]/, '').trim();
  const parsed = useMemo(() => (mode === 'capture' ? parseCapture(q, entities) : null), [q, entities, mode]);
  const searchText = mode === 'search' ? text : mode === 'capture' ? parsed?.title ?? '' : '';
  const hits = useMemo(() => searchEntities(entities, searchText, mode === 'search' ? 40 : 6), [entities, searchText, mode]);
  const contextEntity = context ? entities[context] ?? null : null;
  const seedCount = useMemo(() => Object.values(entities).filter((e) => e.seed).length, [entities]);
  const dupe = parsed && hits[0] && parsed.title && norm(displayTitle(hits[0].e)) === norm(parsed.title) ? hits[0].e : null;

  // la recherche éclaire ses résultats dans le réseau, derrière la palette
  useEffect(() => {
    const ui = useUI.getState();
    if (mode === 'search' && text) ui.setSearchHits(new Set(searchEntities(entities, text, 400).map((h) => h.e.id)));
    else if (ui.searchHits) ui.setSearchHits(null);
  }, [mode, text, entities]);

  const sess = useSession();
  const commands = useMemo<Row[]>(() => {
    const ui = useUI.getState();
    const cmds: Row[] = [
      { kind: 'cmd', id: 'network', label: 'Vue réseau', hint: 'ÉCHAP', run: () => ui.setView('network') },
      { kind: 'cmd', id: 'flux', label: 'Vue flux · tout ce que tu as capturé, dans l’ordre', hint: '2', run: () => ui.setView('flux') },
      { kind: 'cmd', id: 'agenda', label: 'Vue agenda · emploi du temps', hint: 'TAB', run: () => ui.setView('agenda') },
      { kind: 'cmd', id: 'tasks', label: 'Vue tâches · kanban', hint: '⇧TAB', run: () => ui.setView('tasks') },
      { kind: 'cmd', id: 'overview', label: "Vue d'ensemble · recentrer la caméra", hint: 'H', run: () => { ui.setView('network'); fx.emit({ kind: 'overview' }); } },
      ...(can.write() ? [{ kind: 'cmd' as const, id: 'long', label: 'Nouvelle pensée longue (éditeur plein écran)', hint: 'CTRL ENTRÉE', run: () => newThought() }] : []),
      {
        kind: 'cmd',
        id: 'orphans',
        label: orphansOnly ? 'Ne plus isoler les pensées sans lien' : 'Éclairer les pensées sans aucun lien (à relier)',
        run: () => { ui.setView('network'); ui.setOrphansOnly(!orphansOnly); },
      },
      { kind: 'cmd', id: 'back', label: 'Fil de pensée · revenir au neurone précédent', hint: 'ALT ←', run: () => ui.back() },
      ...(sess.mode !== 'local' && can.manage()
        ? [{ kind: 'cmd' as const, id: 'share', label: 'Partager mon cerveau · inviter quelqu’un', run: () => useSession.setState({ shareOpen: true }) }]
        : []),
      ...(sess.following ? [{ kind: 'cmd' as const, id: 'unfollow', label: 'Ne plus suivre', hint: 'ÉCHAP', run: () => useSession.setState({ following: null }) }] : []),
      ...(sess.mode !== 'local'
        ? [
            { kind: 'cmd' as const, id: 'account', label: 'Mon compte · mes cerveaux · inviter un ami sur Synapse', run: () => useSession.setState({ accountOpen: true }) },
            { kind: 'cmd' as const, id: 'feedback', label: 'Écrire à l’équipe de Synapse (idée, problème)', run: () => useSession.setState({ feedbackOpen: true }) },
          ]
        : []),
      ...(sess.account?.staff ? [{ kind: 'cmd' as const, id: 'admin', label: 'Espace créateur · comptes, statistiques, retours, réglages', run: () => useSession.setState({ adminOpen: true }) }] : []),
      // ambiance du réseau : impulsions vives (par défaut), calmes, ou arrêtées
      ...(['vif', 'calme', 'off'] as PulseLevel[])
        .filter((l) => l !== pulseLevel())
        .map((l) => ({
          kind: 'cmd' as const,
          id: `impulsions-${l}`,
          label: `Impulsions ${PULSE_LABEL[l]} · ${l === 'vif' ? 'néon vivant, les neurones s’échangent des impulsions' : l === 'calme' ? 'plus rares et plus douces' : 'plus aucune particule, seulement les connexions'}`,
          run: () => {
            setPulseLevel(l);
            useUI.getState().toast({ text: `IMPULSIONS ${PULSE_LABEL[l].toUpperCase()}`, color: PEARL_HEX });
          },
        })),
      ...(can.manage()
        ? [
            { kind: 'cmd' as const, id: 'export', label: 'Exporter mes données (JSON)', run: exportData },
            { kind: 'cmd' as const, id: 'import', label: 'Importer des données (JSON, V1 ou V2)', run: importData },
          ]
        : []),
      { kind: 'cmd', id: 'help', label: 'Aide · raccourcis, syntaxe et langage visuel', hint: '?', run: () => ui.setHelp(true) },
    ];
    if (activeTags.length) cmds.push({ kind: 'cmd', id: 'cleartags', label: 'Effacer le filtre de tags', run: () => ui.clearTags() });
    if (seedCount && can.manage()) {
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
          ui.toast({ text: `${n} EXEMPLES SUPPRIMÉS · À TOI DE JOUER`, color: ALERT_HEX });
          setTimeout(() => fx.emit({ kind: 'overview' }), 300);
        },
      });
    }
    return cmds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTags.length, orphansOnly, seedCount, armedClear, sess.mode, sess.role, sess.following]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    if (mode === 'command') {
      for (const c of commands) if (c.kind === 'cmd' && (!text || matchScore(text, c.label) > 0)) out.push(c);
      return out;
    }
    if (mode === 'search') {
      for (const h of hits) out.push({ kind: 'entity', e: h.e, snippet: h.snippet });
      return out;
    }
    if (q.trim()) {
      out.push({ kind: 'capture' });
      for (const h of hits) out.push({ kind: 'entity', e: h.e, snippet: h.snippet });
      const t = parsed?.title ?? '';
      if (t.length >= 3) for (const c of commands) if (c.kind === 'cmd' && matchScore(t, c.label) >= 60) out.push(c);
      return out;
    }
    const recent = Object.values(entities)
      .sort((a, b) => b.touchedAt - a.touchedAt)
      .slice(0, 5);
    for (const e of recent) out.push({ kind: 'entity', e, snippet: null });
    out.push(...commands);
    for (const ex of EXAMPLES) out.push({ kind: 'example', ...ex });
    return out;
  }, [mode, commands, text, hits, q, parsed, entities]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const capture = (how: 'close' | 'open' | 'chain') => {
    if (!parsed || !q.trim()) return;
    const ui = useUI.getState();
    const { entity, created } = commitCapture(parsed, { context: context ? [context] : [] });
    const nature = natureOfKind(entity.kind, useData.getState().kinds);
    ui.toast({
      text: `CAPTURÉ · ${kindLabel(entity.kind).toUpperCase()} · ${displayTitle(entity)}${created.length ? ` · +${created.length} relié${created.length > 1 ? 's' : ''}` : ''}`,
      color: NATURES[nature].hex,
      action: how === 'open' ? undefined : { label: 'OUVRIR', run: () => useUI.getState().openEntity(entity.id) },
    });
    if (how === 'chain') {
      setQ('');
      inputRef.current?.focus();
      return;
    }
    close();
    if (how === 'open') ui.openEditor(entity.id);
  };

  const run = (row: Row | undefined, mods: { ctrl: boolean; alt: boolean }) => {
    if (!row) return;
    const ui = useUI.getState();
    if (row.kind === 'capture') return capture(mods.ctrl ? 'open' : mods.alt ? 'chain' : 'close');
    if (row.kind === 'example') {
      setQ(row.text);
      inputRef.current?.focus();
      return;
    }
    if (row.kind === 'entity') {
      close();
      if (mods.ctrl) ui.openEditor(row.e.id);
      else ui.openEntity(row.e.id);
      return;
    }
    row.run();
    if (!row.keep) close();
  };

  const accent = mode === 'capture' && parsed ? NATURES[natureOfKind(parsed.kind, kinds)].hex : PEARL_HEX;
  const placeholder =
    mode === 'search' ? 'Chercher dans tout le réseau…' : mode === 'command' ? 'Commande…' : 'Capture une pensée, une tâche, un moment… ou cherche avec /';

  return (
    <div className="fixed inset-0 z-50" data-ui>
      <div
        className={`absolute inset-0 anim-fade ${mode === 'search' ? 'bg-black/15' : 'bg-black/40 backdrop-blur-[2px]'}`}
        onClick={close}
      />
      <div className="absolute left-1/2 -translate-x-1/2 top-[13vh] w-[min(700px,calc(100vw-32px))] glass neon anim-pop" style={cvar(accent)}>
        <Corners />
        {contextEntity && mode === 'capture' && can.link() && (
          <div className="flex items-center gap-2 px-4 pt-3 -mb-1">
            <span className="xs-label">Relier à</span>
            <span className="chip !text-[10px]" style={natureVar(natureOf(contextEntity, kinds))}>
              <EntityGlyph e={contextEntity} size={9} />
              {displayTitle(contextEntity)}
              <button className="opacity-40 hover:opacity-100" title="Ne pas relier (Retour arrière)" onClick={() => setContext(null)}>
                ×
              </button>
            </span>
          </div>
        )}
        <div className="flex items-start gap-3 px-4 border-b border-white/[0.06]">
          <span className="mono text-[rgb(var(--c))] text-lg leading-none pt-[17px] w-4 text-center">
            {mode === 'search' ? '⌕' : mode === 'command' ? '›' : '+'}
          </span>
          <textarea
            ref={inputRef}
            value={q}
            rows={Math.min(6, Math.max(1, q.split('\n').length))}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              const single = !q.includes('\n');
              if (e.key === 'ArrowDown' && single) {
                e.preventDefault();
                setActive((a) => Math.min(rows.length - 1, a + 1));
              } else if (e.key === 'ArrowUp' && single) {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                run(rows[active], { ctrl: e.ctrlKey || e.metaKey, alt: e.altKey });
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
              } else if (e.key === 'Backspace' && !q && context) {
                e.preventDefault();
                setContext(null);
              } else if (e.key === 'Tab' && rows[active]?.kind === 'example') {
                e.preventDefault();
                run(rows[active], { ctrl: false, alt: false });
              }
            }}
            placeholder={placeholder}
            spellCheck={false}
            className="flex-1 bg-transparent outline-none resize-none py-[14px] text-[16px] leading-[1.5] text-white placeholder:text-white/28 scroll-thin"
          />
          <span className="pt-[16px]">
            <Kbd>Échap</Kbd>
          </span>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto scroll-thin py-1.5">
          {mode === 'search' && text && rows.length === 0 && (
            <div className="px-4 py-4 text-[12.5px] text-white/40">Rien trouvé pour « {text} ». Essaie un autre mot, ou un #tag.</div>
          )}
          {rows.map((row, i) => {
            const on = i === active;
            const base = `w-full text-left px-4 flex items-center gap-3 transition-colors ${on ? 'bg-white/[0.05]' : ''}`;
            if (row.kind === 'capture' && parsed) {
              const nature = natureOfKind(parsed.kind, kinds);
              const shape = parsed.status ? 1 : whenOf(parsed) ? 2 : 0;
              return (
                <button key="capture" data-i={i} onMouseEnter={() => setActive(i)} onClick={() => run(row, { ctrl: false, alt: false })} className={`${base} py-3`} style={natureVar(nature)}>
                  <span className="w-8 h-8 flex-none flex items-center justify-center border border-[rgb(var(--c)/0.35)] bg-[rgb(var(--c)/0.06)]">
                    <Glyph nature={nature} shape={shape} hub={!!parsed.kindDef?.hub} size={15} hour={parsed.start} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] text-white truncate">
                      <span className="hud text-[10px] text-[rgb(var(--c))] mr-2">Capturer</span>
                      {parsed.title ? `« ${parsed.title} »` : parsed.body ? `« ${parsed.body.split('\n')[0]} »` : <span className="text-white/35">sans titre</span>}
                    </div>
                    {hasStructure(parsed) || contextEntity || dupe ? (
                      <Preview p={parsed} context={contextEntity} dupe={dupe} />
                    ) : (
                      <div className="mono text-[9.5px] tracking-[0.1em] text-white/35 mt-1">PENSÉE BRUTE · RIEN À PRÉCISER, TU POURRAS LA RELIER PLUS TARD</div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 mono text-[9px] text-white/35 flex-none">
                    <span>ENTRÉE capturer</span>
                    <span>CTRL+ENTRÉE développer</span>
                    <span>ALT+ENTRÉE enchaîner</span>
                  </div>
                </button>
              );
            }
            if (row.kind === 'entity') {
              const e = row.e;
              const meta = metaLine(e);
              return (
                <button key={e.id} data-i={i} onMouseEnter={() => setActive(i)} onClick={() => run(row, { ctrl: false, alt: false })} className={`${base} py-2`} style={natureVar(natureOf(e, kinds))}>
                  <EntityGlyph e={e} size={12} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <span className={`text-[13.5px] truncate ${e.status === 'done' ? 'text-white/45 line-through' : 'text-white/88'}`}>{displayTitle(e)}</span>
                      <span className="mono text-[8.5px] tracking-[0.13em] text-[rgb(var(--c)/0.8)] flex-none">{kindTag(e)}</span>
                      {meta && <span className="mono text-[8.5px] tracking-[0.1em] uppercase text-white/30 truncate">{meta}</span>}
                    </div>
                    {row.snippet && <div className="text-[11.5px] text-white/40 truncate mt-0.5">{row.snippet}</div>}
                  </div>
                  {on && <span className="mono text-[9px] text-white/35 flex-none">ENTRÉE ◎ y aller</span>}
                </button>
              );
            }
            if (row.kind === 'example') {
              return (
                <button key={`x${row.text}`} data-i={i} onMouseEnter={() => setActive(i)} onClick={() => run(row, { ctrl: false, alt: false })} className={`${base} py-1.5`}>
                  <span className="mono text-white/25 w-[12px] text-center">“</span>
                  <span className="mono text-[11.5px] text-white/55 truncate">{row.text}</span>
                  <span className="text-[11px] text-white/28 truncate ml-auto flex-none">{row.note}</span>
                  {on && <span className="mono text-[9px] text-white/35 flex-none">TAB</span>}
                </button>
              );
            }
            if (row.kind === 'cmd') {
              return (
                <button key={row.id} data-i={i} onMouseEnter={() => setActive(i)} onClick={() => run(row, { ctrl: false, alt: false })} className={`${base} py-2`}>
                  <span className="mono text-white/35 w-[12px] text-center">›</span>
                  <span className={`text-[13px] ${row.id === 'clearseed' && armedClear ? 'text-[rgb(var(--alert))]' : 'text-white/72'}`}>{row.label}</span>
                  {row.hint && <span className="ml-auto mono text-[9px] text-white/30">{row.hint}</span>}
                </button>
              );
            }
            return null;
          })}
          {mode === 'capture' && !q.trim() && <div className="px-4 pt-2 pb-1 xs-label !text-[8.5px]">↑ récents · commandes · exemples (Tab pour essayer)</div>}
        </div>
        <div className="px-4 py-2 border-t border-white/[0.05] hud text-[9px] text-white/30 flex flex-wrap gap-x-4 gap-y-1">
          <span>@nom relier</span>
          <span>#tag</span>
          <span>7h02 · 12h01-17h38</span>
          <span>demain · lundi · 24/12</span>
          <span>avant vendredi</span>
          <span>! important</span>
          <span>mot: genre</span>
          <span className="ml-auto">/ chercher · &gt; commandes</span>
        </div>
      </div>
    </div>
  );
}

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen);
  return open ? <Palette /> : null;
}
