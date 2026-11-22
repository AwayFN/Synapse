import * as THREE from 'three';

/**
 * Impulsions : des points de lumière néon qui voyagent le long des connexions (une traînée derrière
 * une tête blanche brûlante), et des étincelles libres pour les éclats (naissance, tâche accomplie…).
 * Un seul appel de dessin pour tout. À l'arrivée, le neurone touché s'illumine (et peut répondre).
 */
const MAX = 640;
const TRAIL = 10;

export type PulseLevel = 'vif' | 'calme' | 'off';
const KEY = 'synapse-impulsions';
const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
let level: PulseLevel = (() => {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'vif' || v === 'calme' || v === 'off') return v;
  } catch {
    /* pas de stockage : réglage par défaut */
  }
  return reduced() ? 'calme' : 'vif';
})();
export const pulseLevel = () => level;
export function setPulseLevel(l: PulseLevel) {
  level = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* pas grave */
  }
}
export const PULSE_LABEL: Record<PulseLevel, string> = { vif: 'vives', calme: 'calmes', off: 'arrêtées' };

export interface Arrival {
  edge: number;
  /** vers quel bout du lien : true = de a vers b */
  fromA: boolean;
  target: number;
  strength: number;
}

export class PulseSystem {
  readonly geo = new THREE.BufferGeometry();
  private pos = new Float32Array(MAX * TRAIL * 3);
  private col = new Float32Array(MAX * TRAIL * 3);
  private size = new Float32Array(MAX * TRAIL);
  private int = new Float32Array(MAX * TRAIL);

