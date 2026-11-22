import type { CSSProperties, ReactNode } from 'react';
import { rgbTriplet } from '../lib/color';

export function Corners() {
  return (
    <>
      <i className="pc tl" />
      <i className="pc tr" />
      <i className="pc bl" />
      <i className="pc br" />
    </>
  );
}

/** Sets --c (rgb triplet) from a hex color for neon accents */
export function cvar(hex: string, extra?: CSSProperties): CSSProperties {
  return { '--c': rgbTriplet(hex), ...extra } as CSSProperties;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function useIsMac() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}
