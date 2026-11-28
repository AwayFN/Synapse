import { create } from 'zustand';
import { tagsOf, type EntityType, type ViewMode } from '../types';
import { uid } from '../lib/random';
import { useData } from './data';

export interface Toast {
  id: string;
  text: string;
  color?: string;
  action?: { label: string; run: () => void };
}

export interface UIState {
  view: ViewMode;
  /** entity shown in the side panel */
  selectedId: string | null;
  /** élément ouvert dans l'éditeur en grand (une note, ou la description d'une tâche, d'un projet, d'un créneau) */
  editorId: string | null;
  /** constellation the camera orbits / follows */
  focusId: string | null;
  hoveredId: string | null;
  paletteOpen: boolean;
  paletteSeed: string;
  helpOpen: boolean;
  /** les réglages du réseau (distance entre les neurones, neurones déplacés à la main) */
  networkOpen: boolean;
  activeTags: string[];
  hiddenTypes: EntityType[];
  toasts: Toast[];
  /** téléphone : panneaux plein écran ouverts à l'intérieur d'une vue (agenda…) ; la barre des vues s'efface tant qu'il y en a */
  navCovers: number;

  setView: (v: ViewMode) => void;
  toggleView: (v: ViewMode) => void;
  /**
   * Open an entity wherever it belongs: notes → editor, others → side panel (+ camera flies to it).
   * keepView (V8.1) : depuis une vue (tâches, notes…), la fiche s'ouvre par-dessus, sans quitter la vue.
   */
  openEntity: (id: string, opts?: { fly?: boolean; keepView?: boolean }) => void;
  /** la vue où la fiche ouverte a été ouverte (elle ne s'affiche que là) */
  panelView: ViewMode;
  select: (id: string | null) => void;
  closePanel: () => void;
  setFocus: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  /** l'éditeur en grand ; keepView : reste dans la vue ouverte (notes, tâches, agenda) au lieu du réseau */
  openEditor: (id: string, opts?: { keepView?: boolean }) => void;
  closeEditor: () => void;
  openPalette: (seed?: string) => void;
  closePalette: () => void;
  setHelp: (open: boolean) => void;
  setNetworkOpen: (open: boolean) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  toggleType: (t: EntityType) => void;
  toast: (t: Omit<Toast, 'id'>, ms?: number) => void;
  dismissToast: (id: string) => void;
}

/** Les réglages du réseau ne se montrent (et ne comptent pour Échap et Tab) que sur le réseau, sans éditeur ouvert */
export const networkSettingsVisible = (s: Pick<UIState, 'networkOpen' | 'view' | 'editorId'>) => s.networkOpen && s.view === 'network' && !s.editorId;

/** La fiche d'un élément est-elle à l'écran ? (ouverte, et dans la vue où on l'a ouverte) */
export const panelVisible = (s: Pick<UIState, 'selectedId' | 'view' | 'panelView'>) => !!s.selectedId && s.view === s.panelView;

export const useUI = create<UIState>()((set, get) => ({
  view: 'network',
  panelView: 'network',
  selectedId: null,
  editorId: null,
  focusId: null,
  hoveredId: null,
  paletteOpen: false,
  paletteSeed: '',
  helpOpen: false,
  networkOpen: false,
  activeTags: [],
  hiddenTypes: [],
  toasts: [],
  navCovers: 0,

  setView: (v) => set({ view: v }),
  toggleView: (v) => set((s) => ({ view: s.view === v ? 'network' : v })),

  openEntity: (id, opts) => {
    const e = useData.getState().entities[id];
    if (!e) return;
    const view = get().view;
    // depuis une vue : on y reste (la fiche, ou l'éditeur d'une note, s'ouvre par-dessus)
    if (opts?.keepView && view !== 'network') {
      if (e.type === 'note') set({ editorId: id, selectedId: null });
      else set({ selectedId: id, panelView: view, editorId: null });
      return;
    }
    const fly = opts?.fly ?? true;
    const hidden = get().hiddenTypes.filter((t) => t !== e.type);
    if (e.type === 'note') {
      set({ view: 'network', editorId: id, selectedId: null, focusId: fly ? id : get().focusId, hiddenTypes: hidden });
    } else {
      set({ view: 'network', panelView: 'network', selectedId: id, editorId: null, focusId: fly ? id : get().focusId, hiddenTypes: hidden });
    }
  },
  select: (id) => set({ selectedId: id, panelView: get().view }),
  closePanel: () => set({ selectedId: null, focusId: null }),
  setFocus: (id) => set({ focusId: id }),
  setHovered: (id) => {
    if (get().hoveredId !== id) set({ hoveredId: id });
  },
  openEditor: (id, opts) => {
    const e = useData.getState().entities[id];
    if (!e) return;
    if (e.type === 'note') set({ editorId: id, selectedId: null, focusId: id, ...(opts?.keepView ? {} : { view: 'network' as ViewMode }) });
    // une tâche, un projet, un créneau : en fermant l'éditeur, on retrouve sa fiche (ou la vue d'où l'on vient)
    else set({ editorId: id });
  },
  closeEditor: () => {
    const id = get().editorId;
    set({ editorId: null });
    if (id) {
      // an untouched empty note disappears instead of cluttering the network
      const d = useData.getState();
      const n = d.entities[id];
      const hasLinks = d.links.some((l) => l.a === id || l.b === id);
      if (n && n.type === 'note' && !n.title.trim() && !n.content.trim() && !tagsOf(n).length && !n.projectId && !hasLinks) {
        d.remove(id, { silent: true });
        if (get().focusId === id) set({ focusId: null });
      }
    }
  },
  openPalette: (seed = '') => set({ paletteOpen: true, paletteSeed: seed }),
  closePalette: () => set({ paletteOpen: false, paletteSeed: '' }),
  setHelp: (open) => set({ helpOpen: open }),
  setNetworkOpen: (open) => set({ networkOpen: open }),
  toggleTag: (tag) =>
    set((s) => ({
      activeTags: s.activeTags.includes(tag) ? s.activeTags.filter((t) => t !== tag) : [...s.activeTags, tag],
    })),
  clearTags: () => set({ activeTags: [] }),
  toggleType: (t) =>
    set((s) => ({
      hiddenTypes: s.hiddenTypes.includes(t) ? s.hiddenTypes.filter((x) => x !== t) : [...s.hiddenTypes, t],
    })),
  toast: (t, ms) => {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    window.setTimeout(() => get().dismissToast(id), ms ?? (t.action ? 6500 : 3200));
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Delete with an undo toast */
export function removeWithUndo(id: string) {
  const snap = useData.getState().remove(id);
  const ui = useUI.getState();
  if (ui.selectedId === id || ui.editorId === id || ui.focusId === id) {
    useUI.setState({
      selectedId: ui.selectedId === id ? null : ui.selectedId,
      editorId: ui.editorId === id ? null : ui.editorId,
      focusId: ui.focusId === id ? null : ui.focusId,
    });
  }
  if (snap) {
    ui.toast({
      text: `SUPPRIMÉ · ${snap.entity.title || 'Sans titre'}`,
      color: '#ff4d6d',
      action: { label: 'ANNULER', run: () => useData.getState().restore(snap) },
    });
  }
}
