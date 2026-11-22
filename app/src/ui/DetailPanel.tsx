import { useEffect, useState } from 'react';
import { useData } from '../store/data';
import { removeWithUndo, useUI } from '../store/ui';
import { shortCode } from '../lib/random';
import { fmtStamp, fmtRelative } from '../lib/time';
import { kindLabel, natureOf, NATURES } from '../lib/kinds';
import { isLate, lifeState } from '../lib/entity';
import type { Entity } from '../types';
import { useCan } from '../sync/perm';
import { memberName, useSession } from '../sync/session';
import { Corners, EntityGlyph, Kbd, natureVar, useKinds } from './common';
import {
  BodyField,
  ConnectionsSection,
  ContextSection,
  DueField,
  FacetBar,
  KindField,
  LinkedActionsSection,
  Section,
  StatusSeg,
  SuggestionsSection,
  TagEditor,
  WhenFields,
  writing,
} from './fields';

export function DeleteButton({ id, label = 'Supprimer' }: { id: string; label?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 3000);
    return () => window.clearTimeout(t);
  }, [armed]);
  return (
    <button className={`btn btn-danger ${armed ? 'btn-primary' : ''}`} onClick={() => (armed ? removeWithUndo(id) : setArmed(true))}>
      {armed ? 'Confirmer la suppression ?' : label}
    </button>
  );
}

const STATE_LABEL = { vivid: 'vivant', calm: 'calme', dormant: 'endormi', done: 'terminé' } as const;

function Body({ e }: { e: Entity }) {
  const update = useData((s) => s.update);
  const kinds = useKinds();
  const closePanel = useUI((s) => s.closePanel);
  const setFocus = useUI((s) => s.setFocus);
  const openEditor = useUI((s) => s.openEditor);
  const trail = useUI((s) => s.trail);
  const trailPos = useUI((s) => s.trailPos);
  const back = useUI((s) => s.back);
  const nature = natureOf(e, kinds);
  const late = isLate(e);
  const can = useCan();
  const shared = useSession((s) => s.mode !== 'local');
  useSession((s) => s.members);
  const ro = !can.edit(e);

  return (
    <aside
      data-ui
      className="fixed right-4 top-4 bottom-4 w-[440px] max-w-[calc(100vw-32px)] glass neon anim-panel flex flex-col z-20 max-md:left-2 max-md:right-2 max-md:top-auto max-md:bottom-2 max-md:h-[62vh] max-md:w-auto max-md:max-w-none"
      style={natureVar(nature)}
    >
      <Corners />
      <div className="flex items-center gap-2.5 px-5 pt-4 pb-1">
        <EntityGlyph e={e} size={13} />
        <span className="hud text-[10px] text-[rgb(var(--c))]">
          {kindLabel(e.kind)} · {NATURES[nature].label}
        </span>
        <span className="hud text-[9px] text-white/28">{shortCode(e.id)}</span>
        {e.seed && <span className="hud text-[8.5px] text-white/30 border border-white/10 px-1.5 py-px">exemple</span>}
        <div className="ml-auto flex items-center gap-1">
          {trailPos > 0 && (
            <button className="btn btn-ghost !px-2" title="Revenir au neurone précédent (Alt ←)" onClick={back}>
              ←
            </button>
          )}
          <button className="btn btn-ghost !px-2" title="Centrer la caméra (F)" onClick={() => setFocus(e.id)}>
            ◎
          </button>
          <button className="btn btn-ghost !px-2" title="Fermer (Échap)" onClick={closePanel}>
            ✕
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scroll-thin px-5 pb-5">
        <input
          value={e.title}
          readOnly={ro}
          onChange={(ev) => update(e.id, { title: ev.target.value })}
          onFocus={() => !ro && writing.start(e.id)}
          onBlur={() => writing.stop(e.id)}
          placeholder="Sans titre"
          className="w-full bg-transparent outline-none text-[22px] font-semibold tracking-tight text-white placeholder:text-white/25 mt-2 py-1 border-b border-transparent focus:border-[rgb(var(--c)/0.4)] transition-colors"
        />
        <div className="mono text-[9.5px] tracking-[0.12em] text-white/35 mt-1 flex gap-3">
          <span>{STATE_LABEL[lifeState(e)].toUpperCase()}</span>
          <span>VU {fmtRelative(e.touchedAt - Date.now()).toUpperCase()}</span>
          {late && <span className="text-[rgb(var(--alert))]">EN RETARD</span>}
          {e.private && <span>🔒 PRIVÉ</span>}
          {ro && shared && <span>LECTURE SEULE</span>}
        </div>

        <Section label="Genre">
          <KindField e={e} ro={ro} />
        </Section>

        <Section label="Facettes">
          <FacetBar e={e} ro={ro} />
          {e.status && (
            <div className="mt-3">
              <StatusSeg value={e.status} disabled={ro} onChange={(v) => update(e.id, { status: v })} />
            </div>
          )}
          {e.when && (
            <div className="mt-3">
              <WhenFields e={e} ro={ro} />
            </div>
          )}
          {e.due && (
            <div className="mt-3 flex items-center gap-2">
              <span className="xs-label flex-none">Avant le</span>
              <div className="flex-1">
                <DueField e={e} ro={ro} />
              </div>
            </div>
          )}
        </Section>

        <Section label="Contenu">
          <BodyField e={e} ro={ro} onExpand={() => openEditor(e.id)} />
        </Section>

        <Section label="Tags">
          <TagEditor e={e} ro={ro} />
        </Section>

        <LinkedActionsSection e={e} />
        <ConnectionsSection id={e.id} />
        <SuggestionsSection id={e.id} />
        <ContextSection id={e.id} />

        <div className="mt-7 pt-4 border-t border-white/[0.06] flex items-center justify-between gap-3">
          <div className="mono text-[9.5px] tracking-[0.1em] text-white/30 leading-relaxed">
            CAPTURÉ {fmtStamp(e.createdAt)}
            {shared && ` PAR ${memberName(e.createdBy).toUpperCase()}`}
            <br />
            MODIFIÉ {fmtStamp(e.updatedAt)}
            {shared && e.updatedBy && ` PAR ${memberName(e.updatedBy).toUpperCase()}`}
          </div>
          {!ro && <DeleteButton id={e.id} />}
        </div>
      </div>
      <div className="px-5 py-2.5 border-t border-white/[0.05] hud text-[9px] text-white/30 flex flex-wrap gap-x-3 gap-y-1">
        <span>
          <Kbd>Entrée</Kbd> {ro ? 'lire' : 'développer'}
        </span>
        {can.link() && (
          <span>
            <Kbd>Maj+clic</Kbd> relier
          </span>
        )}
        {trail.length > 1 && (
          <span>
            <Kbd>Alt ←</Kbd> revenir
          </span>
        )}
        <span>
          <Kbd>Échap</Kbd> fermer
        </span>
      </div>
    </aside>
  );
}

/** Panneau de verre à droite : le neurone sélectionné, ses facettes, ses connexions */
export function DetailPanel() {
  const id = useUI((s) => s.selectedId);
  const view = useUI((s) => s.view);
  const editorId = useUI((s) => s.editorId);
  const e = useData((s) => (id ? s.entities[id] : undefined));
  if (!id || !e || view !== 'network' || editorId) return null;
  return <Body key={id} e={e} />;
}
