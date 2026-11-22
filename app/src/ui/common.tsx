import type { CSSProperties, ReactNode } from 'react';
import type { Entity, Link, Nature } from '../types';
import { rgbTriplet } from '../lib/color';
import { ALERT_HEX, isHubKind, natureOf, NATURES, type KindRegistry } from '../lib/kinds';
import { isLate, isPast } from '../lib/entity';
import { useData } from '../store/data';

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

/** Pose --c (triplet rgb) à partir d'une couleur hexadécimale */
export function cvar(hex: string, extra?: CSSProperties): CSSProperties {
  return { '--c': rgbTriplet(hex), ...extra } as CSSProperties;
}

export function natureVar(n: Nature, extra?: CSSProperties): CSSProperties {
  return cvar(NATURES[n].hex, extra);
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function useKinds(): KindRegistry {
  return useData((s) => s.kinds);
}

export function useNature(e: Entity | undefined | null): Nature {
  const kinds = useKinds();
  return natureOf(e, kinds);
}

/** Branches d'un petit neurone : angles et longueurs fixes, pour que l'icône reste nette */
function branchPaths(n: number, done: boolean): { d: string; tip: boolean }[] {
  const out: { d: string; tip: boolean }[] = [];
  const reach = done ? 8.2 : 10.6;
  for (let k = 0; k < n; k++) {
    const a = -Math.PI / 2 - 0.35 + (k * Math.PI * 2) / n + (k % 2 ? 0.18 : -0.12);
    const len = reach * (k % 3 === 1 ? 0.86 : 1);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const bend = k % 2 ? 1.4 : -1.4;
    const x0 = ca * 4.4;
    const y0 = sa * 4.4;
    const mx = ca * ((4.4 + len) / 2) - sa * bend;
    const my = sa * ((4.4 + len) / 2) + ca * bend;
    const x1 = ca * len - sa * bend * 0.6;
    const y1 = sa * len + ca * bend * 0.6;
    out.push({ d: `M${x0.toFixed(2)} ${y0.toFixed(2)} Q${mx.toFixed(2)} ${my.toFixed(2)} ${x1.toFixed(2)} ${y1.toFixed(2)}`, tip: false });
    if (!done && k % 2 === 0) {
      // petite fourche vers le bout
      const fx = ca * len * 0.72 - sa * bend * 0.4;
      const fy = sa * len * 0.72 + ca * bend * 0.4;
      const fa = a + (k % 4 ? 0.7 : -0.7);
      out.push({ d: `M${fx.toFixed(2)} ${fy.toFixed(2)} L${(fx + Math.cos(fa) * 2.6).toFixed(2)} ${(fy + Math.sin(fa) * 2.6).toFixed(2)}`, tip: true });
    }
  }
  return out;
}

/**
 * Le même neurone néon que dans le réseau 3D : un noyau lumineux et ses branches.
 *   couleur = nature · branches = liens (plus il y en a, plus c'est relié) · néon éteint = terminé ·
 *   point rose-rouge = en retard. (`shape` et `hour` sont acceptés pour compatibilité, sans effet.)
 */
export function Glyph({
  nature,
  hub = false,
  done = false,
  alert = false,
  size = 12,
  branches,
}: {
  nature: Nature;
  shape?: number;
  hub?: boolean;
  done?: boolean;
  alert?: boolean;
  size?: number;
  hour?: number | null;
  branches?: number;
}) {
  const c = NATURES[nature].hex;
  const n = Math.max(3, Math.min(8, branches ?? (hub ? 6 : 4)));
  const paths = branchPaths(n, done);
  const glow = !done && size >= 10 ? { filter: `drop-shadow(0 0 ${size >= 16 ? 3 : 2}px ${c}aa)` } : undefined;
  return (
    <svg width={size} height={size} viewBox="-12 -12 24 24" className="flex-none overflow-visible" aria-hidden style={glow}>
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill="none"
          stroke={c}
          strokeOpacity={done ? 0.3 : p.tip ? 0.7 : 0.9}
          strokeWidth={p.tip ? 0.9 : hub ? 1.6 : 1.25}
          strokeLinecap="round"
        />
      ))}
      <circle r={4.4} fill={done ? 'none' : c} fillOpacity={done ? 0 : 0.34} stroke={c} strokeOpacity={done ? 0.45 : 1} strokeWidth={1.4} />
      {!done && <circle r={1.8} fill="#fff" fillOpacity={0.92} />}
      {alert && <circle cx={7.4} cy={-7.4} r={2.6} fill={ALERT_HEX} />}
    </svg>
  );
}

/** Nombre de liens de chaque neurone (calculé une fois par version des liens) */
const degreeCache = new WeakMap<Link[], Map<string, number>>();
function degrees(links: Link[]) {
  let m = degreeCache.get(links);
  if (!m) {
    m = new Map();
    for (const l of links) {
      m.set(l.a, (m.get(l.a) ?? 0) + 1);
      m.set(l.b, (m.get(l.b) ?? 0) + 1);
    }
    degreeCache.set(links, m);
  }
  return m;
}

/** Glyphe d'un neurone, calculé depuis ses données (ses branches = ses liens) */
export function EntityGlyph({ e, size = 12 }: { e: Entity; size?: number }) {
  const kinds = useKinds();
  const links = useData((s) => s.links);
  const deg = degrees(links).get(e.id) ?? 0;
  const hub = isHubKind(e.kind) || deg >= 7;
  return (
    <Glyph
      nature={natureOf(e, kinds)}
      hub={hub}
      done={e.status === 'done' || isPast(e)}
      alert={isLate(e)}
      size={size}
      branches={3 + Math.min(deg, 5)}
    />
  );
}

export function useIsMac() {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}
