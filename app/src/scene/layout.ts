import * as THREE from 'three';
import type { SEdge } from './structure';
import { visuals } from './visual';
import { fx } from '../store/fx';
import { hashString, mulberry32 } from '../lib/random';
import { isMemoryOnly } from '../store/storage';

/**
 * Mise en page organique : les liens rapprochent (d'autant plus qu'ils sont forts), les tags communs
 * forment des voisinages, tout le monde se repousse un peu, et ce qui est vivant gravite au centre
 * pendant que ce qui dort dérive doucement vers la périphérie.
 * La simulation refroidit puis s'arrête : la carte mentale reste stable tant que rien ne change.
 */
export interface LNode {
  id: string;
  /** encombrement (unités monde) */
  radius: number;
  /** rayon du glyphe */
  glyph: number;
  charge: number;
  vit: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** pos + flottement : ce qui est réellement dessiné */
  render: THREE.Vector3;
  phase: [number, number, number];
  /** naissance ; < 0 = en attente, 1 = formé */
  birth: number;
  birthSpeed: number;
  bornFlashed: boolean;
  flash: number;
  hover: number;
  vis: number;
  sel: number;
  /** valeurs lissées vers le visuel cible */
  done: number;
  bright: number;
  size: number;
  hub: number;
  alert: number;
  ripple: number;
}

const POS_KEY = 'synapse-layout';

const K_REP = 2100;
const K_GRAV = 0.34;
const K_TAG = 0.05;
const DAMP = 2.4;
const MAX_V = 26;

