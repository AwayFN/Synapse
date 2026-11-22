import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { layout } from './layout';
import { visuals } from './visual';
import { labelEls, reticle } from './telemetry';
import { useUI } from '../store/ui';

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

interface Cand {
  el: HTMLElement;
  x: number;
  y: number;
  s: number;
  a: number;
  dist: number;
  detail: number;
  hov: boolean;
  prio: number;
  w: number;
}

const widthCache = new WeakMap<HTMLElement, { w: number; at: number }>();
const MAX_LABELS = 140;
const MAX_GHOST_LABELS = 50;

/**
 * Projects every constellation to screen space and moves its DOM label (no React re-render).
 * Greedy HUD declutter: most important labels claim screen space first, overlapped ones fade out.
 */
export function LabelsProjector() {
  const v = useMemo(() => new THREE.Vector3(), []);
  const r = useMemo(() => new THREE.Vector3(), []);
  const right = useMemo(() => new THREE.Vector3(), []);
  const frame = useMemo(() => ({ n: 0, selKey: '', neighbors: new Set<string>() }), []);

  useFrame((state) => {
    const cam = state.camera;
    const { width, height } = state.size;
    const ui = useUI.getState();
    const hov = ui.hoveredId;
    const sel = ui.selectedId ?? ui.editorId;
    frame.n++;
    if (frame.selKey !== `${sel}|${layout.edges.length}`) {
      frame.selKey = `${sel}|${layout.edges.length}`;
      frame.neighbors = sel ? layout.neighbors(sel) : new Set();
    }

    // 1. calcul pur (aucune lecture ni écriture du DOM)
    const cands: Cand[] = [];
    const hide: HTMLElement[] = [];
    for (const n of layout.list) {
      const el = labelEls.get(n.id);
      if (!el) continue;
      v.copy(n.render).project(cam);
      const dist = cam.position.distanceTo(n.render);
      const be = smooth(0.55, 1, n.birth);
      const isHov = hov === n.id;
      const isSel = sel === n.id;
      const vz = visuals.get(n.id);
      // les petits neurones perdent leur étiquette plus tôt : le lointain reste lisible
      const range = (230 + vz.importance * 620) * (isSel || frame.neighbors.has(n.id) ? 1.8 : 1) * (0.75 + 0.25 * vz.vitality);
      const a = n.vis * be * (1 - smooth(range * 0.55, range, dist));
      if (v.z > 1 || (a < 0.03 && !isHov) || Math.abs(v.x) > 1.25 || Math.abs(v.y) > 1.25) {
        hide.push(el);
        continue;
      }
      const wc = widthCache.get(el);
      const detail = isHov || isSel ? 1 : 1 - smooth(60 + n.radius * 3, 110 + n.radius * 5, dist);
      cands.push({
        el,
        x: (v.x * 0.5 + 0.5) * width,
        y: (-v.y * 0.5 + 0.5) * height,
        s: Math.min(1.05, Math.max(0.55, 95 / dist)) * (1 + n.hover * 0.24),
        a: isHov ? 1 : Math.min(1, a * (n.vis < 0.5 ? 0.8 : 1)),
        dist,
        detail,
        hov: isHov,
        prio:
          (isHov ? 5000 : 0) +
          (isSel ? 4000 : 0) +
          (frame.neighbors.has(n.id) ? 600 : 0) +
          vz.importance * 420 +
          vz.vitality * 160 -
          dist * 0.8 +
          n.vis * 200,
        w: wc ? wc.w : -1,
      });
    }

    cands.sort((p, q) => q.prio - p.prio);
    // 2. lectures groupées : largeur des seules étiquettes qui ont une chance d'être affichées
    const budget = Math.min(cands.length, MAX_LABELS + MAX_GHOST_LABELS + 60);
    for (let i = 0; i < budget; i++) {
      const c = cands[i];
      const wc = widthCache.get(c.el);
      if (!wc || frame.n - wc.at > 90) {
        const title = c.el.querySelector<HTMLElement>('.lbl-title');
        const w = title ? title.offsetWidth : 120;
        widthCache.set(c.el, { w, at: frame.n + Math.floor(Math.random() * 30) });
        c.w = w;
      }
    }
    // 3. écritures
    for (const el of hide) if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
    for (let i = budget; i < cands.length; i++) {
      const el = cands[i].el;
      if (!cands[i].hov && el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
    }
    cands.length = Math.max(budget, cands.findIndex((c) => c.hov) + 1);
    const placed: number[] = [];
    // budget : au-delà, une étiquette ne dit plus rien (et coûte cher) — seules les plus importantes restent
    let shown = 0;
    let ghosts = 0;
    for (const c of cands) {
      const left = c.x + 16 * c.s;
      const top = c.y - 31 * c.s;
      const rgt = left + (c.w + 6) * c.s;
      const bottom = top + (17 + (c.detail > 0.35 ? 13 : 0)) * c.s;
      let clash = false;
      if (!c.hov) {
        for (let i = 0; i < placed.length; i += 4) {
          if (left < placed[i + 2] && rgt > placed[i] && top < placed[i + 3] && bottom > placed[i + 1]) {
            clash = true;
            break;
          }
        }
      }
      if ((!clash && shown >= MAX_LABELS && !c.hov) || (clash && ghosts >= MAX_GHOST_LABELS)) {
        if (c.el.style.visibility !== 'hidden') c.el.style.visibility = 'hidden';
        continue;
      }
      if (clash) ghosts++;
      else {
        shown++;
        placed.push(left, top, rgt, bottom);
      }
      const el = c.el;
      if (el.style.visibility !== 'visible') el.style.visibility = 'visible';
      el.style.transform = `translate3d(${c.x.toFixed(1)}px,${c.y.toFixed(1)}px,0) scale(${c.s.toFixed(3)})`;
      el.style.opacity = (clash ? c.a * 0.1 : c.a).toFixed(3);
      el.style.zIndex = String(c.hov ? 9999 : Math.max(1, 6000 - Math.round(c.dist * 4)));
      el.style.setProperty('--detail', c.detail.toFixed(2));
      const hv = c.hov ? '1' : '0';
      if (el.dataset.hover !== hv) el.dataset.hover = hv;
      const cl = clash ? '1' : '0';
      if (el.dataset.clutter !== cl) el.dataset.clutter = cl;
    }

    // targeting reticle around the selected / edited constellation
    const rt = reticle.el;
    if (rt) {
      const id = ui.selectedId ?? ui.editorId;
      const n = id ? layout.nodes.get(id) : undefined;
      if (!n || ui.view !== 'network') {
        if (rt.style.opacity !== '0') rt.style.opacity = '0';
      } else {
        v.copy(n.render).project(cam);
        if (v.z > 1) {
          rt.style.opacity = '0';
        } else {
          right.set(1, 0, 0).applyQuaternion(cam.quaternion);
          r.copy(n.render).addScaledVector(right, n.glyph * 2.5).project(cam);
          const x = (v.x * 0.5 + 0.5) * width;
          const y = (-v.y * 0.5 + 0.5) * height;
          const px = Math.abs((r.x - v.x) * 0.5 * width);
          const size = Math.max(36, Math.min(px * 2 + 18, 560));
          rt.style.opacity = '1';
          rt.style.transform = `translate3d(${(x - size / 2).toFixed(1)}px,${(y - size / 2).toFixed(1)}px,0)`;
          rt.style.width = `${size.toFixed(0)}px`;
          rt.style.height = `${size.toFixed(0)}px`;
        }
      }
    }
  }, -1);
  return null;
}
