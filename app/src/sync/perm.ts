import { useSession } from './session';

/**
 * Ce que je peux faire dans ce cerveau. Le serveur applique les mêmes règles :
 * ici elles servent seulement à ne pas proposer ce qui serait refusé.
 *   peut regarder (lecture) : explorer, chercher, lire
 *   peut modifier (édition) : tout modifier, créer, relier, supprimer (sauf le partage)
 *   propriétaire            : tout
 */
const st = () => useSession.getState();

export const can = {
  write: () => st().role === 'owner' || st().role === 'edition',
  private: () => st().role === 'owner',
  manage: () => st().role === 'owner',
};

/** Pour les composants : se redessinent quand mes droits changent */
export function useCan() {
  useSession((s) => `${s.role}|${s.me.id}|${s.mode}`);
  return can;
}
