import type { Entity, Link } from '../types';
import { useSession } from './session';

/**
 * Ce que je peux faire dans ce cerveau. Le serveur applique les mêmes règles :
 * ici elles servent seulement à ne pas proposer ce qui serait refusé.
 *   lecture       : explorer, chercher, lire
 *   contribution  : capturer, relier ; modifier et supprimer seulement ce qu'on a créé soi-même
 *   édition       : tout modifier (sauf le privé, le partage, l'export)
 *   propriétaire  : tout
 */
const st = () => useSession.getState();
const mine = (by?: string) => (by || 'owner') === st().me.id;

export const can = {
  write: () => st().role !== 'lecture',
  editAll: () => st().role === 'owner' || st().role === 'edition',
  edit: (e?: Entity | null) => !!e && (can.editAll() || (st().role === 'contribution' && mine(e.createdBy))),
  link: () => st().role !== 'lecture',
  unlink: (l?: Link | null) => !!l && (can.editAll() || (st().role === 'contribution' && mine(l.createdBy))),
  natures: () => can.editAll(),
  private: () => st().role === 'owner',
  manage: () => st().role === 'owner',
};

/** Pour les composants : se redessinent quand mes droits changent */
export function useCan() {
  useSession((s) => `${s.role}|${s.me.id}|${s.mode}`);
  return can;
}
