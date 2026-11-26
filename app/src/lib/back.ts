import { useEffect, useRef } from 'react';
import { useUI } from '../store/ui';
import { useSession } from '../sync/session';

/**
 * « Retour » : la touche Échap (ordinateur) et le bouton retour (téléphone Android) ferment ce qui est ouvert,
 * du plus haut au plus bas, partout : palette, aide, fenêtres (compte, admin, partage, retours), éditeur, sous-
 * panneaux (lier à…, créneau de l'emploi du temps), vues, fiche. Renvoie false s'il n'y avait rien à fermer.
 *
 * Un composant qui ouvre sa propre couche s'inscrit avec useBackLayer(ouvert, fermer, niveau) ; le niveau dit ce
 * qui est au-dessus de quoi (même ordre que l'affichage).
 */
export const LEVEL = {
  palette: 100,
  help: 95,
  terms: 96,
  feedback: 90,
  dialog: 85,
  /** dans l'éditeur en grand (lier à…) */
  inEditor: 55,
  editor: 50,
  /** dans une vue : le panneau d'un créneau de l'emploi du temps */
  inView: 40,
  view: 30,
  /** dans la fiche (lier à…) */
  inPanel: 25,
  panel: 20,
} as const;

interface Layer {
  level: number;
  close: () => void;
  order: number;
}
const layers = new Set<Layer>();
let counter = 0;

/** Inscrit une couche tant qu'elle est ouverte */
export function useBackLayer(open: boolean, close: () => void, level: number) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!open) return;
    const layer: Layer = { level, close: () => ref.current(), order: ++counter };
    layers.add(layer);
    return () => {
      layers.delete(layer);
    };
  }, [open, level]);
}

const blur = () => {
  const el = document.activeElement as HTMLElement | null;
  if (el && el !== document.body && typeof el.blur === 'function') el.blur();
};

function typing() {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

export function goBack(): boolean {
  const ui = useUI.getState();
  const ss = useSession.getState();
  const candidates: { level: number; order: number; run: () => void }[] = [];
  const add = (on: boolean, level: number, run: () => void) => {
    if (on) candidates.push({ level, order: 0, run });
  };
  add(ui.paletteOpen, LEVEL.palette, () => ui.closePalette());
  add(ui.helpOpen, LEVEL.help, () => ui.setHelp(false));
  add(ss.feedbackOpen, LEVEL.feedback, () => useSession.setState({ feedbackOpen: false }));
  add(ss.adminOpen, LEVEL.dialog, () => useSession.setState({ adminOpen: false }));
  add(ss.shareOpen, LEVEL.dialog, () => useSession.setState({ shareOpen: false }));
  add(ss.accountOpen, LEVEL.dialog, () => useSession.setState({ accountOpen: false }));
  add(!!ui.editorId, LEVEL.editor, () => ui.closeEditor());
  add(ui.view !== 'network', LEVEL.view, () => ui.setView('network'));
  add(!!ui.selectedId && ui.view === 'network', LEVEL.panel, () => ui.closePanel());
  add(typing(), 5, () => {});
  add(!!ui.focusId, 3, () => ui.setFocus(null));
  add(ui.activeTags.length > 0, 2, () => ui.clearTags());
  for (const l of layers) candidates.push({ level: l.level, order: l.order, run: l.close });
  if (!candidates.length) return false;
  // la couche la plus haute ; à niveau égal, la plus récente (un sous-panneau passe avant ce qui le contient)
  candidates.sort((a, b) => b.level - a.level || b.order - a.order);
  blur();
  candidates[0].run();
  return true;
}

let installed = false;
/** Échap partout (y compris sur les écrans de connexion), et le bouton retour de l'application Android */
export function installBack() {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    if (goBack()) e.preventDefault();
  });
  (window as unknown as { __synapseBack?: () => boolean }).__synapseBack = () => goBack();
}
