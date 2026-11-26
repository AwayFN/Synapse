import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { displayTitle, useData } from '../store/data';
import { useUI } from '../store/ui';
import { excerpt, matchScore } from '../lib/text';
import { fmtStamp } from '../lib/time';
import { tagsOf, type Note, type Project } from '../types';
import { useCanWrite } from '../sync/lock';
import { Corners, cvar, Kbd } from './common';
import { tagColor } from './TagBar';

/**
 * Vue Notes : toutes les notes, comme le tableau des tâches. Une note appartient à un projet, ou elle est
 * « indépendante » (comme une tâche indépendante) ; on filtre par projet, par tag, ou on cherche.
 */
function Notes() {
  const notes = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Note => e.type === 'note')));
  const projects = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Project => e.type === 'project')));
  const createNote = useData((s) => s.createNote);
  const setView = useUI((s) => s.setView);
  const openEditor = useUI((s) => s.openEditor);
  const canWrite = useCanWrite();
  const [filter, setFilter] = useState<string>('all');
  const [tag, setTag] = useState<string | null>(null);
  const [q, setQ] = useState('');

  const byId = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  // les projets qui ont des notes (les autres n'encombrent pas les filtres)
  const withNotes = useMemo(() => {
    const ids = new Set(notes.map((n) => n.projectId).filter(Boolean) as string[]);
    return projects.filter((p) => ids.has(p.id)).sort((a, b) => displayTitle(a).localeCompare(displayTitle(b)));
  }, [notes, projects]);
  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) for (const t of tagsOf(n)) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [notes]);
  const independent = notes.filter((n) => !n.projectId || !byId.has(n.projectId)).length;

  const visible = useMemo(() => {
    const query = q.trim();
    return notes
      .filter((n) => (filter === 'all' ? true : filter === 'none' ? !n.projectId || !byId.has(n.projectId) : n.projectId === filter))
      .filter((n) => !tag || tagsOf(n).includes(tag))
      .map((n) => ({ n, s: query ? Math.max(matchScore(query, displayTitle(n)), matchScore(query, n.content) * 0.6, matchScore(query, tagsOf(n).join(' ')) * 0.8) : 1 }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.n.updatedAt - a.n.updatedAt)
      .map((x) => x.n);
  }, [notes, filter, tag, q, byId]);

  const create = () => {
    const projectId = filter !== 'all' && filter !== 'none' ? filter : null;
    const n = createNote({ projectId, tags: tag ? [tag] : [] });
    openEditor(n.id, { keepView: true });
  };

  return (
    <div className="fixed inset-0 z-30 anim-fade" data-ui data-notes-view>
      <div className="backdrop" onClick={() => setView('network')} />
      <div className="absolute inset-x-6 top-5 bottom-5 max-md:inset-x-2 max-md:top-2 max-md:bottom-2 flex flex-col pointer-events-none">
        <div className="flex items-end justify-between pointer-events-auto mb-3 gap-4 flex-wrap">
          <div>
            <div className="hud text-[10px] text-[#a855f7]">Vue notes</div>
            <div className="text-[28px] max-md:text-[22px] font-semibold tracking-tight text-white mt-1">
              {notes.length}
              <span className="text-[13px] font-normal text-white/40 ml-3">
                note{notes.length > 1 ? 's' : ''} · {independent} indépendante{independent > 1 ? 's' : ''}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input className="field !w-[220px] max-md:!w-[160px]" placeholder="Chercher dans les notes…" value={q} onChange={(e) => setQ(e.target.value)} data-notes-search />
            {canWrite && (
              <button className="btn btn-primary" style={cvar('#a855f7')} onClick={create}>
                + Nouvelle note
              </button>
            )}
            <button className="btn" onClick={() => setView('network')}>
              ← Réseau <span className="text-white/35 ml-1 max-md:hidden">Échap</span>
            </button>
          </div>
        </div>

        {/* filtres : toutes, par projet, indépendantes ; puis par tag */}
        <div className="flex flex-wrap items-center gap-1.5 pointer-events-auto mb-2">
          <button className="chip" data-on={filter === 'all' ? '1' : '0'} style={cvar('#ffffff')} onClick={() => setFilter('all')}>
            Toutes
          </button>
          {withNotes.map((p) => (
            <button key={p.id} className="chip" data-on={filter === p.id ? '1' : '0'} style={cvar(p.color)} onClick={() => setFilter(p.id)}>
              {displayTitle(p)}
            </button>
          ))}
          <button className="chip" data-on={filter === 'none' ? '1' : '0'} style={cvar('#9aa0b4')} onClick={() => setFilter('none')} data-filter-independent>
            Indépendantes
          </button>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 pointer-events-auto mb-3">
            {tags.map(([t, n]) => (
              <button key={t} className="chip" data-on={tag === t ? '1' : '0'} style={cvar(tagColor(t))} onClick={() => setTag(tag === t ? null : t)}>
                #{t}
                <span className="opacity-50">{n}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto scroll-thin pointer-events-auto pr-1">
          {visible.length === 0 ? (
            <div className="glass h-[160px] flex items-center justify-center hud text-[10px] text-white/35 text-center px-6">
              {notes.length === 0 ? 'Aucune note pour l’instant · « + Nouvelle note » ou Ctrl N' : 'Aucune note ne correspond'}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] max-md:grid-cols-1 gap-3">
              {visible.map((n) => {
                const p = n.projectId ? byId.get(n.projectId) : undefined;
                const t = tagsOf(n);
                return (
                  <button
                    key={n.id}
                    data-note-card={n.id}
                    onClick={() => openEditor(n.id, { keepView: true })}
                    className="relative glass neon text-left p-4 flex flex-col gap-2 min-h-[132px] hover:border-[rgb(var(--c)/0.5)] hover:shadow-[0_0_24px_rgb(var(--c)/0.14)] transition-all"
                    style={cvar(n.color)}
                  >
                    <Corners />
                    <div className="flex items-center gap-2">
                      <span className="dot" />
                      <span className="text-[14px] font-semibold text-white truncate">{displayTitle(n)}</span>
                    </div>
                    <div className="text-[12.5px] leading-relaxed text-white/55 line-clamp-4 whitespace-pre-line break-words flex-1">
                      {excerpt(n.content, 300) || <span className="text-white/25">Note vide</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {p ? (
                        <span className="chip !text-[9.5px] !py-px" style={cvar(p.color)}>
                          ↳ {displayTitle(p)}
                        </span>
                      ) : (
                        <span className="mono text-[9px] tracking-[0.12em] text-white/35 uppercase">indépendante</span>
                      )}
                      {t.slice(0, 4).map((x) => (
                        <span key={x} className="chip !text-[9.5px] !py-px" style={cvar(tagColor(x))}>
                          #{x}
                        </span>
                      ))}
                      <span className="mono text-[9px] text-white/30 ml-auto">{fmtStamp(n.updatedAt)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="hud text-[9px] text-white/30 mt-3 flex gap-4 justify-center pointer-events-none max-md:hidden">
          <span>Clic = ouvrir en grand</span>
          <span>
            <Kbd>Ctrl N</Kbd> nouvelle note
          </span>
          <span>
            <Kbd>Échap</Kbd> réseau
          </span>
        </div>
      </div>
    </div>
  );
}

export function NotesView() {
  const view = useUI((s) => s.view);
  return view === 'notes' ? <Notes /> : null;
}
