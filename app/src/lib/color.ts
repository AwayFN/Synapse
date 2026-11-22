import type { Nature } from '../types';
import { ALERT_HEX, NATURES } from './kinds';

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** "#ff2e88" -> "255 46 136" for rgb(var(--c) / a) usage */
export function rgbTriplet(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `${r} ${g} ${b}`;
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Couleur d'un ton du journal d'activité / des notifications */
export function toneHex(tone: Nature | 'alert' | 'system'): string {
  if (tone === 'alert') return ALERT_HEX;
  if (tone === 'system') return NATURES.pensee.hex;
  return NATURES[tone].hex;
}
