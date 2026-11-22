import { create } from 'zustand';
import type { EntityType, ViewMode } from '../types';
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
  /** note open in the full-screen editor */
  editorId: string | null;
  /** constellation the camera orbits / follows */
  focusId: string | null;
  hoveredId: string | null;
  paletteOpen: boolean;
  paletteSeed: string;
  helpOpen: boolean;
  activeTags: string[];
  hiddenTypes: EntityType[];
  toasts: Toast[];

  setView: (v: ViewMode) => void;
  toggleView: (v: ViewMode) => void;
  /** Open an entity wherever it belongs: notes → editor, others → side panel (+ camera flies to it) */
  openEntity: (id: string, opts?: { fly?: boolean }) => void;
  select: (id: string | null) => void;
  closePanel: () => void;
  setFocus: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  openEditor: (id: string) => void;
  closeEditor: () => void;
  openPalette: (seed?: string) => void;
  closePalette: () => void;
  setHelp: (open: boolean) => void;
  toggleTag: (tag: string) => void;
  clearTags: () => void;
  toggleType: (t: EntityType) => void;
  toast: (t: Omit<Toast, 'id'>, ms?: number) => void;
  dismissToast: (id: string) => void;
}

export const useUI = create<UIState>()((set, get) => ({
  view: 'network',
  selectedId: null,
  editorId: null,
  focusId: null,
  hoveredId: null,
  paletteOpen: false,
  paletteSeed: '',
  helpOpen: false,
  activeTags: [],
  hiddenTypes: [],
  toasts: [],

  setView: (v) => set({ view: v }),
  toggleView: (v) => set((s) => ({ view: s.view === v ? 'network' : v })),

  openEntity: (id, opts) => {
    const e = useData.getState().entities[id];
    if (!e) return;
    const fly = opts?.fly ?? true;
    const hidden = get().hiddenTypes.filter((t) => t !== e.type);
    if (e.type === 'note') {
      set({ view: 'network', editorId: id, selectedId: null, focusId: fly ? id : get().focusId, hiddenTypes: hidden });
    } else {
      set({ view: 'network', selectedId: id, editorId: null, focusId: fly ? id : get().focusId, hiddenTypes: hidden });
    }
  },
  select: (id) => set({ selectedId: id }),
  closePanel: () => set({ selectedId: null, focusId: null }),
  setFocus: (id) => set({ focusId: id }),
  setHovered: (id) => {
    if (get().hoveredId !== id) set({ hoveredId: id });
  },
  openEditor: (id) => set({ editorId: id, selectedId: null, focusId: id, view: 'network' }),
  closeEditor: () => {
    const id = get().editorId;
    set({ editorId: null });
    if (id) {
      // an untouched empty note disappears instead of cluttering the network
      const d = useData.getState();
      const n = d.entities[id];
      const hasLinks = d.links.some((l) => l.a === id || l.b === id);
      if (n && n.type === 'note' && !n.title.trim() && !n.content.trim() && !n.tags.length && !hasLinks) {
        d.remove(id, { silent: true });
        set({ focusId: null });
      }
    }
  },
  openPalette: (seed = '') => set({ paletteOpen: true, paletteSeed: seed }),
  closePalette: () => set({ paletteOpen: false, paletteSeed: '' }),
  setHelp: (open) => set({ helpOpen: open }),
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