function loadSaved(): Record<string, [number, number, number]> {
  try {
    const raw = localStorage.getItem(POS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function randomUnit(rng: () => number, out = new THREE.Vector3()) {
  const u = rng() * 2 - 1;
  const th = rng() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return out.set(s * Math.cos(th), u, s * Math.sin(th));
}

class Layout {
  nodes = new Map<string, LNode>();
  list: LNode[] = [];
  edges: SEdge[] = [];
  /** indices des deux nœuds de chaque lien */
  edgeIdx = new Int32Array(0);
  edgeStrength = new Float32Array(0);
  /** pour faire naître un neurone devant la caméra */
  spawnPoint: (() => THREE.Vector3) | null = null;
  /** 1 = en pleine réorganisation, 0 = figé */
  alpha = 1;

  private parity = false;
  private hints = new Map<string, string | null>();
  private saved = loadSaved();
  private initialized = false;
  private saveAcc = 0;
  private metricsVersion = -1;
  private tagGroups: Int32Array[] = [];
  private ax = new Float32Array(0);
  private ay = new Float32Array(0);
  private az = new Float32Array(0);

  constructor() {
    fx.on((e) => {
      if (e.kind === 'birth') this.hints.set(e.id, e.near ?? null);
    });
  }

  get ready() {
    return this.initialized;
  }

  reheat(a: number) {
    this.alpha = Math.max(this.alpha, a);
  }

  sync(items: { id: string }[], edges: SEdge[]) {
    const boot = !this.initialized;
    const ids = new Set(items.map((i) => i.id));
    for (const id of [...this.nodes.keys()]) if (!ids.has(id)) this.nodes.delete(id);
    visuals.refresh();
    let fromSaved = 0;
    items.forEach((it, i) => {
      if (!this.nodes.has(it.id)) {
        const n = this.createNode(it.id, boot, i, items.length);
        if (this.saved[it.id]) fromSaved++;
        this.nodes.set(it.id, n);
      }
    });
    this.list = items.map((i) => this.nodes.get(i.id)!);
    this.edges = edges;
    const index = new Map(this.list.map((n, i) => [n.id, i]));
    this.edgeIdx = new Int32Array(edges.length * 2);
    edges.forEach((e, i) => {
      this.edgeIdx[i * 2] = index.get(e.a) ?? -1;
      this.edgeIdx[i * 2 + 1] = index.get(e.b) ?? -1;
    });
    this.edgeStrength = new Float32Array(edges.length).fill(0.5);
    if (this.ax.length !== this.list.length) {
      this.ax = new Float32Array(this.list.length);
      this.ay = new Float32Array(this.list.length);
      this.az = new Float32Array(this.list.length);
    }
    this.metricsVersion = -1;
    this.applyMetrics();
    if (boot) {
      this.initialized = true;
      // positions mémorisées : quelques pas suffisent ; sinon on laisse le réseau se déployer
      const n = Math.max(1, items.length);
      const steps = fromSaved >= items.length * 0.8 ? 40 : Math.max(120, Math.min(700, Math.round(260000 / (n * n)) * 10));
      this.alpha = 1;
      for (let s = 0; s < steps; s++) this.forces(0.06, 1);
      for (const nd of this.list) nd.vel.set(0, 0, 0);
      this.alpha = fromSaved >= items.length * 0.8 ? 0.08 : 0.4;
    } else {
      this.reheat(0.32);
    }
  }

  /** Taille, vitalité, tags et force des liens viennent du cache visuel */
  applyMetrics() {
    if (this.metricsVersion === visuals.version) return;
    this.metricsVersion = visuals.version;
    for (const n of this.list) {
      const v = visuals.get(n.id);
      n.radius = v.space;
      n.charge = v.space / 6.6;
      n.glyph = v.glyph;
      n.vit = v.vitality;
    }
    this.edges.forEach((e, i) => {
      this.edgeStrength[i] = visuals.edges.get(e.key)?.strength ?? 0.5;
    });
    // voisinages par tag (les tags trop répandus ne disent rien)
    const groups = new Map<string, number[]>();
    this.list.forEach((n, i) => {
      for (const t of visuals.get(n.id).tags) {
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t)!.push(i);
      }
    });
    const limit = Math.max(3, this.list.length * 0.3);
    this.tagGroups = [...groups.values()].filter((g) => g.length >= 2 && g.length <= limit).map((g) => Int32Array.from(g));
  }

  private createNode(id: string, boot: boolean, i: number, total: number): LNode {
    const rng = mulberry32(hashString(id));
    const pos = new THREE.Vector3();
    const saved = this.saved[id];
    let birth = 0;
    if (saved) {
      pos.set(saved[0], saved[1], saved[2]);
      birth = boot ? -rng() * 0.8 : 0;
    } else if (boot) {
      const r = 13 * Math.cbrt(total + 1);
      const y = 1 - (2 * (i + 0.5)) / Math.max(total, 1);
      const rad = Math.sqrt(1 - y * y);
      const th = i * 2.399963;
      pos.set(Math.cos(th) * rad * r, y * r * 0.7, Math.sin(th) * rad * r);
      pos.add(randomUnit(rng).multiplyScalar(3));
      birth = -rng() * 0.8;
    } else {
      const hint = this.hints.get(id);
      this.hints.delete(id);
      const near = hint ? this.nodes.get(hint) : null;
      if (near) pos.copy(near.pos).add(randomUnit(rng).multiplyScalar(11 + rng() * 4));
      else if (this.spawnPoint) pos.copy(this.spawnPoint()).add(randomUnit(rng).multiplyScalar(2));
      else randomUnit(rng, pos).multiplyScalar(30);
    }
    const v = visuals.get(id);
    return {
      id,
      radius: v.space,
      glyph: v.glyph,
      charge: v.space / 6.6,
      vit: v.vitality,
      pos,
      vel: new THREE.Vector3(),
      render: pos.clone(),
      phase: [rng() * 6.28, rng() * 6.28, rng() * 6.28],
      birth,
      birthSpeed: boot ? 0.7 : 0.55,
      bornFlashed: !boot && !!saved,
      flash: 0,
      hover: 0,
      vis: 1,
      sel: 0,
      done: v.done,
      bright: 0,
      size: 0,
      hub: v.hub,
      alert: v.alert,
      ripple: 0,
    };
  }

  private gridStart = new Int32Array(0);
  private gridFill = new Int32Array(0);
  private gridItems = new Int32Array(0);
  private gridKey = new Int32Array(0);
  private gridSeen = new Int32Array(27);

  /**
   * Grand réseau : répulsion locale seulement (voisins dans un rayon de 1 à 2 cellules),
   * grille spatiale hachée dans des tableaux typés réutilisés — aucune allocation par image.
   */
  private repelGrid() {
    const L = this.list;
    const n = L.length;
    const { ax, ay, az } = this;
    const C = 46;
    let size = 1;
    while (size < n * 2) size <<= 1;
    if (this.gridStart.length !== size + 1) {
      this.gridStart = new Int32Array(size + 1);
      this.gridFill = new Int32Array(size);
    }
    if (this.gridItems.length !== n) {
      this.gridItems = new Int32Array(n);
      this.gridKey = new Int32Array(n);
    }
    const start = this.gridStart;
    const fill = this.gridFill;
    const items = this.gridItems;
    const keys = this.gridKey;
    const seen = this.gridSeen;
    const mask = size - 1;
    const hash = (x: number, y: number, z: number) => ((Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) >>> 0) & mask;
    start.fill(0);
    for (let i = 0; i < n; i++) {
      const p = L[i].pos;
      const k = hash(Math.floor(p.x / C), Math.floor(p.y / C), Math.floor(p.z / C));
      keys[i] = k;
      start[k + 1]++;
    }
    for (let k = 0; k < size; k++) start[k + 1] += start[k];
    fill.set(start.subarray(0, size));
    for (let i = 0; i < n; i++) items[fill[keys[i]]++] = i;
    for (let i = 0; i < n; i++) {
      const a = L[i];
      const ap = a.pos;
      const cx = Math.floor(ap.x / C);
      const cy = Math.floor(ap.y / C);
      const cz = Math.floor(ap.z / C);
      let ns = 0;
      let fx = 0;
      let fy = 0;
      let fz = 0;
      for (let ox = -1; ox <= 1; ox++)
        for (let oy = -1; oy <= 1; oy++)
          for (let oz = -1; oz <= 1; oz++) {
            const k = hash(cx + ox, cy + oy, cz + oz);
            let dup = false;
            for (let q = 0; q < ns; q++)
              if (seen[q] === k) {
                dup = true;
                break;
              }
            if (dup) continue;
            seen[ns++] = k;
            for (let s = start[k], e = start[k + 1]; s < e; s++) {
              const j = items[s];
              if (j === i) continue;
              const b = L[j];
              const dx = ap.x - b.pos.x;
              const dy = ap.y - b.pos.y;
              const dz = ap.z - b.pos.z;
              const d2 = dx * dx + dy * dy + dz * dz + 1e-4;
              if (d2 > 9000) continue;
              const minD = (a.radius + b.radius) * 0.9;
              const f = (K_REP * a.charge * b.charge) / Math.max(d2, minD * minD) / Math.sqrt(d2);
              fx += dx * f;
              fy += dy * f;
              fz += dz * f;
            }
          }
      ax[i] += fx;
      ay[i] += fy;
      az[i] += fz;
    }
  }

  private forces(dt: number, alpha: number) {
    const L = this.list;
    const n = L.length;
    const { ax, ay, az } = this;
    for (let i = 0; i < n; i++) {
      const p = L[i].pos;
      // ce qui est vivant est attiré vers le centre, ce qui dort dérive vers l'extérieur
      const g = K_GRAV * (0.45 + 0.75 * L[i].vit);
      ax[i] = -g * p.x;
      ay[i] = -g * p.y * 1.25;
      az[i] = -g * p.z;
    }
    if (n <= 600) {
      for (let i = 0; i < n; i++) {
        const a = L[i];
        for (let j = i + 1; j < n; j++) {
          const b = L[j];
          let dx = a.pos.x - b.pos.x;
          let dy = a.pos.y - b.pos.y;
          let dz = a.pos.z - b.pos.z;
          let d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < 1e-6) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            dz = Math.random() - 0.5;
            d2 = 0.01;
          }
          const minD = (a.radius + b.radius) * 0.9;
          const d = Math.sqrt(d2);
          const f = (K_REP * a.charge * b.charge) / Math.max(d2, minD * minD) / d;
          ax[i] += dx * f;
          ay[i] += dy * f;
          az[i] += dz * f;
          ax[j] -= dx * f;
          ay[j] -= dy * f;
          az[j] -= dz * f;
        }
      }
    } else {
      this.repelGrid();
    }
    // ressorts : un lien fort rapproche davantage
    const E = this.edges;
    for (let e = 0; e < E.length; e++) {
      const i = this.edgeIdx[e * 2];
      const j = this.edgeIdx[e * 2 + 1];
      if (i < 0 || j < 0) continue;
      const a = L[i];
      const b = L[j];
      const s = this.edgeStrength[e] || 0.5;
      const rest = 8 + (a.radius + b.radius) * 1.0 + (1 - s) * 15;
      const k = 0.45 + s * 1.05;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const dz = b.pos.z - a.pos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
      const f = (k * (d - rest)) / d;
      ax[i] += dx * f;
      ay[i] += dy * f;
      az[i] += dz * f;
      ax[j] -= dx * f;
      ay[j] -= dy * f;
      az[j] -= dz * f;
    }
    // voisinages de tags : légère attraction vers le centre du groupe
    for (const g of this.tagGroups) {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (const i of g) {
        cx += L[i].pos.x;
        cy += L[i].pos.y;
        cz += L[i].pos.z;
      }
      cx /= g.length;
      cy /= g.length;
      cz /= g.length;
      for (const i of g) {
        ax[i] += (cx - L[i].pos.x) * K_TAG;
        ay[i] += (cy - L[i].pos.y) * K_TAG;
        az[i] += (cz - L[i].pos.z) * K_TAG;
      }
    }
    const damp = Math.exp(-dt * DAMP);
    for (let i = 0; i < n; i++) {
      const v = L[i].vel;
      v.x = (v.x + ax[i] * dt * alpha) * damp;
      v.y = (v.y + ay[i] * dt * alpha) * damp;
      v.z = (v.z + az[i] * dt * alpha) * damp;
      const sp = v.length();
      if (sp > MAX_V) v.multiplyScalar(MAX_V / sp);
      L[i].pos.addScaledVector(v, dt);
    }
  }

  step(dt: number, t: number) {
    if (!this.list.length) return;
    this.applyMetrics();
    if (this.alpha > 0.006) {
      // très grand réseau : la réorganisation avance une image sur deux (deux fois plus lente, deux fois moins coûteuse)
      this.parity = !this.parity;
      if (this.list.length <= 600 || this.parity) this.forces(dt, Math.min(1, this.alpha * 2.2));
      this.alpha *= Math.exp(-dt * 0.22);
    }
    const breath = 1 + 0.014 * Math.sin(t * 0.31);
    for (const n of this.list) {
      const [a, b, c] = n.phase;
      n.render.set(
        n.pos.x * breath + Math.sin(t * 0.23 + a) * 0.7,
        n.pos.y * breath + Math.sin(t * 0.19 + b) * 0.7,
        n.pos.z * breath + Math.sin(t * 0.21 + c) * 0.7,
      );
    }
    this.saveAcc += dt;
    if (this.saveAcc > 5) {
      this.saveAcc = 0;
      this.save();
    }
  }

  /**
   * Positions venues du cerveau partagé : un invité reprend la carte du propriétaire (« replace »),
   * le propriétaire complète seulement ce qui lui manque (« merge », nouveau navigateur par exemple).
   * Ne déplace jamais un neurone déjà affiché.
   */
  useSavedPositions(map: Record<string, [number, number, number]>, mode: 'replace' | 'merge') {
    this.saved = mode === 'replace' ? { ...map } : { ...map, ...this.saved };
  }

  /** Positions actuelles (arrondies), pour les partager */
  positions(): Record<string, [number, number, number]> {
    if (!this.list.length) return { ...this.saved };
    const out: Record<string, [number, number, number]> = {};
    for (const n of this.list) out[n.id] = [+n.pos.x.toFixed(1), +n.pos.y.toFixed(1), +n.pos.z.toFixed(1)];
    return out;
  }

  save() {
    const out: Record<string, [number, number, number]> = {};
    for (const n of this.list) out[n.id] = [+n.pos.x.toFixed(2), +n.pos.y.toFixed(2), +n.pos.z.toFixed(2)];
    this.saved = out;
    // invité : la carte du cerveau d'un autre ne reste pas sur cet ordinateur
    if (isMemoryOnly()) return;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(out));
    } catch {
      /* ignore */
    }
  }

  bounds(out = new THREE.Vector3()): { center: THREE.Vector3; radius: number } {
    if (!this.list.length) return { center: out.set(0, 0, 0), radius: 40 };
    out.set(0, 0, 0);
    for (const n of this.list) out.add(n.pos);
    out.multiplyScalar(1 / this.list.length);
    let r = 0;
    for (const n of this.list) r = Math.max(r, n.pos.distanceTo(out) + n.radius * 1.5);
    return { center: out, radius: Math.max(r, 30) };
  }

  neighbors(id: string): Set<string> {
    const s = new Set<string>();
    for (const e of this.edges) {
      if (e.a === id) s.add(e.b);
      else if (e.b === id) s.add(e.a);
    }
    return s;
  }
}

export const layout = new Layout();
