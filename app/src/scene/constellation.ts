import * as THREE from 'three';
import type { EntityType } from '../types';
import { gaussian, hashString, mulberry32 } from '../lib/random';

/** Particles per constellation before density scaling */
export const BASE_COUNT: Record<EntityType, number> = { project: 380, note: 240, task: 150, slot: 160 };

export interface CGeo {
  count: number;
  /** local rest positions (relative to the nucleus) */
  local: Float32Array;
  /** where each particle starts during the birth animation */
  scatter: Float32Array;
  /** linear rgb */
  colors: Float32Array;
  sizes: Float32Array;
  phases: Float32Array;
  /** birth delay 0..0.4 */
  delays: Float32Array;
  /** pairs of local indices: the neural web inside the constellation */
  web: number[];
  axis: THREE.Vector3;
  spin: number;
}

export function densityFor(types: EntityType[]): number {
  const total = types.reduce((s, t) => s + BASE_COUNT[t], 0);
  if (total <= 7000) return 1;
  if (total <= 10000) return 0.72;
  if (total <= 15000) return 0.5;
  if (total <= 23000) return 0.34;
  return 0.22;
}

const v = new THREE.Vector3();

function randomUnit(rng: () => number, out: THREE.Vector3) {
  const u = rng() * 2 - 1;
  const th = rng() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return out.set(s * Math.cos(th), u, s * Math.sin(th));
}

function perpendicular(dir: THREE.Vector3, rng: () => number, out: THREE.Vector3) {
  randomUnit(rng, out);
  out.addScaledVector(dir, -out.dot(dir));
  if (out.lengthSq() < 1e-6) out.set(dir.y, -dir.x, 0);
  return out.normalize();
}

