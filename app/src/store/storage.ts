import type { StateStorage } from 'zustand/middleware';

/**
 * localStorage adapter with a short write debounce: state is updated in memory
 * on every keystroke, and flushed to disk at most every 200 ms — plus a forced
 * flush whenever the page is hidden or closed, so nothing is ever lost.
 *
 * In "memory" mode (a guest visiting someone else's brain) nothing is written:
 * the owner's thoughts never stay on the guest's computer.
 */
const pending = new Map<string, string>();
let timer: number | undefined;
let onError: ((e: unknown) => void) | null = null;
let memoryOnly = false;

export function setStorageErrorHandler(fn: (e: unknown) => void) {
  onError = fn;
}

export const isMemoryOnly = () => memoryOnly;

export function setMemoryOnly(on: boolean) {
  memoryOnly = on;
  if (on) {
    pending.clear();
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
  }
}

export function flushStorage() {
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
  if (memoryOnly) return pending.clear();
  for (const [k, v] of pending) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {
      onError?.(e);
    }
  }
  pending.clear();
}

export const debouncedStorage: StateStorage = {
  getItem: (name) => {
    if (memoryOnly) return null;
    if (pending.has(name)) return pending.get(name)!;
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    if (memoryOnly) return;
    pending.set(name, value);
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(flushStorage, 200);
  },
  removeItem: (name) => {
    pending.delete(name);
    if (memoryOnly) return;
    try {
      localStorage.removeItem(name);
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
