import { displayTitle, useData } from '../store/data';
import { useUI } from '../store/ui';
import { natureOf } from '../lib/kinds';
import { EntityGlyph, natureVar, useKinds } from './common';

/** Pastille d'un neurone relié : clic = y aller (la caméra vole jusqu'à lui) */
export function EntityChip({
  id,
  onRemove,
  hint,
  compact,
  strength,
}: {
  id: string;
  onRemove?: () => void;
  hint?: string;
  compact?: boolean;
  /** force de la connexion 0..1 : petite jauge */
  strength?: number;
}) {
  const e = useData((s) => s.entities[id]);
  const kinds = useKinds();
  const openEntity = useUI((s) => s.openEntity);
  if (!e) return null;
  const done = e.status === 'done';
  return (
    <span className="chip group max-w-full" style={natureVar(natureOf(e, kinds))}>
      <button
        className="flex items-center gap-1.5 min-w-0"
        onClick={(ev) => {
          ev.stopPropagation();
          openEntity(id);
        }}
        title={`Aller à « ${displayTitle(e)} »`}
      >
        <EntityGlyph e={e} size={10} />
        <span className={`truncate ${compact ? 'max-w-[150px]' : 'max-w-[220px]'} ${done ? 'line-through opacity-60' : ''}`}>
          {displayTitle(e)}
        </span>
        {hint && <span className="opacity-45 text-[8.5px] tracking-[0.12em] uppercase">{hint}</span>}
        {strength != null && (
          <span className="flex gap-[2px] items-end h-[8px]" title={`Force du lien : ${Math.round(strength * 100)} %`}>
            {[0.25, 0.5, 0.75].map((th) => (
              <i key={th} className="w-[2px] bg-current" style={{ height: `${3 + th * 6}px`, opacity: strength >= th ? 0.8 : 0.18 }} />
            ))}
          </span>
        )}
      </button>
      {onRemove && (
        <button
          className="opacity-35 hover:opacity-100 hover:text-white -mr-1 px-0.5"
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
