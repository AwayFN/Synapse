import { useEffect, useRef, useState } from 'react';
import { useData } from '../store/data';
import { neighborsOf } from '../store/graph';
import { useUI } from '../store/ui';
import { shortCode } from '../lib/random';
import { wordCount } from '../lib/text';
import { fmtStamp } from '../lib/time';
import type { Note } from '../types';
import { Corners, cvar, Kbd } from './common';
import { DeleteButton } from './DetailPanel';
import { EntityChip } from './EntityChip';
import { LinkPicker } from './LinkPicker';
import { TagEditor } from './fields';
import { useEditLock } from '../sync/lock';

/** Liens de la note, en une ligne : chaque puce ouvre l'élément lié ; « + Lier à… » relie à n'importe quoi */
function NoteLinks({ id, readOnly }: { id: string; readOnly: boolean }) {
  const entities = useData((s) => s.entities);
  const links = useData((s) => s.links);
  const unlink = useData((s) => s.unlink);
  const [picking, setPicking] = useState(false);
  const neighbors = neighborsOf(entities, links, id);
  return (
    <div className="relative flex items-center gap-1.5 flex-wrap min-w-0">
      <span className="xs-label mr-1">Liée à</span>
      {neighbors.length === 0 && <span className="text-[12px] text-white/30 mr-1">rien pour l’instant</span>}
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
          <LinkPicker sourceId={id} onClose={() => setPicking(false)} />
        </div>
      )}
    </div>
  );
}

function Editor({ note }: { note: Note }) {
  const update = useData((s) => s.update);
  const closeEditor = useUI((s) => s.closeEditor);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState({ line: 1, col: 1 });
  // partage : une seule personne écrit à la fois dans une note
  const lock = useEditLock(note.id);
  const readOnly = !lock.canWrite;

  /** Ligne et colonne du curseur (barre d'état, comme le Bloc-notes) */
  const track = () => {
    const el = bodyRef.current;
    if (!el) return;
    const before = el.value.slice(0, el.selectionStart);
    const line = before.split('\n').length;
    setCaret({ line, col: before.length - before.lastIndexOf('\n') });
  };

  // focus : note vide → titre, sinon fin du texte
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!note.title && !note.content) titleRef.current?.focus();
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
  }, [note.id]);

  const words = wordCount(note.content);
  const chars = note.content.length;
  return (
    <div className="fixed inset-0 z-30 anim-fade" style={cvar(note.color)}>
      <div className="backdrop bg-black/80" onClick={closeEditor} />
      <div className="absolute inset-2.5 glass neon bg-[rgb(8_8_14/0.97)] flex flex-col anim-rise" data-ui data-note-editor>
        <Corners />
        {/* barre du haut : retour, titre, suppression */}
        <div className="flex items-center gap-3 px-3.5 h-[52px] border-b border-white/[0.07] flex-none">
          <button className="btn" onClick={closeEditor}>
            ← Retour <span className="text-white/35 ml-1 max-md:hidden">Échap</span>
          </button>
          <span className="hud text-[9.5px] text-[rgb(var(--c))] flex items-center gap-2 flex-none max-md:hidden">
            <span className="dot" /> Note · {shortCode(note.id)}
          </span>
          <input
            ref={titleRef}
            value={note.title}
            readOnly={readOnly}
            onChange={(e) => {
              lock.claim();
              update(note.id, { title: e.target.value });
            }}
            onFocus={lock.claim}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'ArrowDown') {
                e.preventDefault();
                bodyRef.current?.focus();
              }
            }}
            placeholder="Titre de la note"
            className="flex-1 min-w-0 bg-transparent outline-none text-[18px] font-semibold tracking-tight text-white placeholder:text-white/25 px-2"
            style={{ textShadow: '0 0 30px rgb(var(--c) / 0.35)' }}
          />
          {lock.holder && (
            <span className="hud text-[9.5px] px-2.5 py-1 border border-[#ffb020]/60 text-[#ffb020] flex-none" data-note-locked>
              ✎ {lock.holder} écrit · lecture seule
            </span>
          )}
          {lock.viewOnly && !lock.holder && <span className="hud text-[9.5px] px-2.5 py-1 border border-white/20 text-white/55 flex-none">Lecture seule</span>}
          {!readOnly && <DeleteButton id={note.id} label="Supprimer" />}
        </div>

        {/* tags et liens */}
        <div className="flex items-center gap-x-6 gap-y-2 flex-wrap px-4 py-2.5 border-b border-white/[0.05] flex-none">
          <div className="flex items-center gap-2 min-w-0">
            <span className="xs-label">Tags</span>
            {readOnly ? (
              <span className="mono text-[11px] text-white/55">{note.tags.length ? note.tags.map((t) => `#${t}`).join('  ') : '—'}</span>
            ) : (
              <TagEditor note={note} />
            )}
          </div>
          <NoteLinks id={note.id} readOnly={readOnly} />
        </div>

        {/* le texte, sur tout l'écran */}
        <textarea
          ref={bodyRef}
          value={note.content}
          readOnly={readOnly}
          onChange={(e) => {
            lock.claim();
            update(note.id, { content: e.target.value });
            track();
          }}
          onFocus={lock.claim}
          onSelect={track}
          onKeyUp={track}
          onClick={track}
          onKeyDown={(e) => {
            if (e.key === 'Tab' && !readOnly) {
              e.preventDefault();
              const el = e.currentTarget;
              const { selectionStart: a, selectionEnd: b } = el;
              const v = el.value;
              update(note.id, { content: v.slice(0, a) + '  ' + v.slice(b) });
              requestAnimationFrame(() => {
                el.setSelectionRange(a + 2, a + 2);
                track();
              });
            }
          }}
          placeholder={readOnly ? '' : 'Commence à écrire…'}
          spellCheck
          className="flex-1 min-h-0 w-full resize-none bg-transparent outline-none px-6 py-5 text-[17px] leading-[1.75] text-[rgb(233_233_241/0.92)] placeholder:text-white/20 font-sans scroll-thin"
        />

        {/* barre d'état */}
        <div className="flex items-center gap-5 px-4 h-8 border-t border-white/[0.07] mono text-[10.5px] tracking-[0.06em] text-white/45 flex-none overflow-hidden whitespace-nowrap">
          <span>
            Ln {caret.line}, Col {caret.col}
          </span>
          <span>
            {chars.toLocaleString('fr-FR')} caractère{chars > 1 ? 's' : ''}
          </span>
          <span className="max-md:hidden">
            {words.toLocaleString('fr-FR')} mot{words > 1 ? 's' : ''} · {Math.max(1, Math.round(words / 220))} min de lecture
          </span>
          <span className="ml-auto flex items-center gap-2">
            <span key={note.updatedAt} className="w-1.5 h-1.5 bg-[#39ff88] shadow-[0_0_8px_#39ff88] anim-fade" />
            sauvegarde auto · {fmtStamp(note.updatedAt)}
          </span>
          <span className="max-lg:hidden">
            <Kbd>Ctrl K</Kbd> créer · <Kbd>Échap</Kbd> retour
          </span>
        </div>
      </div>
    </div>
  );
}

/** Une note s'ouvre en grand, presque tout l'écran (comme le Bloc-notes) ; le réseau reste flou derrière */
export function NoteEditor() {
  const id = useUI((s) => s.editorId);
  const note = useData((s) => (id ? s.entities[id] : undefined));
  if (!id || !note || note.type !== 'note') return null;
  return <Editor key={id} note={note} />;
}
