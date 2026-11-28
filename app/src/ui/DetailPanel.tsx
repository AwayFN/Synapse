import { useEffect, useState } from 'react';
import { useData } from '../store/data';
import { panelVisible, removeWithUndo, useUI } from '../store/ui';
import { useNetwork } from '../store/network';
import { shortCode } from '../lib/random';
import { fmtStamp } from '../lib/time';
import { LEVEL } from '../lib/back';
import { tagsOf, TYPE_LABEL, type Entity } from '../types';
import { Corners, cvar, Kbd } from './common';
import { ColorSwatches, LinksSection, NoteFields, ProjectFields, Section, SlotFields, TagEditor, TaskFields } from './fields';

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

/** La place du neurone : posé à la main (il reste là), ou placé automatiquement */
export function PlacementSection({ id }: { id: string }) {
  const pinned = useNetwork((s) => !!s.pinned[id]);
  const unpin = useNetwork((s) => s.unpin);
  return (
    <Section label="Place dans le réseau">
      {pinned ? (
        <div className="flex items-center justify-between gap-3 flex-wrap" data-placement="pinned">
          <span className="text-[12px] text-white/60">
            <span className="text-[rgb(var(--c))]">◆</span> Posé à la main : il reste exactement là.
          </span>
          <button className="btn !py-1 !px-2 !text-[9.5px]" onClick={() => unpin(id)} title="Le neurone reprend sa place automatique">
            Libérer
          </button>
        </div>
      ) : (
        <div className="text-[12px] text-white/40 leading-relaxed" data-placement="auto">
          Placé automatiquement. Glisse le neurone (au doigt : appui long, puis glisse) pour le poser où tu veux.
        </div>
      )}
    </Section>
  );
}

function Body({ e }: { e: Entity }) {
  const update = useData((s) => s.update);
  const closePanel = useUI((s) => s.closePanel);
  const setFocus = useUI((s) => s.setFocus);
  // ouverte depuis une vue (tâches…) : par-dessus elle ; ◎ emmène alors au réseau, sur ce neurone
  const inView = useUI((s) => s.view !== 'network');
  const center = () => (inView ? useUI.setState({ view: 'network', panelView: 'network', focusId: e.id }) : setFocus(e.id));

  return (
    <aside
      data-ui
      data-detail-panel
      className={`fixed right-4 top-4 bottom-4 w-[420px] max-w-[calc(100vw-32px)] glass neon anim-panel flex flex-col ${inView ? 'z-40 bg-[rgb(7_7_12/0.96)]' : 'z-20'} max-md:z-50 max-md:left-0 max-md:right-0 max-md:top-auto max-md:bottom-0 max-md:h-[72vh] max-md:w-auto max-md:max-w-none max-md:pb-[env(safe-area-inset-bottom)] max-md:bg-[rgb(7_7_12/0.97)]`}
      style={cvar(e.color)}
    >
      <Corners />
      {/* sur téléphone : une fiche qui monte du bas (la poignée le montre) */}
      <div className="md:hidden flex justify-center pt-2" aria-hidden>
        <span className="w-10 h-1 rounded-full bg-white/20" />
      </div>
      <div className="flex items-center gap-2.5 px-5 max-md:px-4 pt-4 max-md:pt-2 pb-1">
        <span className="dot" />
        <span className="hud text-[10px] text-[rgb(var(--c))]">
          {TYPE_LABEL[e.type]} · {shortCode(e.id)}
        </span>
        {e.seed && <span className="hud text-[8.5px] text-white/30 border border-white/10 px-1.5 py-px">exemple</span>}
        <div className="ml-auto flex items-center gap-1">
          <button className="btn btn-ghost !px-2 max-md:!px-3 max-md:!py-2" title={inView ? 'Voir dans le réseau' : 'Centrer la caméra (F)'} aria-label={inView ? 'Voir dans le réseau' : 'Centrer la caméra'} onClick={center}>
            ◎
          </button>
          <button className="btn btn-ghost !px-2 max-md:!px-3 max-md:!py-2" title="Fermer (Échap)" aria-label="Fermer" onClick={closePanel}>
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain scroll-thin px-5 max-md:px-4 pb-5">
        <input
          value={e.title}
          onChange={(ev) => update(e.id, { title: ev.target.value })}
          placeholder="Sans titre"
          className="w-full bg-transparent outline-none text-[23px] font-semibold tracking-tight text-white placeholder:text-white/25 mt-2 py-1 border-b border-transparent focus:border-[rgb(var(--c)/0.5)] transition-colors"
          style={{ textShadow: '0 0 24px rgb(var(--c) / 0.35)' }}
        />

        {e.type === 'project' && <ProjectFields p={e} />}
        {e.type === 'task' && <TaskFields t={e} />}
        {e.type === 'slot' && <SlotFields s={e} />}
        {e.type === 'note' && <NoteFields n={e} />}
        {/* des tags sur tout : projets, tâches, notes, créneaux */}
        <Section label="Tags">
          <TagEditor id={e.id} tags={tagsOf(e)} />
        </Section>

        <LinksSection id={e.id} pickerLevel={inView ? LEVEL.inPanelInView : LEVEL.inPanel} />

        <Section label="Couleur de la constellation">
          <ColorSwatches value={e.color} onChange={(c) => update(e.id, { color: c })} />
        </Section>
        <PlacementSection id={e.id} />

        <div className="mt-7 pt-4 border-t border-white/[0.07] flex items-center justify-between gap-3">
          <div className="mono text-[9.5px] tracking-[0.1em] text-white/30 leading-relaxed">
            CRÉÉ {fmtStamp(e.createdAt)}
            <br />
            MODIFIÉ {fmtStamp(e.updatedAt)}
          </div>
          <DeleteButton id={e.id} />
        </div>
      </div>
      <div className="px-5 py-2.5 border-t border-white/[0.06] hud text-[9px] text-white/30 flex gap-3 max-md:hidden">
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

/**
 * Right-hand glass panel: the selected constellation's data, links and actions. Sur le réseau, ou (V8.1) par-dessus la vue
 * d'où on l'a ouverte (tâches…) ; sur téléphone, elle monte du bas.
 */
export function DetailPanel() {
  const id = useUI((s) => s.selectedId);
  const visible = useUI(panelVisible);
  const e = useData((s) => (id ? s.entities[id] : undefined));
  if (!id || !e || !visible) return null;
  return <Body key={id} e={e} />;
}
