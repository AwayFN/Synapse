import { useCallback } from 'react';
import { useSession, ROLE_LABEL, type Presence } from '../sync/session';
import { useData, displayTitle } from '../store/data';
import { useUI } from '../store/ui';
import { presenceEls } from '../scene/telemetry';

/** Les autres participants en ligne (moi exclu) */
export function useOthers(): Presence[] {
  const online = useSession((s) => s.online);
  const me = useSession((s) => s.me.id);
  return online.filter((p) => p.id !== me);
}

/** HUD : qui est là, que regarde-t-il ; clic = suivre sa caméra. Le propriétaire a aussi « Partager ». */
export function PresenceBar() {
  const mode = useSession((s) => s.mode);
  const role = useSession((s) => s.role);
  const following = useSession((s) => s.following);
  const others = useOthers();
  const entities = useData((s) => s.entities);
  if (mode === 'local') return null;
  return (
    <div className="flex flex-col items-end gap-2 pointer-events-auto" data-ui>
      {role === 'owner' && (
        <button className="glass neon hud text-[10px] text-white/80 hover:text-white px-3.5 py-2 flex items-center gap-2" onClick={() => useSession.setState({ shareOpen: true })}>
          <span className="text-white">⤴</span> Partager
          {others.length > 0 && <span className="text-white/45">· {others.length} en ligne</span>}
        </button>
      )}
      {others.map((p) => {
        const on = following === p.id;
        const where = p.focus && entities[p.focus] ? displayTitle(entities[p.focus]) : p.view === 'network' ? 'explore le réseau' : `vue ${p.view === 'agenda' ? 'agenda' : p.view === 'notes' ? 'notes' : 'tâches'}`;
        return (
          <button
            key={p.id}
            className={`glass flex items-center gap-2.5 pl-1.5 pr-3 py-1 max-w-[290px] max-md:max-w-[190px] transition-colors ${on ? 'border-white/40' : 'hover:border-white/20'}`}
            title={on ? 'Ne plus suivre' : `Suivre ${p.name} : ta caméra va où il regarde`}
            onClick={() => {
              useSession.setState({ following: on ? null : p.id });
              if (!on && p.focus && entities[p.focus]) useUI.getState().openEntity(p.focus);
            }}
          >
            <span className={`w-6 h-6 rounded-full border flex items-center justify-center mono text-[9px] flex-none ${p.editing ? 'border-white text-white' : 'border-white/50 text-white/85'}`}>
              {p.initials}
            </span>
            <span className="min-w-0 text-left">
              <span className="block text-[11.5px] text-white/85 truncate">
                {p.name} <span className="mono text-[8.5px] text-white/35 uppercase">{ROLE_LABEL[p.role]}</span>
              </span>
              <span className="block mono text-[9px] tracking-[0.06em] text-white/40 truncate">
                {on ? '◉ TU LE SUIS · ' : ''}
                {p.editing ? '✎ écrit · ' : ''}
                {where}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function Tag({ p, slot }: { p: Presence; slot: number }) {
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) presenceEls.set(p.id, { el, focus: p.focus, slot });
      else presenceEls.delete(p.id);
    },
    [p.id, p.focus, slot],
  );
  return (
    <div ref={ref} className="ptag">
      <i />
      {p.name.toUpperCase()}
      {p.editing === p.focus && p.editing ? ' ✎' : ''}
    </div>
  );
}

/** Calque DOM des étiquettes de présence (positionnées par PresenceProjector) */
export function PresenceTags() {
  const others = useOthers();
  const slots = new Map<string, number>();
  return (
    <div className="labels">
      {others
        .filter((p) => p.focus)
        .map((p) => {
          const slot = slots.get(p.focus!) ?? 0;
          slots.set(p.focus!, slot + 1);
          return <Tag key={p.id} p={p} slot={slot} />;
        })}
    </div>
  );
}
