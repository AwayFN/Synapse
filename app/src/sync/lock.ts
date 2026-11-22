import { useEffect } from 'react';
import { useSession } from './session';

/**
 * Une seule personne écrit à la fois dans un élément partagé (note, tâche, projet, créneau).
 * Celui qui commence à écrire l'annonce (présence « editing ») ; les autres voient « Léa écrit » et l'élément
 * passe en lecture seule chez eux. Le serveur refuse de son côté les modifications des autres.
 * Sans rien taper pendant 40 s, l'élément se libère tout seul (et se reprend dès qu'on recommence).
 */
export interface EditLock {
  /** je peux modifier (personne d'autre n'écrit, et j'ai le droit de modifier) */
  canWrite: boolean;
  /** prénom de la personne qui écrit en ce moment, sinon null */
  holder: string | null;
  /** mon rôle ne permet que de regarder */
  viewOnly: boolean;
  /** « j'écris ici » : à appeler quand je commence à écrire (et à chaque frappe, pour le garder) */
  claim: () => void;
}

const IDLE_MS = 40_000;
let releaseTimer: number | undefined;

export function claimEditing(id: string) {
  const s = useSession.getState();
  if (s.mode === 'local' || s.role === 'lecture' || !id) return;
  if (s.online.some((p) => p.id !== s.me.id && p.editing === id)) return;
  if (s.editing !== id) useSession.setState({ editing: id });
  window.clearTimeout(releaseTimer);
  releaseTimer = window.setTimeout(() => releaseEditing(id), IDLE_MS);
}

export function releaseEditing(id?: string) {
  const s = useSession.getState();
  if (id && s.editing !== id) return;
  window.clearTimeout(releaseTimer);
  if (s.editing) useSession.setState({ editing: null });
}

export function useEditLock(id: string): EditLock {
  const mode = useSession((s) => s.mode);
  const role = useSession((s) => s.role);
  const holder = useSession((s) => (id ? s.online.find((p) => p.id !== s.me.id && p.editing === id)?.name ?? null : null));
  // en quittant l'élément, on le libère pour les autres
  useEffect(() => () => releaseEditing(id), [id]);
  if (mode === 'local') return { canWrite: true, holder: null, viewOnly: false, claim: () => {} };
  const viewOnly = role === 'lecture';
  return { canWrite: !viewOnly && !holder, holder, viewOnly, claim: () => claimEditing(id) };
}

/** Ai-je le droit de modifier ce cerveau ? (un invité « peut regarder » ne peut pas) */
export function useCanWrite(): boolean {
  const mode = useSession((s) => s.mode);
  const role = useSession((s) => s.role);
  return mode === 'local' || role !== 'lecture';
}
