/**
 * Tiny event bus between the data layer / UI and the 3D scene.
 * Visual effects only — nothing here is persisted.
 */
export type FxEvent =
  | { kind: 'birth'; id: string; near?: string | null }
  | { kind: 'celebrate'; id: string }
  | { kind: 'touch'; id: string }
  | { kind: 'link'; a: string; b: string }
  | { kind: 'death'; id: string }
  | { kind: 'overview' };

type Listener = (e: FxEvent) => void;
const listeners = new Set<Listener>();
const lastTouch = new Map<string, number>();

export const fx = {
  emit(e: FxEvent) {
    if (e.kind === 'touch') {
      // throttle "data changed" pulses (typing fires this on every keystroke)
      const now = performance.now();
      if (now - (lastTouch.get(e.id) ?? 0) < 700) return;
      lastTouch.set(e.id, now);
    }
    for (const l of listeners) l(e);
  },
  on(l: Listener) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};
