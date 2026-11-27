import { create } from 'zustand';
import { readJson, writeKey } from './storage';

/**
 * Les réglages du réseau de neurones, gardés sur cet appareil :
 *  - la distance entre les neurones liés (un lien, ou une tâche / note / créneau et son projet) et entre les neurones
 *    non liés, chacune réglable (1 = la distance de la V7 ; par défaut un peu plus rapproché : 0,85) ;
 *  - les neurones déplacés à la main : ils restent exactement où on les a posés (le reste du réseau s'organise autour).
 */
export const SPACING_DEFAULT = 0.85;
export const SPACING_MIN = 0.4;
export const SPACING_MAX = 1.6;

const SETTINGS_KEY = 'synapse-reseau';
const PIN_KEY = 'synapse-layout-fixes';

const clampSpacing = (v: unknown) => {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : SPACING_DEFAULT;
  return Math.round(Math.min(SPACING_MAX, Math.max(SPACING_MIN, n)) * 100) / 100;
};

interface NetworkState {
  /** distance entre neurones liés (facteur : 1 = V7) */
  linked: number;
  /** distance entre neurones non liés (facteur : 1 = V7) */
  unlinked: number;
  /** neurones placés à la main (id → true) */
  pinned: Record<string, true>;
  setSpacing: (p: { linked?: number; unlinked?: number }) => void;
  resetSpacing: () => void;
  pin: (id: string) => void;
  unpin: (id: string) => void;
  unpinAll: () => void;
  /** remplace la liste (import d'un fichier) */
  setPinned: (ids: string[]) => void;
}

const saved = readJson<{ linked?: number; unlinked?: number }>(SETTINGS_KEY, {});
const savedPins = readJson<unknown>(PIN_KEY, []);

const saveSettings = (s: { linked: number; unlinked: number }) => writeKey(SETTINGS_KEY, JSON.stringify({ linked: s.linked, unlinked: s.unlinked }));
const savePins = (p: Record<string, true>) => writeKey(PIN_KEY, JSON.stringify(Object.keys(p)));

export const useNetwork = create<NetworkState>()((set, get) => ({
  linked: clampSpacing(saved.linked),
  unlinked: clampSpacing(saved.unlinked),
  pinned: Object.fromEntries((Array.isArray(savedPins) ? savedPins : []).filter((x): x is string => typeof x === 'string').map((id) => [id, true as const])),

  setSpacing: (p) => {
    const next = { linked: p.linked !== undefined ? clampSpacing(p.linked) : get().linked, unlinked: p.unlinked !== undefined ? clampSpacing(p.unlinked) : get().unlinked };
    set(next);
    saveSettings(next);
  },
  resetSpacing: () => {
    const next = { linked: SPACING_DEFAULT, unlinked: SPACING_DEFAULT };
    set(next);
    saveSettings(next);
  },
  pin: (id) => {
    if (get().pinned[id]) return;
    const pinned = { ...get().pinned, [id]: true as const };
    set({ pinned });
    savePins(pinned);
  },
  unpin: (id) => {
    if (!get().pinned[id]) return;
    const pinned = { ...get().pinned };
    delete pinned[id];
    set({ pinned });
    savePins(pinned);
  },
  unpinAll: () => {
    set({ pinned: {} });
    savePins({});
  },
  setPinned: (ids) => {
    const pinned = Object.fromEntries(ids.map((id) => [id, true as const]));
    set({ pinned });
    savePins(pinned);
  },
}));
