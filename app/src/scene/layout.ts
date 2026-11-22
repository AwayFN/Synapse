import * as THREE from 'three';
import type { EntityType } from '../types';
import type { Edge } from '../store/graph';
import { fx } from '../store/fx';
import { hashString, mulberry32 } from '../lib/random';
import { isMemoryOnly } from '../store/storage';

/** Visual radius of a constellation per entity type (world units) */
export const RADIUS: Record<EntityType, number> = { project: 9.6, note: 7, task: 5.2, slot: 5.6 };
/** Radius of the clickable nucleus */
export const CORE: Record<EntityType, number> = { project: 1.3, note: 1.0, task: 0.74, slot: 0.8 };
/** Labels of small constellations disappear sooner with distance (plus loin : le réseau est plus aéré) */
export const LABEL_RANGE: Record<EntityType, number> = { project: 1080, note: 740, task: 430, slot: 460 };

export interface LNode {
  id: string;
  type: EntityType;
  radius: number;
  charge: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  /** pos + breathing: what everything is drawn at */
  render: THREE.Vector3;
  phase: [number, number, number];
  /** birth progress; < 0 = waiting, 1 = fully formed */
  birth: number;
  birthSpeed: number;
  bornFlashed: boolean;
  flash: number;
  hover: number;
  vis: number;
  sel: number;
  done: number;
}

const POS_KEY = 'synapse-layout';

