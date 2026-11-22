import { create } from 'zustand';
import type { Nature, ViewMode } from '../types';
import { uid } from '../lib/random';
import { natureOf } from '../lib/kinds';
import { displayTitle } from '../lib/entity';
import { useData } from './data';
import { findLink } from './graph';
import { can } from '../sync/perm';

export interface Toast {
  id: string;
  text: string;
  color?: string;
  action?: { label: string; run: () => void };
}

export interface UIState {
  view: ViewMode;
  /** neurone affiché dans le panneau latéral */
  selectedId: string | null;
  /** neurone ouvert dans l'éditeur plein écran */
  editorId: string | null;
  /** neurone autour duquel la caméra orbite */
  focusId: string | null;
  hoveredId: string | null;
  paletteOpen: boolean;
  paletteSeed: string;
  helpOpen: boolean;
  activeTags: string[];
  hiddenNatures: Nature[];
  /** n'éclairer que les neurones sans aucune connexion */
  orphansOnly: boolean;
  /** résultats de recherche à éclairer dans le réseau (null = pas de recherche) */
  searchHits: Set<string> | null;
  /** fil de pensée : les neurones visités, dans l'ordre */
  trail: string[];
  trailPos: number;
  toasts: Toast[];

  setView: (v: ViewMode) => void;
  toggleView: (v: ViewMode) => void;
  /** Ouvre un neurone dans le panneau (la caméra y vole) ; une connexion empruntée se renforce */
  openEntity: (id: string, opts?: { fly?: boolean; via?: 'trail' }) => void;
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
  toggleNature: (n: Nature) => void;
  setOrphansOnly: (on: boolean) => void;
  setSearchHits: (hits: Set<string> | null) => void;
  back: () => void;
  forward: () => void;
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
  hiddenNatures: [],
  orphansOnly: false,
  searchHits: null,
  trail: [],
  trailPos: -1,
  toasts: [],

  setView: (v) => set({ view: v }),
  toggleView: (v) => set((s) => ({ view: s.view === v ? 'network' : v })),

  openEntity: (id, opts) => {
    const d = useData.getState();
    const e = d.entities[id];
    if (!e) return;
    const st = get();
    const prev = st.selectedId ?? st.editorId;
    if (prev && prev !== id && findLink(d.links, prev, id)) d.strengthen(prev, id, 0.06);
    d.touch(id);
    let { trail, trailPos } = st;
    if (opts?.via !== 'trail' && trail[trailPos] !== id) {
      trail = [...trail.slice(0, trailPos + 1).filter((x) => x !== id), id].slice(-16);
      trailPos = trail.length - 1;
    }
    const nature = natureOf(e, d.kinds);
    set({
      view: 'network',
      selectedId: id,
      editorId: null,
      focusId: opts?.fly === false ? st.focusId : id,
      hiddenNatures: st.hiddenNatures.filter((n) => n !== nature),
      trail,
      trailPos,
    });
  },
  select: (id) => set({ selectedId: id }),
  closePanel: () => set({ selectedId: null, focusId: null }),
  setFocus: (id) => set({ focusId: id }),
  setHovered: (id) => {
    if (get().hoveredId !== id) set({ hoveredId: id });
  },
  openEditor: (id) => {
    useData.getState().touch(id);
    set({ editorId: id, selectedId: id, focusId: id, view: 'network' });
  },
  closeEditor: () => {
    const id = get().editorId;
    set({ editorId: null });
    if (!id) return;
    // un brouillon vide, tout juste créé, disparaît au lieu d'encombrer le réseau
    const d = useData.getState();
    const n = d.entities[id];
    const hasLinks = d.links.some((l) => l.a === id || l.b === id);
    if (n && !n.title.trim() && !n.body.trim() && !n.tags.length && !hasLinks && Date.now() - n.createdAt < 15 * 60000) {
      d.remove(id, { silent: true });
      set({ selectedId: null, focusId: null });
    }
  },
  openPalette: (seed = '') => set({ paletteOpen: true, paletteSeed: seed }),
  closePalette: () => set({ paletteOpen: false, paletteSeed: '', searchHits: null }),
  setHelp: (open) => set({ helpOpen: open }),
  toggleTag: (tag) =>
    set((s) => ({
      activeTags: s.activeTags.includes(tag) ? s.activeTags.filter((t) => t !== tag) : [...s.activeTags, tag],
    })),
  clearTags: () => set({ activeTags: [] }),
  toggleNature: (n) =>
    set((s) => ({
      hiddenNatures: s.hiddenNatures.includes(n) ? s.hiddenNatures.filter((x) => x !== n) : [...s.hiddenNatures, n],
    })),
  setOrphansOnly: (on) => set({ orphansOnly: on }),
  setSearchHits: (hits) => set({ searchHits: hits }),
  back: () => {
    const { trail, trailPos } = get();
    const ents = useData.getState().entities;
    for (let p = trailPos - 1; p >= 0; p--) {
      if (ents[trail[p]]) {
        set({ trailPos: p });
        get().openEntity(trail[p], { via: 'trail' });
        return;
      }
    }
  },
  forward: () => {
    const { trail, trailPos } = get();
    const ents = useData.getState().entities;
    for (let p = trailPos + 1; p < trail.length; p++) {
      if (ents[trail[p]]) {
        set({ trailPos: p });
        get().openEntity(trail[p], { via: 'trail' });
        return;
      }
    }
  },
  toast: (t, ms) => {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    window.setTimeout(() => get().dismissToast(id), ms ?? (t.action ? 6500 : 3200));
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Suppression avec annulation */
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
      text: `SUPPRIMÉ · ${displayTitle(snap.entity)}`,
      color: '#ff4d7a',
      action: { label: 'ANNULER', run: () => useData.getState().restore(snap) },
    });
  }
}

/** Relier / délier deux neurones (Maj+clic dans le réseau) */
export function toggleLink(a: string, b: string) {
  const d = useData.getState();
  const ea = d.entities[a];
  const eb = d.entities[b];
  if (!ea || !eb || a === b || !can.link()) return;
  const ui = useUI.getState();
  const existing = findLink(d.links, a, b);
  if (existing && !can.unlink(existing)) {
    ui.toast({ text: 'CE LIEN NE T’APPARTIENT PAS : TU NE PEUX PAS LE RETIRER' });
    return;
  }
  if (existing) {
    d.unlink(a, b);
    ui.toast({
      text: `DÉLIÉ · ${displayTitle(ea)} ↔ ${displayTitle(eb)}`,
      action: { label: 'ANNULER', run: () => useData.getState().link(a, b) },
    });
  } else {
    d.link(a, b);
    ui.toast({
      text: `RELIÉ · ${displayTitle(ea)} ↔ ${displayTitle(eb)}`,
      action: { label: 'ANNULER', run: () => useData.getState().unlink(a, b) },
    });
  }
}
