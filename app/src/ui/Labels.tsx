import { memo, useCallback } from 'react';
import { displayTitle, useData } from '../store/data';
import { toggleLink, useUI } from '../store/ui';
import { degreeOf, progressOf } from '../store/graph';
import { useStructure } from '../scene/structure';
import { labelEls, labelHover, reticle } from '../scene/telemetry';
import { isHubKind, kindLabel, natureOf, NATURES } from '../lib/kinds';
import { isLate, kindTag, lifeState, metaLine } from '../lib/entity';
import { excerpt } from '../lib/text';
import { natureVar } from './common';
import { memberName, useSession } from '../sync/session';

const Label = memo(function Label({ id }: { id: string }) {
  const e = useData((s) => s.entities[id]);
  const kinds = useData((s) => s.kinds);
  const degree = useData((s) => degreeOf(s.links, id));
  const progress = useData((s) => {
    const x = s.entities[id];
    if (!x || !isHubKind(x.kind)) return '';
    const [d, t] = progressOf(s.entities, s.links, id);
    return `${d}/${t}`;
  });
  const shared = useSession((s) => s.mode !== 'local');
  const canLink = useSession((s) => s.role !== 'lecture');
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) labelEls.set(id, el);
      else labelEls.delete(id);
    },
    [id],
  );
  if (!e) return null;
  const nature = natureOf(e, kinds);
  const [d, t] = progress ? progress.split('/').map(Number) : [0, 0];
  const meta = metaLine(e, { progress: t ? [d, t] : undefined });
  const late = isLate(e);
  const text = excerpt(e.body, 150);
  return (
    <div
      ref={ref}
      className="lbl"
      data-label
      data-state={lifeState(e)}
      data-strike={e.status === 'done' ? '1' : '0'}
      style={natureVar(nature)}
    >
      <i className="lbl-tick" />
      <div className="lbl-body">
        <div
          className="lbl-title"
          onPointerEnter={() => (labelHover.id = id)}
          onPointerLeave={() => {
            if (labelHover.id === id) labelHover.id = null;
          }}
          onClick={(ev) => {
            labelHover.id = null;
            const ui = useUI.getState();
            if (ev.shiftKey && ui.selectedId && ui.selectedId !== id) toggleLink(ui.selectedId, id);
            else ui.openEntity(id);
          }}
        >
          {e.pinned && <span className="text-[9px] opacity-60">★</span>}
          {e.private && <span className="text-[9px] opacity-70" title="Privé : jamais montré aux invités">🔒</span>}
          <span className="lbl-name truncate max-w-[260px]">{displayTitle(e)}</span>
        </div>
        <div className="lbl-sub">
          <span className="lbl-kind">{kindTag(e)}</span>
          {meta && <> · {meta}</>}
          {late && <span className="lbl-alert"> · en retard</span>}
        </div>
        <div className="lbl-card">
          <div className="lbl-card-head">
            <span>
              {NATURES[nature].label} · {kindLabel(e.kind)}
            </span>
            <span>⟷ {degree}</span>
          </div>
          <div className="lbl-card-title">{displayTitle(e)}</div>
          {text && <div className="lbl-card-text">{text}</div>}
          <div className="lbl-card-foot">
            {shared && `par ${memberName(e.createdBy)} · `}clic → ouvrir{canLink ? ' · maj+clic → relier' : ''}
          </div>
        </div>
      </div>
    </div>
  );
});

export function LabelLayer() {
  const structure = useStructure();
  return (
    <div className="labels">
      {structure.nodes.map((n) => (
        <Label key={n.id} id={n.id} />
      ))}
      <div
        className="reticle"
        ref={(el) => {
          reticle.el = el;
        }}
      >
        <i />
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
