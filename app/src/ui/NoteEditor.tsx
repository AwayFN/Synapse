import { useEffect, useRef, useState } from 'react';
import { useData } from '../store/data';
import { neighborsOf } from '../store/graph';
import { useUI } from '../store/ui';
import { shortCode } from '../lib/random';
import { wordCount } from '../lib/text';
import { fmtDay, fmtStamp, fmtTime } from '../lib/time';
import { LEVEL } from '../lib/back';
import { bodyKey, bodyOf, hasProject, tagsOf, TYPE_LABEL, type Entity, type EntityType } from '../types';
import { Corners, cvar, Kbd } from './common';
import { DeleteButton } from './DetailPanel';
import { EntityChip } from './EntityChip';
import { LinkPicker } from './LinkPicker';
import { ProjectSelect, TagEditor, TASK_STATUS_OPTIONS } from './fields';
import { useEditLock } from '../sync/lock';

/**
 * L'éditeur en grand, presque tout l'écran (comme le Bloc-notes) : pour une note (son contenu), et aussi pour la
 * description d'une tâche, d'un projet ou d'un créneau, au lieu d'une petite zone où l'on écrit à l'étroit.
 * La taille du texte se règle (A− / A+) et reste choisie sur cet appareil.
 */
const SIZES = [12, 13, 14, 15, 16, 17, 18, 20, 22];
const SIZE_KEY = 'synapse-taille-texte';
const DEFAULT_SIZE = 15;

function readSize(): number {
  try {
    const n = Number(localStorage.getItem(SIZE_KEY));
    return SIZES.includes(n) ? n : DEFAULT_SIZE;
  } catch {
    return DEFAULT_SIZE;
  }
}

function useTextSize(): [number, (dir: -1 | 1) => void] {
  const [size, setSize] = useState(readSize);
  const step = (dir: -1 | 1) => {
    setSize((cur) => {
      const i = Math.max(0, Math.min(SIZES.length - 1, SIZES.indexOf(cur) + dir));
      const next = SIZES[i];
      try {
        localStorage.setItem(SIZE_KEY, String(next));
      } catch {
        /* pas grave */
      }
      return next;
    });
  };
  return [size, step];
}

const TITLE_HINT: Record<EntityType, string> = { note: 'Titre de la note', task: 'Titre de la tâche', project: 'Nom du projet', slot: 'Titre du créneau' };
const BODY_HINT: Record<EntityType, string> = {
  note: 'Commence à écrire…',
  task: 'Décris la tâche : étapes, détails, liens utiles…',
  project: 'Décris le projet : objectifs, idées, contexte, décisions…',
  slot: 'Ce que tu fais pendant ce créneau, ce que tu en retiens…',
};
const INDEPENDENT: Record<'note' | 'task' | 'slot', string> = { note: '— Note indépendante —', task: '— Tâche indépendante —', slot: 'Sans projet' };

/** Liens de l'élément, en une ligne : chaque puce ouvre l'élément lié ; « + Lier à… » relie à n'importe quoi */
function EditorLinks({ id, readOnly }: { id: string; readOnly: boolean }) {
  const entities = useData((s) => s.entities);
  const links = useData((s) => s.links);
  const unlink = useData((s) => s.unlink);
  const [picking, setPicking] = useState(false);
  const self = entities[id];
  // le projet parent a déjà son propre réglage (« Projet ») : il n'est pas répété ici
  const neighbors = neighborsOf(entities, links, id).filter((n) => !(n.kind === 'parent' && n.isParent) && !(self?.type === 'project' && n.kind === 'parent'));
  return (
    <div className="relative flex items-center gap-1.5 flex-wrap min-w-0">
      <span className="xs-label mr-1">Liens</span>
      {neighbors.length === 0 && <span className="text-[12px] text-white/30 mr-1">aucun</span>}
      {neighbors.map((n) => (
        <EntityChip key={n.entity.id} id={n.entity.id} compact onRemove={readOnly ? undefined : () => unlink(id, n.entity.id)} />
      ))}
      {!readOnly && (
        <button className="btn !py-1 !px-2 !text-[9.5px]" onClick={() => setPicking((p) => !p)}>
          + Lier à…
        </button>
      )}
      {picking && (
        <div className="absolute left-0 top-full z-40 w-[440px] max-w-[calc(100vw-48px)]">
          <LinkPicker sourceId={id} onClose={() => setPicking(false)} level={LEVEL.inEditor} />
        </div>
      )}
    </div>
  );
}

