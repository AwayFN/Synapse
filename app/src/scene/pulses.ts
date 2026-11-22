import * as THREE from 'three';
import { layout } from './layout';

const MAX = 420;
const TRAIL = 7;

/**
 * Light impulses travelling along the axons (curves between constellations)
 * plus free sparks for bursts. One Points draw call.
 */
export class PulseSystem {
  readonly geo = new THREE.BufferGeometry();
  private pos = new Float32Array(MAX * TRAIL * 3);
  private col = new Float32Array(MAX * TRAIL * 3);
  private size = new Float32Array(MAX * TRAIL);
  private int = new Float32Array(MAX * TRAIL);

  private kind = new Uint8Array(MAX); // 0 free · 1 pulse · 2 spark
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

  constructor() {
    const phase = new Float32Array(MAX * TRAIL).fill(0.5);
    const p = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', p);
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aInt', new THREE.BufferAttribute(this.int, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  }

  private alloc(): number {
    for (let n = 0; n < MAX; n++) {
      const i = (this.cursor + n) % MAX;
      if (this.kind[i] === 0) {
        this.cursor = (i + 1) % MAX;
        return i;
      }
    }
    const i = this.cursor;
    this.cursor = (i + 1) % MAX;
    return i;
  }

  /** Impulse along edge `e`. fromA = travels a→b. target = node index flashed on arrival (-1 none) */
  pulse(e: number, fromA: boolean, strength: number, color: THREE.Color, target: number) {
    const i = this.alloc();
    this.kind[i] = 1;
    this.edge[i] = e;
    this.t[i] = 0;
    this.speed[i] = (0.32 + Math.random() * 0.22) * (strength > 1.2 ? 0.8 : 1);
    this.dir[i] = fromA ? 1 : -1;
    this.str[i] = strength;
    this.rgb[i * 3] = color.r;
    this.rgb[i * 3 + 1] = color.g;
    this.rgb[i * 3 + 2] = color.b;
    this.target[i] = target;
    this.spawned++;
  }

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

  /** Edge indices change when the graph is rebuilt: drop impulses in flight (sparks keep going) */
  dropEdgePulses() {
    for (let i = 0; i < MAX; i++) {
      if (this.kind[i] !== 1) continue;
      this.kind[i] = 0;
      for (let j = 0; j < TRAIL; j++) this.int[i * TRAIL + j] = 0;
    }
  }

  /** curves: 9 floats per edge (A, control, B) */
  update(dt: number, curves: Float32Array, edgeCount: number) {
    const { pos, col, size, int } = this;
    let active = 0;
    for (let i = 0; i < MAX; i++) {
      const base = i * TRAIL;
      const k = this.kind[i];
      if (k === 1) {
        const e = this.edge[i];
        if (e >= edgeCount) {
          this.kind[i] = 0;
          for (let j = 0; j < TRAIL; j++) int[base + j] = 0;
          continue;
        }
        this.t[i] += this.speed[i] * dt;
        if (this.t[i] >= 1) {
          const tg = this.target[i];
          const node = tg >= 0 ? layout.list[tg] : undefined;
          if (node) node.flash = Math.min(2.4, node.flash + 0.3 * this.str[i]);
          this.kind[i] = 0;
          for (let j = 0; j < TRAIL; j++) int[base + j] = 0;
          continue;
        }
        active++;
        const c = e * 9;
        const ax = curves[c], ay = curves[c + 1], az = curves[c + 2];
        const cx = curves[c + 3], cy = curves[c + 4], cz = curves[c + 5];
        const bx = curves[c + 6], by = curves[c + 7], bz = curves[c + 8];
        const s = this.str[i];
        for (let j = 0; j < TRAIL; j++) {
          let u = this.t[i] - j * 0.016;
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
          // head is whiter
          const w = j === 0 ? 0.45 : 0.12;
          col[o * 3] = this.rgb[i * 3] * (1 - w) + w;
          col[o * 3 + 1] = this.rgb[i * 3 + 1] * (1 - w) + w;
          col[o * 3 + 2] = this.rgb[i * 3 + 2] * (1 - w) + w;
          size[o] = (0.75 + 0.55 * s) * (0.45 + 0.55 * f);
          int[o] = (0.9 + s * 0.9) * f * f;
        }
      } else if (k === 2) {
        this.life[i] -= dt;
        if (this.life[i] <= 0) {
          this.kind[i] = 0;
          for (let j = 0; j < TRAIL; j++) int[base + j] = 0;
          continue;
        }
        active++;
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
          // short streak behind the spark
          pos[o * 3] = this.sp[i * 3] - this.sv[i * 3] * j * 0.012;
          pos[o * 3 + 1] = this.sp[i * 3 + 1] - this.sv[i * 3 + 1] * j * 0.012;
          pos[o * 3 + 2] = this.sp[i * 3 + 2] - this.sv[i * 3 + 2] * j * 0.012;
          col[o * 3] = this.rgb[i * 3] * 0.75 + 0.25;
          col[o * 3 + 1] = this.rgb[i * 3 + 1] * 0.75 + 0.25;
          col[o * 3 + 2] = this.rgb[i * 3 + 2] * 0.75 + 0.25;
          size[o] = 0.42 * (1 - j / TRAIL * 0.6);
          int[o] = a * a * 1.6 * (1 - j / TRAIL);
        }
      }
    }
    const g = this.geo.attributes;
    g.position.needsUpdate = true;
    g.aColor.needsUpdate = true;
    g.aSize.needsUpdate = true;
    g.aInt.needsUpdate = true;
    return active;
  }
}
