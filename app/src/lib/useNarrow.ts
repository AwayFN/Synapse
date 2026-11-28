import { useEffect, useState } from 'react';

const QUERY = '(max-width: 767px)';

/** L'écran est-il celui d'un téléphone (moins de 768 px de large) ? À l'instant présent, hors de React. */
export function isNarrow() {
  return typeof window !== 'undefined' && window.matchMedia(QUERY).matches;
}

/** L'écran est-il celui d'un téléphone (moins de 768 px de large) ? Suit la rotation et le redimensionnement. */
export function useNarrow() {
  const [narrow, setNarrow] = useState(isNarrow);
  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

/**
 * Le fond sombre des vues plein écran : sur ordinateur, un clic dessus (autour de la vue) ramène au réseau, comme avant.
 * Sur téléphone, la vue occupe tout l'écran : un doigt qui tombe entre deux lignes ne doit pas la fermer.
 */
export function outsideClick(close: () => void) {
  return () => {
    if (!isNarrow()) close();
  };
}