// force constants (tuned by eye) — plus d'espace entre les neurones : répulsion plus forte, gravité plus douce,
// liens plus longs (environ 1,6 fois les distances de la première version)
const K_REP = 8000;
const K_GRAV = 0.28;
const DAMP = 2.4;
const MAX_V = 36;
/** longueur au repos des liens : tâche/créneau → projet, et liens libres */
const REST_PARENT = 20;
const REST_LINK = 30;
const REST_SCALE_PARENT = 1.2;
const REST_SCALE_LINK = 1.5;

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
  edges: Edge[] = [];
  /** node indices for each edge */
  edgeIdx = new Int32Array(0);
  /** called to place a fresh constellation in front of the camera */
  spawnPoint: (() => THREE.Vector3) | null = null;

  private hints = new Map<string, string | null>();
  private saved = loadSaved();
  private initialized = false;
  private saveAcc = 0;
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

  sync(items: { id: string; type: EntityType }[], edges: Edge[]) {
    const boot = !this.initialized;
    const ids = new Set(items.map((i) => i.id));
    for (const id of [...this.nodes.keys()]) if (!ids.has(id)) this.nodes.delete(id);

    let fromSaved = 0;
    items.forEach((it, i) => {
      let n = this.nodes.get(it.id);
      if (!n) {
        n = this.createNode(it.id, it.type, boot, i, items.length);
        if (this.saved[it.id]) fromSaved++;
        this.nodes.set(it.id, n);
      } else if (n.type !== it.type) {
        n.type = it.type;
        n.radius = RADIUS[it.type];
        n.charge = n.radius / 6.6;
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
    if (this.ax.length !== this.list.length) {
      this.ax = new Float32Array(this.list.length);
      this.ay = new Float32Array(this.list.length);
      this.az = new Float32Array(this.list.length);
    }
    if (boot) {
      this.initialized = true;
      // settle the layout before the first frame (fewer steps if positions were remembered)
      const steps = fromSaved >= items.length * 0.8 ? 60 : 700;
      for (let s = 0; s < steps; s++) this.forces(0.06);
      for (const n of this.list) n.vel.set(0, 0, 0);
    }
  }

  private createNode(id: string, type: EntityType, boot: boolean, i: number, total: number): LNode {
    const rng = mulberry32(hashString(id));
    const pos = new THREE.Vector3();
    const saved = this.saved[id];
    let birth = 0;
    if (saved) {
      pos.set(saved[0], saved[1], saved[2]);
      birth = boot ? -rng() * 0.8 : 0;
    } else if (boot) {
      // fibonacci sphere start, the relaxation does the rest
      const r = 22 * Math.cbrt(total + 1);
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
      if (near) {
        pos.copy(near.pos).add(randomUnit(rng).multiplyScalar(21 + rng() * 6));
      } else if (this.spawnPoint) {
        pos.copy(this.spawnPoint()).add(randomUnit(rng).multiplyScalar(2));
      } else {
        randomUnit(rng, pos).multiplyScalar(30);
      }
    }
    const radius = RADIUS[type];
    return {
      id,
      type,
      radius,
      charge: radius / 6.6,
      pos,
      vel: new THREE.Vector3(),
      render: pos.clone(),
      phase: [rng() * 6.28, rng() * 6.28, rng() * 6.28],
      birth,
      birthSpeed: boot ? 0.62 : 0.5,
      bornFlashed: !boot && !!saved,
      flash: 0,
      hover: 0,
      vis: 1,
      sel: 0,
      done: 0,
    };
  }

  private forces(dt: number) {
    const L = this.list;
    const n = L.length;
    const { ax, ay, az } = this;
    for (let i = 0; i < n; i++) {
      const p = L[i].pos;
      ax[i] = -K_GRAV * p.x;
      ay[i] = -K_GRAV * p.y * 1.25; // slightly flattened galaxy
      az[i] = -K_GRAV * p.z;
    }
    // many-body repulsion
    for (let i = 0; i < n; i++) {
      const a = L[i];
      for (let j = i + 1; j < n; j++) {
        const b = L[j];
        let dx = a.pos.x - b.pos.x;
        let dy = a.pos.y - b.pos.y;
        let dz = a.pos.z - b.pos.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        const minD = (a.radius + b.radius) * 0.9;
        if (d2 < 1e-6) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          dz = Math.random() - 0.5;
          d2 = 0.01;
        }
        const d = Math.sqrt(d2);
        const dd = Math.max(d2, minD * minD);
        const f = (K_REP * a.charge * b.charge) / dd / d;
        ax[i] += dx * f;
        ay[i] += dy * f;
        az[i] += dz * f;
        ax[j] -= dx * f;
        ay[j] -= dy * f;
        az[j] -= dz * f;
      }
    }
    // springs
    const E = this.edges;
    for (let e = 0; e < E.length; e++) {
      const i = this.edgeIdx[e * 2];
      const j = this.edgeIdx[e * 2 + 1];
      if (i < 0 || j < 0) continue;
      const a = L[i];
      const b = L[j];
      const parent = E[e].kind === 'parent';
      const rest = parent ? REST_PARENT + (a.radius + b.radius) * REST_SCALE_PARENT : REST_LINK + (a.radius + b.radius) * REST_SCALE_LINK;
      const k = parent ? 1.5 : 0.85;
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
    const damp = Math.exp(-dt * DAMP);
    for (let i = 0; i < n; i++) {
      const v = L[i].vel;
      v.x = (v.x + ax[i] * dt) * damp;
      v.y = (v.y + ay[i] * dt) * damp;
      v.z = (v.z + az[i] * dt) * damp;
      const sp = v.length();
      if (sp > MAX_V) v.multiplyScalar(MAX_V / sp);
      L[i].pos.addScaledVector(v, dt);
    }
  }

  step(dt: number, t: number) {
    if (!this.list.length) return;
    this.forces(dt);
    const breath = 1 + 0.018 * Math.sin(t * 0.33);
    for (const n of this.list) {
      const [a, b, c] = n.phase;
      n.render.set(
        n.pos.x * breath + Math.sin(t * 0.23 + a) * 0.9,
        n.pos.y * breath + Math.sin(t * 0.19 + b) * 0.9,
        n.pos.z * breath + Math.sin(t * 0.21 + c) * 0.9,
      );
    }
    this.saveAcc += dt;
    if (this.saveAcc > 5) {
      this.saveAcc = 0;
      this.save();
    }
  }

  /** Position de chaque neurone (envoyée au serveur par le propriétaire) */
  positions(): Record<string, [number, number, number]> {
    const out: Record<string, [number, number, number]> = {};
    for (const n of this.list) out[n.id] = [+n.pos.x.toFixed(2), +n.pos.y.toFixed(2), +n.pos.z.toFixed(2)];
    return out;
  }

  save() {
    const out = this.positions();
    this.saved = out;
    // avec un serveur, les positions vivent sur le serveur : rien n'est écrit dans ce navigateur
    if (isMemoryOnly()) return;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(out));
    } catch {
      /* ignore */
    }
  }

  /** Positions venues du serveur : l'invité prend celles du propriétaire, le propriétaire complète les siennes */
  useSavedPositions(pos: Record<string, [number, number, number]>, mode: 'merge' | 'replace') {
    this.saved = mode === 'replace' ? { ...pos } : { ...this.saved, ...pos };
    if (mode !== 'replace') return;
    for (const [id, p] of Object.entries(pos)) {
      const n = this.nodes.get(id);
      if (!n) continue;
      n.pos.set(p[0], p[1], p[2]);
      n.vel.set(0, 0, 0);
    }
  }

  bounds(out = new THREE.Vector3()): { center: THREE.Vector3; radius: number } {
    if (!this.list.length) return { center: out.set(0, 0, 0), radius: 40 };
    out.set(0, 0, 0);
    for (const n of this.list) out.add(n.pos);
    out.multiplyScalar(1 / this.list.length);
    let r = 0;
    for (const n of this.list) r = Math.max(r, n.pos.distanceTo(out) + n.radius * 2);
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
