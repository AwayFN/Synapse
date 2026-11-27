import { memo, useCallback, type CSSProperties } from 'react';
import { displayTitle, useData, type DataState } from '../store/data';
import { useUI } from '../store/ui';
import { useNetwork } from '../store/network';
import { useStructure } from '../scene/structure';
import { grab, labelEls, labelHover, reticle } from '../scene/telemetry';
import { rgbTriplet } from '../lib/color';
import { shortCode } from '../lib/random';
import { excerpt, wordCount } from '../lib/text';
import { fmtDateNum, fmtDay, fmtTime } from '../lib/time';
import { bodyOf, hasProject, tagsOf, TASK_STATUS_LABEL, TYPE_LABEL, type EntityType } from '../types';

export const TYPE_TAG: Record<EntityType, string> = { project: 'PRJ', task: 'TSK', note: 'NOTE', slot: 'SLOT' };

function subline(s: DataState, id: string): string {
  const e = s.entities[id];
  if (!e) return '';
  switch (e.type) {
    case 'project': {
      let total = 0;
      let done = 0;
      for (const x of Object.values(s.entities)) {
        if (x.type === 'task' && x.projectId === id) {
          total++;
          if (x.status === 'done') done++;
        }
      }
      const st = e.status === 'done' ? 'terminé' : 'en cours';
      const tags = tagsOf(e);
      return `${done}/${total} tâches · ${st}${e.deadline ? ` · ⟶ ${fmtDateNum(e.deadline)}` : ''}${tags.length ? ` · ${tags.slice(0, 3).map((t) => `#${t}`).join(' ')}` : ''}`;
    }
    case 'task': {
      const parts: string[] = [TASK_STATUS_LABEL[e.status]];
      if (e.projectId && s.entities[e.projectId]) parts.push(`↳ ${displayTitle(s.entities[e.projectId])}`);
      if (e.date) parts.push(`${fmtDay(e.date)}${e.time != null ? ' ' + fmtTime(e.time) : ''}`);
      const tags = tagsOf(e);
      if (tags.length) parts.push(tags.slice(0, 3).map((t) => `#${t}`).join(' '));
      return parts.join(' · ');
    }
    case 'note': {
      const parts: string[] = [];
      if (e.projectId && s.entities[e.projectId]) parts.push(`↳ ${displayTitle(s.entities[e.projectId])}`);
      if (e.date) parts.push(`${fmtDay(e.date)}${e.time != null ? ' ' + fmtTime(e.time) : ''}`);
      const tags = tagsOf(e);
      parts.push(tags.length ? tags.map((t) => `#${t}`).join(' ') : `${wordCount(e.content)} mots`);
      return parts.join(' · ');
    }
    case 'slot': {
      const tags = tagsOf(e);
      return `${fmtTime(e.start)} → ${fmtTime(e.end)} · ${fmtDay(e.date)}${tags.length ? ` · ${tags.slice(0, 3).map((t) => `#${t}`).join(' ')}` : ''}`;
    }
  }
}

function cardText(s: DataState, id: string): string {
  const e = s.entities[id];
  if (!e) return '';
  return excerpt(bodyOf(e), 140);
}

function linkCount(s: DataState, id: string): number {
  let n = 0;
  for (const l of s.links) if (l.a === id || l.b === id) n++;
  const e = s.entities[id];
  if (hasProject(e) && e.projectId) n++;
  if (e?.type === 'project') for (const x of Object.values(s.entities)) if (hasProject(x) && x.projectId === id) n++;
  return n;
}

const Label = memo(function Label({ id }: { id: string }) {
  const e = useData((s) => s.entities[id]);
  const sub = useData((s) => subline(s, id));
  const text = useData((s) => cardText(s, id));
  const links = useData((s) => linkCount(s, id));
  const pinned = useNetwork((s) => !!s.pinned[id]);
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) labelEls.set(id, el);
      else labelEls.delete(id);
    },
    [id],
  );
  if (!e) return null;
  const done = (e.type === 'task' || e.type === 'project') && e.status === 'done';
  return (
    <div
      ref={ref}
      className={`lbl${done ? ' is-done' : ''}`}
      data-label
      data-label-id={id}
      data-pinned={pinned ? '1' : '0'}
      style={{ '--c': rgbTriplet(e.color) } as CSSProperties}
    >
      <i className="lbl-tick" />
      <div className="lbl-body">
        <div
          className="lbl-title"
          onPointerEnter={() => (labelHover.id = id)}
          onPointerLeave={() => {
            if (labelHover.id === id) labelHover.id = null;
          }}
          onClick={() => {
            // on vient de lâcher ce neurone (déplacé par son nom) : ce n'est pas un clic
            if (performance.now() - grab.endedAt < 300) return;
            labelHover.id = null;
            useUI.getState().openEntity(id);
          }}
        >
          <span className="lbl-type">{TYPE_TAG[e.type]}</span>
          {done && <span className="lbl-check">✓</span>}
          {displayTitle(e)}
          {pinned && (
            <span className="lbl-pin" title="Posé à la main">
              ◆
            </span>
          )}
        </div>
        <div className="lbl-sub">{sub}</div>
        <div className="lbl-card">
          <div className="lbl-card-head">
            <span>
              {TYPE_LABEL[e.type]} · {shortCode(id)}
            </span>
            <span>⟷ {links}</span>
          </div>
          <div className="lbl-card-title">{displayTitle(e)}</div>
          {text && <div className="lbl-card-text">{text}</div>}
          <div className="lbl-card-foot">clic → ouvrir</div>
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
