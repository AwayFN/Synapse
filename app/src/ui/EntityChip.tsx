import { displayTitle, useData } from '../store/data';
import { useUI } from '../store/ui';
import { cvar } from './common';
import { TYPE_TAG } from './Labels';

/** Linked entity pill: click = open it (camera flies there) */
export function EntityChip({
  id,
  onRemove,
  hint,
  compact,
}: {
  id: string;
  onRemove?: () => void;
  hint?: string;
  compact?: boolean;
}) {
  const e = useData((s) => s.entities[id]);
  const openEntity = useUI((s) => s.openEntity);
  if (!e) return null;
  const done = (e.type === 'task' || e.type === 'project') && e.status === 'done';
  return (
    <span className="chip group max-w-full" style={cvar(e.color)}>
      <button
        className="flex items-center gap-1.5 min-w-0"
        onClick={(ev) => {
          ev.stopPropagation();
          // depuis une vue (tâches, agenda…), l'élément lié s'ouvre par-dessus, sans quitter la vue
          openEntity(id, { keepView: true });
        }}
        title={`Ouvrir ${displayTitle(e)}`}
      >
        <span className="text-[8.5px] opacity-70 tracking-[0.12em]">{TYPE_TAG[e.type]}</span>
        <span className={`truncate ${compact ? 'max-w-[150px]' : 'max-w-[220px]'} ${done ? 'line-through opacity-60' : ''}`}>
          {displayTitle(e)}
        </span>
        {hint && <span className="opacity-45 text-[8.5px] tracking-[0.12em] uppercase">{hint}</span>}
      </button>
      {onRemove && (
        <button
          className="opacity-40 hover:opacity-100 hover:text-white -mr-1 px-0.5"
          title="Retirer le lien"
          onClick={(ev) => {
            ev.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}