export function buildConstellation(id: string, type: EntityType, hex: string, density: number, radius: number): CGeo {
  const rng = mulberry32(hashString(id) ^ 0x9e3779b9);
  const count = Math.max(28, Math.round(BASE_COUNT[type] * density));

  const local = new Float32Array(count * 3);
  const scatter = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const delays = new Float32Array(count);
  const web: number[] = [];

  const base = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  const accent = new THREE.Color().setHSL((hsl.h + 0.46 + rng() * 0.1) % 1, 0.9, 0.55);
  const white = new THREE.Color(1, 1, 1);
  const tmp = new THREE.Color();

  let k = 0;
  type Kind = 'soma' | 'branch' | 'ring' | 'tick';
  const put = (x: number, y: number, z: number, kind: Kind, t = 0) => {
    if (k >= count) return -1;
    local[k * 3] = x;
    local[k * 3 + 1] = y;
    local[k * 3 + 2] = z;
    // birth scatter: far out, roughly in the same direction
    randomUnit(rng, v).multiplyScalar(radius * (3.5 + rng() * 6));
    scatter[k * 3] = v.x + x * 2;
    scatter[k * 3 + 1] = v.y + y * 2;
    scatter[k * 3 + 2] = v.z + z * 2;
    const roll = rng();
    let size: number;
    if (kind === 'ring' || kind === 'tick') {
      tmp.copy(base).lerp(white, kind === 'tick' ? 0.55 : 0.3);
      size = kind === 'tick' ? 0.62 : 0.24 + rng() * 0.12;
    } else if (roll < 0.035) {
      tmp.copy(white).lerp(base, 0.15); // sparkle
      size = 0.85 + rng() * 0.6;
    } else if (roll < 0.6) {
      tmp.copy(base).multiplyScalar(0.7 + rng() * 0.45);
      size = 0.2 + rng() * rng() * 0.55;
    } else if (roll < 0.8) {
      tmp.copy(accent).multiplyScalar(0.65 + rng() * 0.45);
      size = 0.18 + rng() * 0.32;
    } else {
      tmp.copy(base).lerp(white, 0.6);
      size = 0.16 + rng() * 0.3;
    }
    if (kind === 'branch') size *= 1 - t * 0.45;
    colors[k * 3] = tmp.r;
    colors[k * 3 + 1] = tmp.g;
    colors[k * 3 + 2] = tmp.b;
    sizes[k] = size * (0.75 + radius / 22);
    phases[k] = rng();
    delays[k] = kind === 'soma' ? rng() * 0.18 : kind === 'branch' ? 0.1 + t * 0.26 + rng() * 0.04 : 0.28 + rng() * 0.1;
    return k++;
  };

  const nRing = type === 'project' ? Math.round(count * 0.15) : type === 'slot' ? 12 + Math.round(count * 0.1) : 0;
  const somaShare = type === 'task' ? 0.6 : type === 'note' ? 0.4 : 0.5;
  const nSoma = Math.round((count - nRing) * somaShare);
  const nBranchTotal = count - nRing - nSoma;

  // ── soma: dense gaussian cloud around the nucleus
  const somaIdx: number[] = [];
  const sig = radius * (type === 'project' ? 0.3 : 0.32);
  for (let i = 0; i < nSoma; i++) {
    let x = gaussian(rng) * sig;
    let y = gaussian(rng) * sig * 0.86;
    let z = gaussian(rng) * sig;
    const l = Math.sqrt(x * x + y * y + z * z);
    const max = radius * 0.95;
    if (l > max) {
      x *= max / l;
      y *= max / l;
      z *= max / l;
    }
    const idx = put(x, y, z, 'soma');
    if (idx >= 0) somaIdx.push(idx);
  }
  // web inside the soma: nearest neighbours
  for (let a = 0; a < somaIdx.length; a++) {
    const ia = somaIdx[a];
    let best = -1;
    let best2 = -1;
    let d1 = Infinity;
    let d2 = Infinity;
    for (let b = 0; b < somaIdx.length; b++) {
      if (a === b) continue;
      const ib = somaIdx[b];
      const dx = local[ia * 3] - local[ib * 3];
      const dy = local[ia * 3 + 1] - local[ib * 3 + 1];
      const dz = local[ia * 3 + 2] - local[ib * 3 + 2];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < d1) {
        d2 = d1;
        best2 = best;
        d1 = d;
        best = ib;
      } else if (d < d2) {
        d2 = d;
        best2 = ib;
      }
    }
    if (best >= 0 && ia < best) web.push(ia, best);
    if (best2 >= 0 && rng() < 0.45) web.push(ia, best2);
  }

  // ── dendrites: curved branching filaments
  const nb = type === 'project' ? 7 : type === 'note' ? 5 : 4;
  const per = Math.max(4, Math.floor(nBranchTotal / nb));
  const dir = new THREE.Vector3();
  const perp = new THREE.Vector3();
  const perp2 = new THREE.Vector3();
  const ctrl = new THREE.Vector3();
  const end = new THREE.Vector3();
  const p = new THREE.Vector3();
  const nearestSoma = (x: number, y: number, z: number) => {
    let best = -1;
    let bd = Infinity;
    for (const i of somaIdx) {
      const dx = local[i * 3] - x;
      const dy = local[i * 3 + 1] - y;
      const dz = local[i * 3 + 2] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  const curve = (
    start: THREE.Vector3, c: THREE.Vector3, e: THREE.Vector3, n: number, t0: number, wavy: boolean, link: number,
  ) => {
    let prev = link;
    let first = -1;
    for (let i = 0; i < n; i++) {
      const t = t0 + (1 - t0) * Math.pow(i / Math.max(1, n - 1), 0.9);
      const it = 1 - t;
      p.set(
        it * it * start.x + 2 * it * t * c.x + t * t * e.x,
        it * it * start.y + 2 * it * t * c.y + t * t * e.y,
        it * it * start.z + 2 * it * t * c.z + t * t * e.z,
      );
      if (wavy) p.addScaledVector(perp2, Math.sin(t * Math.PI * 3.2) * radius * 0.13);
      const j = radius * 0.07 * (1 - 0.5 * t);
      p.x += (rng() - 0.5) * j;
      p.y += (rng() - 0.5) * j;
      p.z += (rng() - 0.5) * j;
      const idx = put(p.x, p.y, p.z, 'branch', t);
      if (idx < 0) break;
      if (first < 0) first = idx;
      if (prev >= 0) web.push(prev, idx);
      prev = idx;
    }
    return first;
  };
  const origin = new THREE.Vector3();
  for (let b = 0; b < nb; b++) {
    randomUnit(rng, dir);
    perpendicular(dir, rng, perp);
    perp2.crossVectors(dir, perp).normalize();
    const len = radius * (type === 'note' ? 1.7 + rng() * 1.0 : type === 'project' ? 1.35 + rng() * 1.0 : 1.2 + rng() * 0.8);
    ctrl.copy(dir).multiplyScalar(len * 0.5).addScaledVector(perp, len * (0.18 + rng() * 0.3));
    end.copy(dir).multiplyScalar(len).addScaledVector(perp2, len * (rng() - 0.5) * 0.3);
    const main = Math.round(per * 0.68);
    const sub = per - main;
    const root = nearestSoma(dir.x * radius * 0.2, dir.y * radius * 0.2, dir.z * radius * 0.2);
    const startK = k;
    curve(origin, ctrl, end, main, 0.14, type === 'note', root);
    // sub-branch from the middle of the main one
    if (sub >= 3 && k > startK + 2) {
      const mid = startK + Math.floor((k - startK) * 0.5);
      const s = new THREE.Vector3(local[mid * 3], local[mid * 3 + 1], local[mid * 3 + 2]);
      const d2 = dir.clone().addScaledVector(perp, rng() < 0.5 ? 0.9 : -0.9).addScaledVector(perp2, (rng() - 0.5) * 0.8).normalize();
      const l2 = len * (0.38 + rng() * 0.2);
      const c2 = s.clone().addScaledVector(d2, l2 * 0.5).addScaledVector(perp2, l2 * 0.2);
      const e2 = s.clone().addScaledVector(d2, l2);
      curve(s, c2, e2, sub, 0.12, false, mid);
    }
  }

  // ── rings: project orbit ring, slot clock
  if (nRing > 0) {
    const n = new THREE.Vector3();
    randomUnit(rng, n);
    if (Math.abs(n.y) < 0.5) n.y = 0.8;
    n.normalize();
    const u = new THREE.Vector3();
    perpendicular(n, rng, u);
    const w = new THREE.Vector3().crossVectors(n, u).normalize();
    const R = radius * (type === 'project' ? 1.32 : 1.08);
    let prev = -1;
    let first = -1;
    if (type === 'slot') {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const idx = put(
          (u.x * Math.cos(a) + w.x * Math.sin(a)) * R,
          (u.y * Math.cos(a) + w.y * Math.sin(a)) * R,
          (u.z * Math.cos(a) + w.z * Math.sin(a)) * R,
          'tick',
        );
        if (idx < 0) break;
      }
    }
    while (k < count) {
      const i = k;
      const a = rng() * Math.PI * 2;
      const rr = R * (type === 'slot' ? 0.93 : 1) * (1 + (rng() - 0.5) * 0.05);
      const idx = put(
        (u.x * Math.cos(a) + w.x * Math.sin(a)) * rr,
        (u.y * Math.cos(a) + w.y * Math.sin(a)) * rr + (rng() - 0.5) * 0.1,
        (u.z * Math.cos(a) + w.z * Math.sin(a)) * rr,
        'ring',
      );
      if (idx < 0 || i === k) break;
      if (first < 0) first = idx;
      prev = idx;
    }
    void prev;
  }
  // fill any rounding leftovers into the soma
  while (k < count) {
    const idx = put(gaussian(rng) * sig, gaussian(rng) * sig, gaussian(rng) * sig, 'soma');
    if (idx < 0) break;
  }

  // ring particles are randomly placed: connect each to its angular neighbour for a crisp orbit
  if (nRing > 0) {
    const start = count - nRing;
    const ids: { i: number; a: number }[] = [];
    for (let i = start; i < count; i++) ids.push({ i, a: Math.atan2(local[i * 3 + 2], local[i * 3]) });
    ids.sort((x, y) => x.a - y.a);
    for (let i = 0; i < ids.length; i++) {
      if (type === 'slot' && rng() < 0.5) continue;
      web.push(ids[i].i, ids[(i + 1) % ids.length].i);
    }
  }

  const axis = randomUnit(rng, new THREE.Vector3());
  const spin = (0.035 + rng() * 0.06) * (rng() < 0.5 ? -1 : 1);
  return { count, local, scatter, colors, sizes, phases, delays, web, axis, spin };
}
