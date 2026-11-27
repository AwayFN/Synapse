import * as THREE from 'three';
import type { EntityType } from '../types';
import type { Edge } from '../store/graph';
import { fx } from '../store/fx';
import { useNetwork } from '../store/network';
import { readJson, writeKey } from '../store/storage';
import { hashString, mulberry32 } from '../lib/random';

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

/** Ce qu'on exporte (et qu'on réimporte) : la place de chaque neurone, et ceux posés à la main */
export interface Placement {
  positions: Record<string, [number, number, number]>;
  pinned: string[];
}

const POS_KEY = 'synapse-layout';

// force constants (tuned by eye) — V7 : plus d'espace entre les neurones (environ 1,6 fois la première version).
// V8 : ces distances sont multipliées par les deux réglages du réseau (neurones liés / non liés, 0,85 par défaut).
const K_REP = 8000;
const K_GRAV = 0.28;
const DAMP = 2.4;
const MAX_V = 36;
/** longueur au repos des liens : tâche/créneau/note → projet, et liens libres */
const REST_PARENT = 20;
const REST_LINK = 30;
const REST_SCALE_PARENT = 1.2;
const REST_SCALE_LINK = 1.5;

function loadSaved(): Record<string, [number, number, number]> {
  const raw = readJson<Record<string, unknown>>(POS_KEY, {});
  const out: Record<string, [number, number, number]> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, p] of Object.entries(raw)) {
    if (Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every((x) => typeof x === 'number' && Number.isFinite(x))) out[id] = [p[0], p[1], p[2]];
  }
  return out;
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
  /** le neurone tenu en main en ce moment (souris ou doigt) : les forces ne le bougent pas */
  grabbed: string | null = null;

  private hints = new Map<string, string | null>();
  private saved = loadSaved();
  private initialized = false;
  private saveAcc = 0;
  private ax = new Float32Array(0);
  private ay = new Float32Array(0);
  private az = new Float32Array(0);
  /** voisins directs (i * n + j) : leur répulsion suit le réglage « neurones liés » */
  private adj = new Uint8Array(0);
  private adjSet: Set<number> | null = null;
  private fixed = new Uint8Array(0);
  /** respiration du réseau (le dernier pas) : pour qu'un neurone tenu en main reste exactement sous le doigt */
  private breath = 1;
  private time = 0;

  constructor() {
    fx.on((e) => {
      if (e.kind === 'birth') this.hints.set(e.id, e.near ?? null);
    });
  }

  get ready() {
    return this.initialized;
  }

  sync(items: { id: string; type: EntityType }[], edges: Edge[]) {
    const boot = !this.initialized || this.rebootFrames > 0;
    this.rebootFrames = 0;
    const ids = new Set(items.map((i) => i.id));
    for (const id of [...this.nodes.keys()]) if (!ids.has(id)) this.nodes.delete(id);
    if (this.grabbed && !ids.has(this.grabbed)) this.grabbed = null;

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
    const n = this.list.length;
    const dense = n <= 1500;
    this.adj = dense ? new Uint8Array(n * n) : new Uint8Array(0);
    this.adjSet = dense ? null : new Set<number>();
    edges.forEach((e, k) => {
      const a = index.get(e.a) ?? -1;
      const b = index.get(e.b) ?? -1;
      this.edgeIdx[k * 2] = a;
      this.edgeIdx[k * 2 + 1] = b;
      if (a < 0 || b < 0) return;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (dense) this.adj[lo * n + hi] = 1;
      else this.adjSet!.add(lo * n + hi);
    });
    if (this.ax.length !== n) {
      this.ax = new Float32Array(n);
      this.ay = new Float32Array(n);
      this.az = new Float32Array(n);
      this.fixed = new Uint8Array(n);
    }
    if (boot) {
      this.initialized = true;
      // settle the layout before the first frame (fewer steps if positions were remembered)
      const steps = fromSaved >= items.length * 0.8 ? 60 : 700;
      for (let s = 0; s < steps; s++) this.forces(0.06);
      for (const node of this.list) node.vel.set(0, 0, 0);
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
      const r = 22 * Math.cbrt(total + 1) * useNetwork.getState().unlinked;
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
        pos.copy(near.pos).add(randomUnit(rng).multiplyScalar((21 + rng() * 6) * useNetwork.getState().linked));
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

  private linked(i: number, j: number, n: number): boolean {
    const lo = i < j ? i : j;
    const hi = i < j ? j : i;
    return this.adjSet ? this.adjSet.has(lo * n + hi) : this.adj[lo * n + hi] === 1;
  }

  /**
   * Les forces : chaque neurone repousse les autres, la gravité garde le réseau groupé, chaque lien est un ressort.
   * Les deux réglages agrandissent ou rapprochent tout le dessin : « liés » change la longueur des ressorts (et la
   * répulsion entre deux voisins directs), « non liés » la répulsion entre tous les autres. Une répulsion multipliée
   * par s³ et des ressorts par s donnent exactement le même réseau, à l'échelle s.
   */
  private forces(dt: number) {
    const L = this.list;
    const n = L.length;
    const { ax, ay, az } = this;
    const net = useNetwork.getState();
    const sL = net.linked;
    const sU = net.unlinked;
    const repL = K_REP * sL * sL * sL;
    const repU = K_REP * sU * sU * sU;
    const pinned = net.pinned;
    for (let i = 0; i < n; i++) {
      const p = L[i].pos;
      ax[i] = -K_GRAV * p.x;
      ay[i] = -K_GRAV * p.y * 1.25; // slightly flattened galaxy
      az[i] = -K_GRAV * p.z;
      this.fixed[i] = pinned[L[i].id] || L[i].id === this.grabbed ? 1 : 0;
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
        const near = this.linked(i, j, n);
        const s = near ? sL : sU;
        const minD = (a.radius + b.radius) * 0.9 * s;
        if (d2 < 1e-6) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          dz = Math.random() - 0.5;
          d2 = 0.01;
        }
        const d = Math.sqrt(d2);
        const dd = Math.max(d2, minD * minD);
        const f = ((near ? repL : repU) * a.charge * b.charge) / dd / d;
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
      const rest = (parent ? REST_PARENT + (a.radius + b.radius) * REST_SCALE_PARENT : REST_LINK + (a.radius + b.radius) * REST_SCALE_LINK) * sL;
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
    const maxV = MAX_V * Math.max(1, sL, sU);
    for (let i = 0; i < n; i++) {
      const v = L[i].vel;
      // posé à la main (ou tenu en ce moment) : il ne bouge pas, les autres s'organisent autour de lui
      if (this.fixed[i]) {
        v.set(0, 0, 0);
        continue;
      }
      v.x = (v.x + ax[i] * dt) * damp;
      v.y = (v.y + ay[i] * dt) * damp;
      v.z = (v.z + az[i] * dt) * damp;
      const sp = v.length();
      if (sp > maxV) v.multiplyScalar(maxV / sp);
      L[i].pos.addScaledVector(v, dt);
    }
  }

  private wobble(n: LNode, t: number, out: THREE.Vector3) {
    const [a, b, c] = n.phase;
    return out.set(Math.sin(t * 0.23 + a) * 0.9, Math.sin(t * 0.19 + b) * 0.9, Math.sin(t * 0.21 + c) * 0.9);
  }

  private tmp = new THREE.Vector3();

  step(dt: number, t: number) {
    if (this.rebootFrames > 0) this.rebootFrames--;
    if (!this.list.length) return;
    this.forces(dt);
    const breath = 1 + 0.018 * Math.sin(t * 0.33);
    this.breath = breath;
    this.time = t;
    for (const n of this.list) {
      this.wobble(n, t, this.tmp);
      n.render.set(n.pos.x * breath + this.tmp.x, n.pos.y * breath + this.tmp.y, n.pos.z * breath + this.tmp.z);
    }
    this.saveAcc += dt;
    if (this.saveAcc > 5) {
      this.saveAcc = 0;
      this.save();
    }
  }

  // ───────────────────────── déplacer un neurone à la main

  grabStart(id: string) {
    if (!this.nodes.has(id)) return false;
    this.grabbed = id;
    return true;
  }

  /** Le neurone tenu suit le pointeur : `target` est l'endroit où il doit s'afficher (respiration comprise) */
  grabMove(target: THREE.Vector3) {
    const n = this.grabbed ? this.nodes.get(this.grabbed) : undefined;
    if (!n) return;
    this.wobble(n, this.time, this.tmp);
    n.pos.copy(target).sub(this.tmp).multiplyScalar(1 / this.breath);
    n.vel.set(0, 0, 0);
    n.render.copy(target);
  }

  /** Lâché : il reste exactement là (posé à la main), et c'est gardé tout de suite */
  grabEnd(keep: boolean) {
    const id = this.grabbed;
    this.grabbed = null;
    if (!id) return;
    if (keep) useNetwork.getState().pin(id);
    this.save();
  }

  // ───────────────────────── positions gardées sur l'appareil

  /** Position de chaque neurone */
  positions(): Record<string, [number, number, number]> {
    const out: Record<string, [number, number, number]> = {};
    for (const n of this.list) out[n.id] = [+n.pos.x.toFixed(2), +n.pos.y.toFixed(2), +n.pos.z.toFixed(2)];
    return out;
  }

  save() {
    if (!this.initialized) return;
    const out = this.positions();
    this.saved = out;
    writeKey(POS_KEY, JSON.stringify(out));
  }

  /** La place des neurones, pour l'export (seulement ceux qui existent) */
  placement(): Placement {
    const positions = this.initialized ? this.positions() : { ...this.saved };
    const pinned = Object.keys(useNetwork.getState().pinned).filter((id) => positions[id]);
    return { positions, pinned };
  }

  /**
   * Après un import : le réseau se redispose depuis zéro, avec la place des neurones du fichier s'il la donne (et ceux
   * qui y étaient posés à la main restent posés) ; puis la caméra montre le tout.
   */
  applyPlacement(p: Placement | null) {
    this.saved = p ? { ...p.positions } : {};
    useNetwork.getState().setPinned(p ? p.pinned.filter((id) => this.saved[id]) : []);
    this.grabbed = null;
    // les neurones déjà là (même fichier réimporté) prennent leur place tout de suite…
    for (const [id, pos] of Object.entries(this.saved)) {
      const n = this.nodes.get(id);
      if (!n) continue;
      n.pos.set(pos[0], pos[1], pos[2]);
      n.vel.set(0, 0, 0);
    }
    // …les nouveaux naissent comme au démarrage (le réseau se dispose, puis la caméra le montre)
    this.rebootFrames = 4;
    writeKey(POS_KEY, JSON.stringify(this.saved));
    window.setTimeout(() => fx.emit({ kind: 'overview' }), 400);
  }

  /** quelques images après un import : le prochain changement de structure se dispose comme au démarrage */
  private rebootFrames = 0;

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