/** Le statut, en petit, pour une tâche ou un projet (le reste se règle dans sa fiche) */
function StatusMini({ e }: { e: Entity }) {
  const update = useData((s) => s.update);
  const options =
    e.type === 'task'
      ? TASK_STATUS_OPTIONS
      : e.type === 'project'
        ? [
            { v: 'active', label: 'En cours', c: '#00e5ff' },
            { v: 'done', label: 'Terminé', c: '#39ff88' },
          ]
        : null;
  if (!options) return null;
  const value = (e as { status: string }).status;
  return (
    <div className="flex items-center gap-2">
      <span className="xs-label">Statut</span>
      <div className="seg">
        {options.map((o) => (
          <button key={o.v} data-on={value === o.v ? '1' : '0'} style={cvar(o.c)} onClick={() => update(e.id, { status: o.v } as Partial<Entity>)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Editor({ e }: { e: Entity }) {
  const update = useData((s) => s.update);
  const closeEditor = useUI((s) => s.closeEditor);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState({ line: 1, col: 1 });
  const [size, stepSize] = useTextSize();
  // partage : une seule personne écrit à la fois dans un élément
  const lock = useEditLock(e.id);
  const readOnly = !lock.canWrite;
  const key = bodyKey(e);
  const body = bodyOf(e);
  const tags = tagsOf(e);

  /** Ligne et colonne du curseur (barre d'état, comme le Bloc-notes) */
  const track = () => {
    const el = bodyRef.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const line = before.split('\n').length;
    setCaret({ line, col: before.length - before.lastIndexOf('\n') });
  };

  // focus : élément vide → titre, sinon fin du texte
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (readOnly) return;
      if (!e.title && !body) titleRef.current?.focus();
      else {
        const b = bodyRef.current;
        if (b) {
          b.focus();
          b.setSelectionRange(b.value.length, b.value.length);
          track();
        }
      }
    }, 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e.id]);

  const words = wordCount(body);
  const chars = body.length;
  return (
    <div className="fixed inset-0 z-30 anim-fade" style={cvar(e.color)}>
      <div className="backdrop bg-black/80" onClick={closeEditor} />
      <div className="absolute inset-2.5 max-md:inset-0 glass neon bg-[rgb(8_8_14/0.97)] flex flex-col anim-rise" data-ui data-note-editor data-editor-type={e.type}>
        <Corners />
        {/* barre du haut : retour, titre, suppression */}
        <div className="flex items-center gap-3 max-md:gap-2 px-3.5 max-md:px-2 h-[52px] border-b border-white/[0.07] flex-none">
          <button className="btn" onClick={closeEditor}>
            ← Retour <span className="text-white/35 ml-1 max-md:hidden">Échap</span>
          </button>
          <span className="hud text-[9.5px] text-[rgb(var(--c))] flex items-center gap-2 flex-none max-md:hidden">
            <span className="dot" /> {TYPE_LABEL[e.type]} · {shortCode(e.id)}
          </span>
          <input
            ref={titleRef}
            value={e.title}
            readOnly={readOnly}
            onChange={(ev) => {
              lock.claim();
              update(e.id, { title: ev.target.value });
            }}
            onFocus={lock.claim}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === 'ArrowDown') {
                ev.preventDefault();
                bodyRef.current?.focus();
              }
            }}
            placeholder={TITLE_HINT[e.type]}
            className="flex-1 min-w-0 bg-transparent outline-none text-[18px] max-md:text-[16px] font-semibold tracking-tight text-white placeholder:text-white/25 px-2"
            style={{ textShadow: '0 0 30px rgb(var(--c) / 0.35)' }}
          />
          {lock.holder && (
            <span className="hud text-[9.5px] px-2.5 py-1 border border-[#ffb020]/60 text-[#ffb020] flex-none" data-note-locked>
              ✎ {lock.holder} écrit · lecture seule
            </span>
          )}
          {lock.viewOnly && !lock.holder && <span className="hud text-[9.5px] px-2.5 py-1 border border-white/20 text-white/55 flex-none">Lecture seule</span>}
          {!readOnly && (
            <span className="max-md:hidden">
              <DeleteButton id={e.id} label="Supprimer" />
            </span>
          )}
        </div>

        {/* tags, projet, statut, liens */}
        <fieldset disabled={readOnly} className="m-0 border-0 min-w-0 flex items-center gap-x-6 gap-y-2 flex-wrap px-4 max-md:px-3 py-2.5 border-b border-white/[0.05] flex-none" onFocus={lock.claim}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="xs-label">Tags</span>
            {readOnly ? <span className="mono text-[11px] text-white/55">{tags.length ? tags.map((t) => `#${t}`).join('  ') : '—'}</span> : <TagEditor id={e.id} tags={tags} />}
          </div>
          {hasProject(e) && (
            <div className="flex items-center gap-2 min-w-0">
              <span className="xs-label">Projet</span>
              <div className="w-[220px] max-w-[60vw]">
                <ProjectSelect value={e.projectId ?? null} onChange={(id) => update(e.id, { projectId: id })} empty={INDEPENDENT[e.type]} />
              </div>
            </div>
          )}
          <StatusMini e={e} />
          {e.type === 'slot' && (
            <span className="mono text-[10.5px] text-white/50">
              {fmtDay(e.date)} · {fmtTime(e.start)} → {fmtTime(e.end)}
            </span>
          )}
          {e.type === 'task' && e.date && (
            <span className="mono text-[10.5px] text-white/50">
              {fmtDay(e.date)}
              {e.time != null ? ` · ${fmtTime(e.time)}` : ''}
            </span>
          )}
          <EditorLinks id={e.id} readOnly={readOnly} />
        </fieldset>

        {/* le texte, sur tout l'écran */}
        <textarea
          ref={bodyRef}
          value={body}
          readOnly={readOnly}
          onChange={(ev) => {
            lock.claim();
            update(e.id, { [key]: ev.target.value } as Partial<Entity>);
            track();
          }}
          onFocus={lock.claim}
          onSelect={track}
          onKeyUp={track}
          onClick={track}
          onKeyDown={(ev) => {
            if (ev.key === 'Tab' && !readOnly && !ev.ctrlKey && !ev.altKey) {
              ev.preventDefault();
              const el = ev.currentTarget;
              const { selectionStart: a, selectionEnd: b } = el;
              const v = el.value;
              update(e.id, { [key]: v.slice(0, a) + '  ' + v.slice(b) } as Partial<Entity>);
              requestAnimationFrame(() => {
                el.setSelectionRange(a + 2, a + 2);
                track();
              });
            }
          }}
          placeholder={readOnly ? '' : BODY_HINT[e.type]}
          spellCheck
          data-editor-body
          className="flex-1 min-h-0 w-full resize-none bg-transparent outline-none px-5 py-4 max-md:px-3.5 max-md:py-3 text-[rgb(233_233_241/0.92)] placeholder:text-white/20 font-sans scroll-thin"
          style={{ fontSize: size, lineHeight: 1.55 }}
        />

        {/* barre d'état */}
        <div className="flex items-center gap-5 max-md:gap-3 px-4 max-md:px-3 h-8 border-t border-white/[0.07] mono text-[10.5px] tracking-[0.06em] text-white/45 flex-none overflow-hidden whitespace-nowrap">
          <span className="max-md:hidden">
            Ln {caret.line}, Col {caret.col}
          </span>
          <span>
            {chars.toLocaleString('fr-FR')} caractère{chars > 1 ? 's' : ''}
          </span>
          <span className="max-md:hidden">
            {words.toLocaleString('fr-FR')} mot{words > 1 ? 's' : ''} · {Math.max(1, Math.round(words / 220))} min de lecture
          </span>
          <span className="flex items-center gap-1" title="Taille du texte (gardée sur cet appareil)">
            <button className="px-1.5 hover:text-white disabled:opacity-30" disabled={size <= SIZES[0]} onClick={() => stepSize(-1)} aria-label="Texte plus petit" data-size-down>
              A−
            </button>
            <span className="tabular-nums text-white/60" data-text-size>
              {size}
            </span>
            <button className="px-1.5 hover:text-white disabled:opacity-30" disabled={size >= SIZES[SIZES.length - 1]} onClick={() => stepSize(1)} aria-label="Texte plus grand">
              A+
            </button>
          </span>
          <span className="ml-auto flex items-center gap-2">
            <span key={e.updatedAt} className="w-1.5 h-1.5 bg-[#39ff88] shadow-[0_0_8px_#39ff88] anim-fade" />
            <span className="max-md:hidden">sauvegarde auto · </span>
            {fmtStamp(e.updatedAt)}
          </span>
          <span className="max-lg:hidden">
            <Kbd>Ctrl K</Kbd> créer · <Kbd>Échap</Kbd> retour
          </span>
        </div>
      </div>
    </div>
  );
}

/** Un élément s'ouvre en grand, presque tout l'écran (comme le Bloc-notes) ; le reste reste flou derrière */
export function NoteEditor() {
  const id = useUI((s) => s.editorId);
  const e = useData((s) => (id ? s.entities[id] : undefined));
  if (!id || !e) return null;
  return <Editor key={id} e={e} />;
}