  private kind = new Uint8Array(MAX); // 0 libre · 1 impulsion · 2 étincelle
  private edge = new Int32Array(MAX);
  private t = new Float32Array(MAX);
  private speed = new Float32Array(MAX);
  private dir = new Int8Array(MAX);
  private str = new Float32Array(MAX);
  private rgb = new Float32Array(MAX * 3);
  private target = new Int32Array(MAX);
  private sp = new Float32Array(MAX * 3);
  private sv = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX);
  private maxLife = new Float32Array(MAX);
  private cursor = 0;
  spawned = 0;
  readonly arrivals: Arrival[] = [];

  constructor() {
    const phase = new Float32Array(MAX * TRAIL);
    for (let i = 0; i < phase.length; i++) phase[i] = Math.random();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aInt', new THREE.BufferAttribute(this.int, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  }

  get active() {
    let n = 0;
    for (let i = 0; i < MAX; i++) if (this.kind[i] === 1) n++;
    return n;
  }

  private alloc(): number {
    for (let n = 0; n < MAX; n++) {
      const i = (this.cursor + n) % MAX;
      if (this.kind[i] === 0) {
        this.cursor = (i + 1) % MAX;
        return i;
      }
    }
    // tout est pris : on recycle la plus ancienne place
    const i = this.cursor;
    this.cursor = (i + 1) % MAX;
    return i;
  }

  /** Impulsion le long du lien `e` (fromA : de a vers b), à `speed` (fraction du lien par seconde) */
  pulse(e: number, fromA: boolean, strength: number, color: THREE.Color, target: number, speed: number) {
    const i = this.alloc();
    this.kind[i] = 1;
    this.edge[i] = e;
    this.t[i] = 0;
    this.speed[i] = speed;
    this.dir[i] = fromA ? 1 : -1;
    this.str[i] = strength;
    this.rgb[i * 3] = color.r;
    this.rgb[i * 3 + 1] = color.g;
    this.rgb[i * 3 + 2] = color.b;
    this.target[i] = target;
    this.spawned++;
  }

  /** Éclat d'étincelles autour d'un point (naissance, accomplissement, nouveau lien) */
  burst(center: THREE.Vector3, color: THREE.Color, n: number, speed: number, life = 1.4) {
    for (let k = 0; k < n; k++) {
      const i = this.alloc();
      this.kind[i] = 2;
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const sp = speed * (0.4 + Math.random() * 0.8);
      this.sp[i * 3] = center.x;
      this.sp[i * 3 + 1] = center.y;
      this.sp[i * 3 + 2] = center.z;
      this.sv[i * 3] = s * Math.cos(th) * sp;
      this.sv[i * 3 + 1] = u * sp;
      this.sv[i * 3 + 2] = s * Math.sin(th) * sp;
      this.life[i] = this.maxLife[i] = life * (0.6 + Math.random() * 0.6);
      this.rgb[i * 3] = color.r;
      this.rgb[i * 3 + 1] = color.g;
      this.rgb[i * 3 + 2] = color.b;
      this.str[i] = 1;
    }
  }

  private clear(i: number) {
    this.kind[i] = 0;
    for (let j = 0; j < TRAIL; j++) this.int[i * TRAIL + j] = 0;
  }

  /** Les liens changent de numéro quand le réseau est reconstruit : les impulsions en vol s'éteignent */
  dropEdgePulses() {
    for (let i = 0; i < MAX; i++) if (this.kind[i] === 1) this.clear(i);
  }

  /** Tout éteindre (impulsions arrêtées) */
  clearAll() {
    for (let i = 0; i < MAX; i++) if (this.kind[i] !== 0) this.clear(i);
  }

  /** curves : 9 nombres par lien (départ, point de contrôle, arrivée) */
  update(dt: number, curves: Float32Array, edgeCount: number) {
    const { pos, col, size, int } = this;
    this.arrivals.length = 0;
    for (let i = 0; i < MAX; i++) {
      const base = i * TRAIL;
      const k = this.kind[i];
      if (k === 1) {
        const e = this.edge[i];
        if (e >= edgeCount) {
          this.clear(i);
          continue;
        }
        this.t[i] += this.speed[i] * dt;
        if (this.t[i] >= 1) {
          this.arrivals.push({ edge: e, fromA: this.dir[i] > 0, target: this.target[i], strength: this.str[i] });
          this.clear(i);
          continue;
        }
        const c = e * 9;
        const ax = curves[c], ay = curves[c + 1], az = curves[c + 2];
        const cx = curves[c + 3], cy = curves[c + 4], cz = curves[c + 5];
        const bx = curves[c + 6], by = curves[c + 7], bz = curves[c + 8];
        const s = this.str[i];
        // traînée continue : ses points se chevauchent, quelle que soit la longueur du lien
        const len = Math.hypot(bx - ax, by - ay, bz - az) || 30;
        const gap = Math.min(0.02, Math.max(0.003, 0.75 / len));
        // apparition et disparition douces aux deux bouts du lien
        const ends = Math.min(1, this.t[i] * 8, (1 - this.t[i]) * 8);
        for (let j = 0; j < TRAIL; j++) {
          let u = this.t[i] - j * gap;
          const o = base + j;
          if (u < 0) {
            int[o] = 0;
            continue;
          }
          if (this.dir[i] < 0) u = 1 - u;
          const iu = 1 - u;
          pos[o * 3] = iu * iu * ax + 2 * iu * u * cx + u * u * bx;
          pos[o * 3 + 1] = iu * iu * ay + 2 * iu * u * cy + u * u * by;
          pos[o * 3 + 2] = iu * iu * az + 2 * iu * u * cz + u * u * bz;
          const f = 1 - j / TRAIL;
          // tête blanche brûlante, traînée de la couleur du neurone qui l'a envoyée
          const w = j === 0 ? 0.55 : j === 1 ? 0.2 : 0.05;
          col[o * 3] = this.rgb[i * 3] * (1 - w) + w;
          col[o * 3 + 1] = this.rgb[i * 3 + 1] * (1 - w) + w;
          col[o * 3 + 2] = this.rgb[i * 3 + 2] * (1 - w) + w;
          size[o] = (0.7 + 0.5 * Math.min(s, 1.6)) * (0.35 + 0.65 * f);
          int[o] = (1.0 + s * 0.9) * f * f * ends;
        }
      } else if (k === 2) {
        this.life[i] -= dt;
        if (this.life[i] <= 0) {
          this.clear(i);
          continue;
        }
        const drag = Math.exp(-dt * 1.9);
        this.sv[i * 3] *= drag;
        this.sv[i * 3 + 1] *= drag;
        this.sv[i * 3 + 2] *= drag;
        this.sp[i * 3] += this.sv[i * 3] * dt;
        this.sp[i * 3 + 1] += this.sv[i * 3 + 1] * dt;
        this.sp[i * 3 + 2] += this.sv[i * 3 + 2] * dt;
        const a = this.life[i] / this.maxLife[i];
        for (let j = 0; j < TRAIL; j++) {
          const o = base + j;
          pos[o * 3] = this.sp[i * 3] - this.sv[i * 3] * j * 0.012;
          pos[o * 3 + 1] = this.sp[i * 3 + 1] - this.sv[i * 3 + 1] * j * 0.012;
          pos[o * 3 + 2] = this.sp[i * 3 + 2] - this.sv[i * 3 + 2] * j * 0.012;
          col[o * 3] = this.rgb[i * 3] * 0.75 + 0.25;
          col[o * 3 + 1] = this.rgb[i * 3 + 1] * 0.75 + 0.25;
          col[o * 3 + 2] = this.rgb[i * 3 + 2] * 0.75 + 0.25;
          size[o] = 0.42 * (1 - (j / TRAIL) * 0.6);
          int[o] = a * a * 1.6 * (1 - j / TRAIL);
        }
      }
    }
    const g = this.geo.attributes;
    g.position.needsUpdate = true;
    g.aColor.needsUpdate = true;
    g.aSize.needsUpdate = true;
    g.aInt.needsUpdate = true;
  }
}
