import type { StateStorage } from 'zustand/middleware';
import { desktop, type DesktopStorage } from '../lib/device';

/**
 * Où vivent les données : sur l'appareil, et nulle part ailleurs.
 *  - application Windows : un fichier dans %APPDATA%\Synapse (avec une sauvegarde par jour), par l'application elle-même ;
 *  - application Android (et navigateur, en développement) : le stockage local de la page, dans le téléphone.
 *
 * L'état change en mémoire à chaque frappe ; il est écrit au plus toutes les 200 ms, et tout de suite quand la fenêtre
 * se cache ou se ferme : rien ne se perd.
 */
type Backend = Pick<DesktopStorage, 'getItem' | 'setItem' | 'removeItem'> & { flush?: () => void };

let backendCache: Backend | null = null;
function backend(): Backend | null {
  if (backendCache) return backendCache;
  const d = desktop();
  if (d?.storage) return (backendCache = d.storage);
  try {
    if (typeof localStorage !== 'undefined') return (backendCache = localStorage);
  } catch {
    /* stockage indisponible : rien ne sera gardé */
  }
  return null;
}

const pending = new Map<string, string>();
let timer: number | undefined;
let onError: ((e: unknown) => void) | null = null;

export function setStorageErrorHandler(fn: (e: unknown) => void) {
  onError = fn;
}

export function flushStorage() {
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
  const b = backend();
  for (const [k, v] of pending) {
    try {
      b?.setItem(k, v);
    } catch (e) {
      onError?.(e);
    }
  }
  pending.clear();
  try {
    b?.flush?.();
  } catch (e) {
    onError?.(e);
  }
}

/** Lire une valeur gardée sur l'appareil (réglages, positions des neurones…) */
export function readKey(name: string): string | null {
  if (pending.has(name)) return pending.get(name)!;
  try {
    return backend()?.getItem(name) ?? null;
  } catch {
    return null;
  }
}

/** Garder une valeur sur l'appareil (écrite avec le reste, sans attendre) */
export function writeKey(name: string, value: string) {
  pending.set(name, value);
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(flushStorage, 200);
}

export function readJson<T>(name: string, fallback: T): T {
  const raw = readKey(name);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export const debouncedStorage: StateStorage = {
  getItem: (name) => readKey(name),
  setItem: (name, value) => writeKey(name, value),
  removeItem: (name) => {
    pending.delete(name);
    try {
      backend()?.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', flushStorage);
  window.addEventListener('pagehide', flushStorage);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushStorage();
  });
}
