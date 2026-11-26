import { useEffect, useState } from 'react';
import { useData } from '../store/data';
import { removeWithUndo, useUI } from '../store/ui';
import { shortCode } from '../lib/random';
import { fmtStamp } from '../lib/time';
import { tagsOf, TYPE_LABEL, type Entity } from '../types';
import { Corners, cvar, Kbd } from './common';
import { BodyPreview, ColorSwatches, LinksSection, ProjectFields, ProjectSelect, Section, SlotFields, TagEditor, TaskFields } from './fields';
import { useEditLock } from '../sync/lock';
import { useSession } from '../sync/session';

export function DeleteButton({ id, label = 'Supprimer' }: { id: string; label?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(t);
  }, [armed]);
  return (
    <button
      className={`btn btn-danger ${armed ? 'btn-primary' : ''}`}
      onClick={() => (armed ? removeWithUndo(id) : setArmed(true))}
    >
      {armed ? 'Confirmer la suppression ?' : label}
    </button>
  );
}

function Body({ e }: { e: Entity }) {
  const update = useData((s) => s.update);
  const closePanel = useUI((s) => s.closePanel);
  const setFocus = useUI((s) => s.setFocus);
  // partage : une seule personne modifie un élément à la fois ; « peut regarder » ne modifie rien
  const lock = useEditLock(e.id);
  const ro = !lock.canWrite;
  const owner = useSession((s) => s.mode === 'local' || s.role === 'owner');

  return (
    <aside
      data-ui
      className="fixed right-4 top-4 bottom-4 w-[420px] max-w-[calc(100vw-32px)] glass neon anim-panel flex flex-col z-20 max-md:left-2 max-md:right-2 max-md:top-auto max-md:bottom-2 max-md:h-[62vh] max-md:w-auto max-md:max-w-none"
      style={cvar(e.color)}
    >
      <Corners />
      <div className="flex items-center gap-2.5 px-5 pt-4 pb-1">
        <span className="dot" />
        <span className="hud text-[10px] text-[rgb(var(--c))]">
          {TYPE_LABEL[e.type]} · {shortCode(e.id)}
        </span>
        {e.seed && <span className="hud text-[8.5px] text-white/30 border border-white/10 px-1.5 py-px">exemple</span>}
        {lock.holder && <span className="hud text-[8.5px] text-[#ffb020] border border-[#ffb020]/50 px-1.5 py-px">✎ {lock.holder} modifie</span>}
        {lock.viewOnly && <span className="hud text-[8.5px] text-white/50 border border-white/20 px-1.5 py-px">lecture seule</span>}
        <div className="ml-auto flex items-center gap-1">
          <button className="btn btn-ghost !px-2" title="Centrer la caméra (F)" onClick={() => setFocus(e.id)}>
            ◎
          </button>
          <button className="btn btn-ghost !px-2" title="Fermer (Échap)" onClick={closePanel}>
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin px-5 pb-5" onFocus={lock.claim} onInput={lock.claim} onChange={lock.claim}>
        <input
          value={e.title}
          readOnly={ro}
          onChange={(ev) => update(e.id, { title: ev.target.value })}
          placeholder="Sans titre"
          className="w-full bg-transparent outline-none text-[23px] font-semibold tracking-tight text-white placeholder:text-white/25 mt-2 py-1 border-b border-transparent focus:border-[rgb(var(--c)/0.5)] transition-colors"
          style={{ textShadow: '0 0 24px rgb(var(--c) / 0.35)' }}
        />

        <fieldset disabled={ro} className="m-0 p-0 border-0 min-w-0">
          {e.type === 'project' && <ProjectFields p={e} />}
          {e.type === 'task' && <TaskFields t={e} />}
          {e.type === 'slot' && <SlotFields s={e} />}
          {e.type === 'note' && (
            <>
              <Section label="Projet">
                <ProjectSelect value={e.projectId ?? null} onChange={(id) => update(e.id, { projectId: id })} empty="— Note indépendante —" />
              </Section>
              <Section label="Contenu">
                <BodyPreview e={e} placeholder="Note vide : écris-la en grand." readOnly={ro} />
              </Section>
            </>
          )}
          {/* des tags sur tout : projets, tâches, notes, créneaux */}
          <Section label="Tags">
            {ro ? <span className="mono text-[11px] text-white/55">{tagsOf(e).length ? tagsOf(e).map((t) => `#${t}`).join('  ') : '—'}</span> : <TagEditor id={e.id} tags={tagsOf(e)} />}
          </Section>
        </fieldset>

        <LinksSection id={e.id} readOnly={ro} />

        <fieldset disabled={ro} className="m-0 p-0 border-0 min-w-0">
          <Section label="Couleur de la constellation">
            <ColorSwatches value={e.color} onChange={(c) => update(e.id, { color: c })} />
          </Section>
          {owner && (
            <Section label="Partage">
              <label className="flex items-start gap-2 text-[12px] text-white/60 cursor-pointer">
                <input type="checkbox" className="mt-[3px]" checked={!!e.private} onChange={(ev) => update(e.id, { private: ev.target.checked || undefined })} />
                <span>Privé : jamais montré aux personnes que tu invites</span>
              </label>
            </Section>
          )}
        </fieldset>

        <div className="mt-7 pt-4 border-t border-white/[0.07] flex items-center justify-between gap-3">
          <div className="mono text-[9.5px] tracking-[0.1em] text-white/30 leading-relaxed">
            CRÉÉ {fmtStamp(e.createdAt)}
            <br />
            MODIFIÉ {fmtStamp(e.updatedAt)}
          </div>
          {!ro && <DeleteButton id={e.id} />}
        </div>
      </div>
      <div className="px-5 py-2.5 border-t border-white/[0.06] hud text-[9px] text-white/30 flex gap-3">
        <span>
          <Kbd>Échap</Kbd> fermer
        </span>
        <span>
          <Kbd>F</Kbd> centrer
        </span>
        <span>
          <Kbd>Clic droit</Kbd> orbiter
        </span>
      </div>
    </aside>
  );
}

/** Right-hand glass panel: the selected constellation's data, links and actions */
export function DetailPanel() {
  const id = useUI((s) => s.selectedId);
  const view = useUI((s) => s.view);
  const e = useData((s) => (id ? s.entities[id] : undefined));
  if (!id || !e || view !== 'network') return null;
  return <Body key={id} e={e} />;
}
