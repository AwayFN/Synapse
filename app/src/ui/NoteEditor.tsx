import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useData } from '../store/data';
import { useUI } from '../store/ui';
import { findLink } from '../store/graph';
import { shortCode } from '../lib/random';
import { norm, wordCount } from '../lib/text';
import { fmtStamp } from '../lib/time';
import { kindLabel, natureOf, NATURES } from '../lib/kinds';
import { mentionsIn, resolveRef } from '../lib/parse';
import type { Entity } from '../types';
import { EntityGlyph, Kbd, natureVar, useKinds } from './common';
import { DeleteButton } from './DetailPanel';
import { ConnectionsSection, FacetBar, TagEditor, useOtherWriter, writing } from './fields';
import { useCan } from '../sync/perm';

function Editor({ e }: { e: Entity }) {
  const update = useData((s) => s.update);
  const entities = useData((s) => s.entities);
  const kinds = useKinds();
  const closeEditor = useUI((s) => s.closeEditor);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const nature = natureOf(e, kinds);
  const can = useCan();
  const ro = !can.edit(e);
  const other = useOtherWriter(e.id);

  // focus : neurone vide → titre, sinon fin du texte
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (!e.title && !e.body) titleRef.current?.focus();
      else {
        const b = bodyRef.current;
        if (b) {
          b.focus();
          b.setSelectionRange(b.value.length, b.value.length);
        }
      }
    }, 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [e.id]);

  useLayoutEffect(() => {
    const b = bodyRef.current;
    if (!b) return;
    b.style.height = 'auto';
    b.style.height = `${Math.max(b.scrollHeight, window.innerHeight * 0.45)}px`;
  }, [e.body]);

  // [[mentions]] : relier ce qui existe, proposer de créer le reste
  const pending = useMemo(
    () => mentionsIn(e.body).filter((t) => {
      const ent = resolveRef(t, entities);
      return !ent || norm(ent.title) !== norm(t);
    }),
    [e.body, entities],
  );
  const linkMentions = () => {
    if (!can.edit(useData.getState().entities[e.id])) return;
    const d = useData.getState();
    const body = d.entities[e.id]?.body ?? '';
    for (const t of mentionsIn(body)) {
      const ent = Object.values(d.entities).find((x) => x.id !== e.id && norm(x.title) === norm(t));
      if (ent && !findLink(d.links, e.id, ent.id)) d.link(e.id, ent.id, { origin: 'mention', strength: 0.4 });
    }
  };
  useEffect(() => () => linkMentions(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const words = wordCount(e.body);
  return (
    <div className="fixed inset-0 z-30 anim-fade" style={natureVar(nature)}>
      <div className="backdrop" />
      <div className="absolute inset-0 overflow-y-auto scroll-thin" data-ui>
        <div className="mx-auto w-[min(900px,calc(100vw-48px))] pt-5 pb-32 min-h-full flex flex-col anim-rise">
          <div className="sticky top-0 z-10 -mx-4 px-4 py-3 flex items-center gap-4 bg-black/40 backdrop-blur-md">
            <button className="btn" onClick={closeEditor}>
              ← Retour <span className="text-white/35 ml-1">Échap</span>
            </button>
            <span className="hud text-[9.5px] text-[rgb(var(--c))] flex items-center gap-2">
              <EntityGlyph e={e} size={11} /> {kindLabel(e.kind)} · {NATURES[nature].label} · {shortCode(e.id)}
            </span>
            <span className="ml-auto mono text-[10px] tracking-[0.12em] text-white/35 flex items-center gap-2">
              <span key={e.updatedAt} className="w-1.5 h-1.5 rounded-full bg-[rgb(var(--pearl))] anim-fade" />
              SAUVEGARDE AUTO · {fmtStamp(e.updatedAt)}
            </span>
            <span className="mono text-[10px] tracking-[0.12em] text-white/35">
              {words} MOT{words > 1 ? 'S' : ''} · {Math.max(1, Math.round(words / 220))} MIN
            </span>
          </div>

          <input
            ref={titleRef}
            value={e.title}
            readOnly={ro}
            onFocus={() => !ro && writing.start(e.id)}
            onBlur={() => writing.stop(e.id)}
            onChange={(ev) => update(e.id, { title: ev.target.value })}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === 'ArrowDown') {
                ev.preventDefault();
                bodyRef.current?.focus();
              }
            }}
            placeholder="Titre"
            className="w-full bg-transparent outline-none text-[40px] leading-tight font-semibold tracking-tight text-white placeholder:text-white/20 mt-8"
          />
          <div className="mt-4 flex flex-col gap-3">
            <FacetBar e={e} ro={ro} />
            <TagEditor e={e} ro={ro} />
            {other && !ro && (
              <div className="mono text-[10px] tracking-[0.1em] text-white/60 flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[rgb(var(--pearl))] breathe" />
                {other.toUpperCase()} ÉCRIT AUSSI DANS CETTE PENSÉE · VOS MODIFICATIONS PEUVENT SE CROISER
              </div>
            )}
          </div>
          <div className="h-px mt-5 mb-8 bg-gradient-to-r from-[rgb(var(--c)/0.7)] via-[rgb(var(--c)/0.15)] to-transparent" />

          <textarea
            ref={bodyRef}
            value={e.body}
            readOnly={ro}
            onChange={(ev) => update(e.id, { body: ev.target.value })}
            onFocus={() => !ro && writing.start(e.id)}
            onBlur={() => {
              writing.stop(e.id);
              linkMentions();
            }}
            onKeyDown={(ev) => {
              if (ev.key === 'Tab') {
                ev.preventDefault();
                const el = ev.currentTarget;
                const { selectionStart: a, selectionEnd: b } = el;
                const v = el.value;
                update(e.id, { body: v.slice(0, a) + '  ' + v.slice(b) });
                requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
              }
            }}
            placeholder="Laisse venir la pensée… écris [[Titre]] pour la relier à un autre neurone."
            spellCheck
            className="w-full bg-transparent outline-none resize-none text-[19px] leading-[1.8] text-[rgb(228_233_242/0.9)] placeholder:text-white/20 font-sans"
          />
          {pending.length > 0 && !ro && (
            <div className="flex flex-wrap gap-1.5 mt-4">
              {pending.map((t) => (
                <button
                  key={t}
                  className="chip"
                  onClick={() => useData.getState().create({ title: t }, { linkTo: [e.id], origin: 'mention', strength: 0.4, near: e.id })}
                >
                  ＋ créer « {t} » et relier
                </button>
              ))}
            </div>
          )}

          <div className="mt-16 pt-6 border-t border-white/[0.06]">
            <ConnectionsSection id={e.id} label="Connexions de cette pensée" />
            <div className="mt-6 flex items-center justify-between">
              <span className="hud text-[9px] text-white/25">
                <Kbd>Ctrl K</Kbd> capturer · <Kbd>Échap</Kbd> retour au réseau
              </span>
              {!ro && <DeleteButton id={e.id} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Écriture plein écran, sans distraction ; le réseau reste flou derrière */
export function NoteEditor() {
  const id = useUI((s) => s.editorId);
  const e = useData((s) => (id ? s.entities[id] : undefined));
  if (!id || !e) return null;
  return <Editor key={id} e={e} />;
}
