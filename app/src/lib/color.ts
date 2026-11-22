/** Neon palette tuned for a pure black background */
export const NEON = [
  '#ff2e88', // hot pink
  '#00e5ff', // cyan
  '#a855f7', // violet
  '#39ff88', // neon green
  '#ffb020', // amber
  '#3d7bff', // electric blue
  '#ff5a36', // coral
  '#e879f9', // orchid
  '#2dd4bf', // teal
  '#facc15', // yellow
  '#ff4d6d', // red pink
  '#7cf03c', // lime
  '#60a5fa', // sky
  '#f472b6', // light pink
  '#c084fc', // lavender
  '#fb923c', // orange
];

/** Rouge néon des alertes (suppression, erreur) */
export const ALERT_HEX = '#ff4d6d';

export const TYPE_ACCENT = {
  project: '#ff2e88',
  task: '#00e5ff',
  note: '#a855f7',
  slot: '#ffb020',
} as const;

/** Pick the least used palette color (ties broken by palette order, with an offset for variety) */
export function pickColor(used: string[], offset = 0): string {
  const counts = new Map<string, number>();
  for (const c of NEON) counts.set(c, 0);
  for (const c of used) {
    const k = c.toLowerCase();
    if (counts.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = NEON[0];
  let bestCount = Infinity;
  for (let i = 0; i < NEON.length; i++) {
    const c = NEON[(i + offset) % NEON.length];
    const n = counts.get(c) ?? 0;
    if (n < bestCount) {
      best = c;
      bestCount = n;
    }
  }
  return best;
}

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
