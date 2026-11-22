import { useData } from '../store/data';
import { useUI } from '../store/ui';

/** Nouvelle pensée vide, ouverte directement dans l'éditeur plein écran */
export function newThought(title = '') {
  const ui = useUI.getState();
  const context = ui.selectedId && useData.getState().entities[ui.selectedId] ? [ui.selectedId] : [];
  const n = useData.getState().create({ title }, { linkTo: context, origin: 'capture', strength: 0.55 });
  ui.openEditor(n.id);
  return n;
}
