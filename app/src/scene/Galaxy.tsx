import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { edgeKey, type Structure } from './structure';
import { layout } from './layout';
import { visuals } from './visual';
import { makeLinkMaterial, makeNodeMaterial, makePulseMaterial } from './shaders';
import { PulseSystem, pulseLevel } from './pulses';
import { telemetry } from './telemetry';
import { fx } from '../store/fx';
import { useUI } from '../store/ui';
import { useData } from '../store/data';
import { suggestionsFor } from '../lib/similar';
import { useSession } from '../sync/session';
import { hashString, mulberry32 } from '../lib/random';

const SEG = 22; // segments par connexion
const MAX_GHOST = 4; // connexions possibles affichées en pointillés
const MAX_FADES = 24; // neurones en train de disparaître
const HUGE = new THREE.Sphere(new THREE.Vector3(), 1e6);
/** vitesse d'une impulsion, en unités du monde par seconde (bornée pour les liens très courts ou très longs) */
const PULSE_SPEED = 22;
/** au-delà, les neurones ne répondent plus aux impulsions reçues (pas d'emballement) */
const ECHO_CAP = 260;

function attr(n: number, size: number) {
  return new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * size), size).setUsage(THREE.DynamicDrawUsage);
}

function makeNodeGeo(cap: number) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('iPos', attr(cap, 3));
  g.setAttribute('iColor', attr(cap, 3));
  g.setAttribute('iSize', attr(cap, 1));
  g.setAttribute('iBranches', attr(cap, 1));
  g.setAttribute('iState', attr(cap, 4));
  g.setAttribute('iFx', attr(cap, 4));
  g.setAttribute('iFire', attr(cap, 1));
  g.setAttribute('iPhase', attr(cap, 1));
  g.instanceCount = 0;
  g.boundingSphere = HUGE;
  return g;
}

const LINK_ATTRS: [string, number][] = [
  ['iA', 3],
  ['iC', 3],
  ['iB', 3],
  ['iColA', 3],
  ['iColB', 3],
  ['iP', 4],
  ['iF', 4],
  ['iTrim', 2],
];
const NODE_ATTRS = ['iPos', 'iColor', 'iSize', 'iBranches', 'iState', 'iFx', 'iFire'];

function makeLinkGeo(cap: number) {
  const g = new THREE.InstancedBufferGeometry();
  const verts = (SEG + 1) * 2;
  const t = new Float32Array(verts);
  const side = new Float32Array(verts);
  for (let i = 0; i <= SEG; i++) {
    t[i * 2] = t[i * 2 + 1] = i / SEG;
    side[i * 2] = -1;
    side[i * 2 + 1] = 1;
  }
  const idx: number[] = [];
  for (let i = 0; i < SEG; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  g.setAttribute('aT', new THREE.BufferAttribute(t, 1));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  g.setIndex(idx);
  for (const [name, size] of LINK_ATTRS) g.setAttribute(name, attr(cap, size));
  g.instanceCount = 0;
  g.boundingSphere = HUGE;
  return g;
}

interface Built {
  key: string;
  n: number;
  e: number;
  nodeGeo: THREE.InstancedBufferGeometry;
  linkGeo: THREE.InstancedBufferGeometry;
  index: Map<string, number>;
  edgeIndex: Map<string, number>;
  incident: number[][];
  seeds: Float32Array;
  /** courbe de chaque lien : départ, point de contrôle, arrivée (9 nombres) — pour les impulsions */
  curves: Float32Array;
  flowStart: Float32Array;
  flowDir: Float32Array;
  flowInt: Float32Array;
  flowSpeed: Float32Array;
}

function build(structure: Structure): Built {
  layout.sync(structure.nodes, structure.edges);
  const { nodes, edges } = structure;
  const nodeGeo = makeNodeGeo(nodes.length + MAX_FADES);
  const linkGeo = makeLinkGeo(edges.length + MAX_GHOST);
  const index = new Map(nodes.map((x, i) => [x.id, i]));
  const edgeIndex = new Map(edges.map((x, i) => [x.key, i]));
  const incident: number[][] = nodes.map(() => []);
  edges.forEach((ed, i) => {
    incident[index.get(ed.a)!].push(i);
    incident[index.get(ed.b)!].push(i);
  });
  const ph = nodeGeo.getAttribute('iPhase').array as Float32Array;
  nodes.forEach((x, i) => {
    ph[i] = (hashString(x.id) % 1000) / 1000;
  });
  const seeds = new Float32Array(edges.length * 3);
  edges.forEach((ed, i) => {
    const rng = mulberry32(hashString(ed.key) ^ 0x51ed);
    const u = rng() * 2 - 1;
    const th = rng() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    seeds[i * 3] = s * Math.cos(th);
    seeds[i * 3 + 1] = u;
    seeds[i * 3 + 2] = s * Math.sin(th);
  });
  const cap = edges.length + MAX_GHOST;
  return {
    key: structure.key,
    n: nodes.length,
    e: edges.length,
    nodeGeo,
    linkGeo,
    index,
    edgeIndex,
    incident,
    seeds,
    curves: new Float32Array(cap * 9),
    flowStart: new Float32Array(cap).fill(-100),
    flowDir: new Float32Array(cap).fill(1),
    flowInt: new Float32Array(cap),
    flowSpeed: new Float32Array(cap).fill(0.8),
  };
}

const ease3 = (x: number) => 1 - Math.pow(1 - x, 3);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Fade {
  pos: THREE.Vector3;
  color: THREE.Color;
  size: number;
  t: number;
}

interface Later {
  at: number;
  ei: number;
  from: string;
  intensity: number;
}

export function Galaxy({ structure }: { structure: Structure }) {
  const built = useMemo(() => build(structure), [structure]);
  const builtRef = useRef(built);
  builtRef.current = built;
  const mats = useMemo(() => ({ node: makeNodeMaterial(), link: makeLinkMaterial(), pulse: makePulseMaterial() }), []);
  const pulses = useMemo(() => new PulseSystem(), []);
  if (import.meta.env.DEV) (window as unknown as { __galaxy: unknown }).__galaxy = { builtRef, mats, pulses };
  const clock = useRef(0);
  const fades = useRef<Fade[]>([]);
  const later = useRef<Later[]>([]);
  const pending = useRef<{ a: string; b: string; until: number; intensity: number }[]>([]);
  const act = useRef({ sel: null as string | null, next: 0, hov: null as string | null, ghosts: [] as string[], ghostFor: null as string | null, ghostAt: -100 });
  const hood = useRef({ id: null as string | null, key: '', n1: new Set<string>(), n2: new Set<string>() });
  const timers = useRef({ ambient: 0, hover: 0, stats: 0, waves: 0, boot: 60, level: pulseLevel() as string });
  const tmp = useMemo(() => ({ ab: new THREE.Vector3(), seed: new THREE.Vector3(), perp: new THREE.Vector3() }), []);

  useEffect(() => {
    // le réseau a changé : les impulsions en vol suivaient les anciens liens
    pulses.dropEdgePulses();
    later.current = [];
    return () => {
      built.nodeGeo.dispose();
      built.linkGeo.dispose();
    };
  }, [built, pulses]);
  useEffect(() => () => pulses.geo.dispose(), [pulses]);

  /** Une impulsion part d'un neurone et parcourt une connexion (l'axone s'allume autour d'elle) */
  const fire = useMemo(
    () => (ei: number, from: string, intensity: number, delay = 0) => {
      const b = builtRef.current;
      const ed = layout.edges[ei];
      if (!ed || ei >= b.e) return;
      if (delay > 0) {
        later.current.push({ at: clock.current + delay, ei, from, intensity });
        return;
      }
      const fromA = ed.a === from;
      const c = ei * 9;
      const len = Math.hypot(b.curves[c + 6] - b.curves[c], b.curves[c + 7] - b.curves[c + 1], b.curves[c + 8] - b.curves[c + 2]) || 30;
      const speed = Math.max(0.28, Math.min(0.9, PULSE_SPEED / len));
      // l'axone s'allume (une onde à la fois par lien : la plus forte l'emporte)
      const age = clock.current - b.flowStart[ei];
      if (!(age > -0.1 && age * b.flowSpeed[ei] < 0.8 && b.flowInt[ei] > intensity)) {
        b.flowStart[ei] = clock.current;
        b.flowDir[ei] = fromA ? 1 : -1;
        b.flowInt[ei] = intensity;
        b.flowSpeed[ei] = speed;
      }
      timers.current.waves++;
      if (pulseLevel() === 'off') return;
      const src = b.index.get(from);
      const dst = b.index.get(fromA ? ed.b : ed.a);
      if (src === undefined) return;
      const sv = visuals.get(from);
      pulses.pulse(ei, fromA, intensity * (sv.done ? 0.5 : 1), sv.color, dst ?? -1, speed);
    },
    [pulses],
  );
  // activation qui se propage : voisins directs, puis voisins des voisins
  const fireAround = useMemo(
    () => (id: string, intensity: number, deep = false) => {
      const b = builtRef.current;
      const i = b.index.get(id);
      if (i === undefined) return;
      for (const ei of b.incident[i] ?? []) {
        fire(ei, id, intensity, Math.random() * 0.12);
        if (!deep) continue;
        const ed = layout.edges[ei];
        const other = ed.a === id ? ed.b : ed.a;
        const j = b.index.get(other);
        if (j === undefined) continue;
        for (const ej of b.incident[j]) if (ej !== ei) fire(ej, other, intensity * 0.55, 0.9 + Math.random() * 0.4);
      }
    },
    [fire],
  );

  useEffect(
    () =>
      fx.on((ev) => {
        const lvl = pulseLevel();
        if (ev.kind === 'celebrate') {
          const node = layout.nodes.get(ev.id);
          if (node) {
            node.ripple = 0.001;
            node.flash = Math.max(node.flash, 1.2);
            if (lvl !== 'off') pulses.burst(node.render, visuals.get(ev.id).color, lvl === 'vif' ? 70 : 30, 16, 1.6);
          }
          fireAround(ev.id, 1.2, true);
        } else if (ev.kind === 'touch') {
          const node = layout.nodes.get(ev.id);
          if (node) node.flash = Math.max(node.flash, 0.3);
          fireAround(ev.id, 0.5);
        } else if (ev.kind === 'link') {
          pending.current.push({ a: ev.a, b: ev.b, until: performance.now() + 2500, intensity: 1.1 });
        } else if (ev.kind === 'strengthen') {
          pending.current.push({ a: ev.a, b: ev.b, until: performance.now() + 1500, intensity: 0.9 });
        } else if (ev.kind === 'death') {
          const node = layout.nodes.get(ev.id);
          if (node) {
            fades.current.push({ pos: node.render.clone(), color: visuals.get(ev.id).color, size: node.size || 1, t: 0 });
            if (fades.current.length > MAX_FADES) fades.current.shift();
          }
        }
      }),
    [fireAround, pulses],
  );

  useFrame((state, rawDt) => {
    const b = builtRef.current;
    const dt = Math.min(rawDt, 0.05);
    const t = state.clock.elapsedTime;
    clock.current = t;
    const L = layout.list;
    if (L.length !== b.n) return; // structure en cours de changement
    visuals.refresh();
    const level = pulseLevel();
    if (level !== timers.current.level) {
      timers.current.level = level;
      if (level === 'off') pulses.clearAll();
    }

    const cam = state.camera as THREE.PerspectiveCamera;
    const dpr = state.gl.getPixelRatio();
    const scale = (state.size.height * dpr) / (2 * Math.tan((cam.fov * Math.PI) / 360));
    mats.node.uniforms.uTime.value = t;
    mats.node.uniforms.uScale.value = scale;
    mats.node.uniforms.uMotion.value = reducedMotion() ? 0.3 : level === 'calme' ? 0.6 : 1;
    mats.pulse.uniforms.uScale.value = scale;
    mats.link.uniforms.uTime.value = t;
    mats.link.uniforms.uRes.value.set(state.size.width, state.size.height);
    mats.link.uniforms.uGain.value = Math.max(0.3, Math.min(1, 1.25 / Math.sqrt(Math.max(1, b.e / 120))));

    const ui = useUI.getState();
    const data = useData.getState();
    const ents = data.entities;
    const selId = ui.editorId ?? ui.selectedId;
    const hovId = ui.hoveredId;

    // voisinage de la sélection : 1er et 2e degrés
    const hd = hood.current;
    if (hd.id !== selId || hd.key !== b.key) {
      hd.id = selId;
      hd.key = b.key;
      hd.n1 = new Set();
      hd.n2 = new Set();
      const si = selId ? b.index.get(selId) : undefined;
      if (selId && si !== undefined) {
        for (const ei of b.incident[si]) {
          const ed = layout.edges[ei];
          hd.n1.add(ed.a === selId ? ed.b : ed.a);
        }
        for (const o of hd.n1) {
          const oi = b.index.get(o);
          if (oi === undefined) continue;
          for (const ei of b.incident[oi]) {
            const ed = layout.edges[ei];
            const x = ed.a === o ? ed.b : ed.a;
            if (x !== selId && !hd.n1.has(x)) hd.n2.add(x);
          }
        }
      }
    }

    // activation à la sélection, puis une respiration toutes les 4 s tant que la pensée est ouverte
    const ac = act.current;
    if (selId !== ac.sel) {
      ac.sel = selId;
      ac.next = t + 4;
      if (selId) fireAround(selId, 1.0, true);
    } else if (selId && t > ac.next) {
      ac.next = t + (level === 'vif' ? 4 : 7);
      fireAround(selId, 0.55);
    }
    if (hovId !== ac.hov) {
      ac.hov = hovId;
      if (hovId && hovId !== selId) fireAround(hovId, 0.6);
    }
    // connexions possibles (pointillés) autour de la sélection
    if (selId !== ac.ghostFor || t - ac.ghostAt > 5) {
      ac.ghostFor = selId;
      ac.ghostAt = t;
      ac.ghosts = selId ? suggestionsFor(ents, data.links, selId, 3, 0.2).map((s) => s.e.id) : [];
    }

    const tagsOn = ui.activeTags.length > 0;
    const hits = ui.searchHits;
    // aperçu « voir comme » : seulement ce que cet invité a le droit de voir
    const sess = useSession.getState();
    const pm = sess.previewAs ? sess.members[sess.previewAs] : null;
    const pScope = pm?.scope && pm.scope.all === false ? pm.scope.tags : null;
    const k2 = 1 - Math.exp(-dt * 2.2);
    const k3 = 1 - Math.exp(-dt * 3);
    const k5 = 1 - Math.exp(-dt * 5);
    const k9 = 1 - Math.exp(-dt * 9);

    const na = b.nodeGeo.attributes;
    const P = na.iPos.array as Float32Array;
    const C = na.iColor.array as Float32Array;
    const S = na.iSize.array as Float32Array;
    const BR = na.iBranches.array as Float32Array;
    const ST = na.iState.array as Float32Array;
    const FX = na.iFx.array as Float32Array;
    const FI = na.iFire.array as Float32Array;

    for (let i = 0; i < L.length; i++) {
      const node = L[i];
      const v = visuals.get(node.id);
      const ent = ents[node.id];
      let vis = 1;
      if (ui.hiddenNatures.includes(v.nature)) vis = 0;
      else if (pm && (!ent || ent.private || (pScope && !ent.tags.some((t) => pScope.includes(t))))) vis = 0;
      else {
        if (tagsOn && !(ent && ent.tags.some((tg) => ui.activeTags.includes(tg)))) vis = 0.1;
        if (ui.orphansOnly && v.degree > 0) vis = Math.min(vis, 0.1);
        if (hits && !hits.has(node.id)) vis = Math.min(vis, 0.12);
        if (selId && selId !== node.id) vis = Math.min(vis, hd.n1.has(node.id) ? 1 : hd.n2.has(node.id) ? 0.5 : 0.18);
      }
      node.vis += (vis - node.vis) * k5;
      node.hover += ((hovId === node.id ? 1 : 0) - node.hover) * k9;
      node.sel += ((selId === node.id ? 1 : 0) - node.sel) * k5;
      node.done += (v.done - node.done) * k2;
      node.hub += (v.hub - node.hub) * k3;
      node.alert += (v.alert - node.alert) * k3;
      node.flash *= Math.exp(-dt * 2.3);
      if (node.birth < 1) node.birth = Math.min(1, node.birth + dt * node.birthSpeed);
      if (node.birth >= 1 && !node.bornFlashed) {
        node.bornFlashed = true;
        // au réveil d'un grand réseau, seule une partie des neurones s'annonce : un frémissement, pas une tempête
        if (timers.current.boot > 0 || v.vitality > 0.6) {
          const booting = timers.current.boot > 0;
          timers.current.boot--;
          node.ripple = 0.001;
          node.flash = Math.max(node.flash, 0.8);
          fireAround(node.id, 0.9);
          // une pensée qui vient d'être capturée naît dans un éclat d'étincelles
          if (!booting && level !== 'off') pulses.burst(node.render, v.color, level === 'vif' ? 26 : 12, 9, 1.1);
        }
      }
      if (node.ripple > 0) {
        node.ripple += dt / 1.6;
        if (node.ripple >= 1) node.ripple = 0;
      }
      const be = ease3(clamp01(node.birth));
      const breathe = v.active ? 1 + 0.12 * Math.sin(t * 2.1 + i) : 1;
      node.bright += ((0.3 + 0.7 * v.vitality) * breathe - node.bright) * k3;
      node.size += (v.glyph - node.size) * k3;
      const bright = node.bright * node.vis * be * (1 + node.hover * 0.45 + node.sel * 0.3 + node.flash * 0.55);
      const size = node.size * (0.35 + 0.65 * be) * (1 + node.hover * 0.12 + node.flash * 0.1);

      P[i * 3] = node.render.x;
      P[i * 3 + 1] = node.render.y;
      P[i * 3 + 2] = node.render.z;
      C[i * 3] = v.color.r;
      C[i * 3 + 1] = v.color.g;
      C[i * 3 + 2] = v.color.b;
      S[i] = size;
      BR[i] = v.branches;
      ST[i * 4] = bright;
      ST[i * 4 + 1] = node.done;
      ST[i * 4 + 2] = node.hub;
      ST[i * 4 + 3] = node.alert * Math.min(1, node.vis * 2);
      FX[i * 4] = node.sel;
      FX[i * 4 + 1] = node.hover * (1 - node.sel);
      FX[i * 4 + 2] = node.ripple;
      FX[i * 4 + 3] = v.active * Math.min(1, node.vis * 2);
      FI[i] = node.flash * Math.min(1, node.vis * 2);
    }

    // neurones qui disparaissent : une dernière onde, puis plus rien
    let count = L.length;
    fades.current = fades.current.filter((f) => (f.t += dt / 1.4) < 1);
    for (const f of fades.current) {
      if (count >= b.n + MAX_FADES) break;
      const i = count++;
      P[i * 3] = f.pos.x;
      P[i * 3 + 1] = f.pos.y;
      P[i * 3 + 2] = f.pos.z;
      C[i * 3] = f.color.r;
      C[i * 3 + 1] = f.color.g;
      C[i * 3 + 2] = f.color.b;
      S[i] = f.size;
      BR[i] = -1;
      ST[i * 4] = 1 - f.t;
      ST[i * 4 + 1] = 0;
      ST[i * 4 + 2] = 0;
      ST[i * 4 + 3] = 0;
      FX[i * 4] = 0;
      FX[i * 4 + 1] = 0;
      FX[i * 4 + 2] = Math.max(0.001, f.t);
      FX[i * 4 + 3] = 0;
      FI[i] = 0;
    }
    b.nodeGeo.instanceCount = count;
    for (const k of NODE_ATTRS) na[k].needsUpdate = true;
    if (b.n) na.iPhase.needsUpdate = true;

    // ── connexions
    const la = b.linkGeo.attributes;
    const A3 = la.iA.array as Float32Array;
    const C3 = la.iC.array as Float32Array;
    const B3 = la.iB.array as Float32Array;
    const CA = la.iColA.array as Float32Array;
    const CB = la.iColB.array as Float32Array;
    const PP = la.iP.array as Float32Array;
    const FF = la.iF.array as Float32Array;
    const TR = la.iTrim.array as Float32Array;
    const CU = b.curves;
    const { ab, seed, perp } = tmp;
    const writeCurve = (k: number, A: (typeof L)[number], B: (typeof L)[number], sx: number, sy: number, sz: number) => {
      ab.subVectors(B.render, A.render);
      const dist = ab.length() || 1;
      seed.set(sx, sy, sz);
      perp.crossVectors(ab, seed);
      if (perp.lengthSq() < 1e-8) perp.set(0, 1, 0);
      perp.normalize();
      const bend = dist * 0.12;
      const cx = (A.render.x + B.render.x) * 0.5 + perp.x * bend;
      const cy = (A.render.y + B.render.y) * 0.5 + perp.y * bend;
      const cz = (A.render.z + B.render.z) * 0.5 + perp.z * bend;
      A3[k * 3] = A.render.x;
      A3[k * 3 + 1] = A.render.y;
      A3[k * 3 + 2] = A.render.z;
      B3[k * 3] = B.render.x;
      B3[k * 3 + 1] = B.render.y;
      B3[k * 3 + 2] = B.render.z;
      C3[k * 3] = cx;
      C3[k * 3 + 1] = cy;
      C3[k * 3 + 2] = cz;
      CU[k * 9] = A.render.x;
      CU[k * 9 + 1] = A.render.y;
      CU[k * 9 + 2] = A.render.z;
      CU[k * 9 + 3] = cx;
      CU[k * 9 + 4] = cy;
      CU[k * 9 + 5] = cz;
      CU[k * 9 + 6] = B.render.x;
      CU[k * 9 + 7] = B.render.y;
      CU[k * 9 + 8] = B.render.z;
      TR[k * 2] = Math.min(0.45, (A.size * 1.35) / dist);
      TR[k * 2 + 1] = Math.max(0.55, 1 - (B.size * 1.35) / dist);
      const ca = visuals.get(A.id).color;
      const cb = visuals.get(B.id).color;
      CA[k * 3] = ca.r;
      CA[k * 3 + 1] = ca.g;
      CA[k * 3 + 2] = ca.b;
      CB[k * 3] = cb.r;
      CB[k * 3 + 1] = cb.g;
      CB[k * 3 + 2] = cb.b;
    };

    const E = layout.edges.length === b.e ? b.e : 0;
    for (let ei = 0; ei < E; ei++) {
      const ia = layout.edgeIdx[ei * 2];
      const ib = layout.edgeIdx[ei * 2 + 1];
      if (ia < 0 || ib < 0) continue;
      const A = L[ia];
      const B = L[ib];
      const ed = layout.edges[ei];
      writeCurve(ei, A, B, b.seeds[ei * 3], b.seeds[ei * 3 + 1], b.seeds[ei * 3 + 2]);
      const ev = visuals.edges.get(ed.key);
      let eb = Math.min(A.vis, B.vis) * Math.min(ease3(clamp01(A.birth)), ease3(clamp01(B.birth)));
      if (selId && (ed.a === selId || ed.b === selId)) eb *= 1.45;
      else if (hovId && (ed.a === hovId || ed.b === hovId)) eb *= 1.3;
      eb *= 1 - 0.45 * Math.max(A.done, B.done);
      PP[ei * 4] = ev?.strength ?? 0.5;
      PP[ei * 4 + 1] = eb;
      PP[ei * 4 + 2] = ev?.fresh ?? 0;
      PP[ei * 4 + 3] = 0;
      FF[ei * 4] = b.flowStart[ei];
      FF[ei * 4 + 1] = b.flowDir[ei];
      // une impulsion sur un lien à peine visible ne l'allume pas
      FF[ei * 4 + 2] = b.flowInt[ei] * Math.min(1, eb * 1.6);
      FF[ei * 4 + 3] = b.flowSpeed[ei];
    }
    let lc = E;
    const si = selId ? b.index.get(selId) : undefined;
    if (si !== undefined && ac.ghostFor === selId) {
      for (const gid of ac.ghosts) {
        const gi = b.index.get(gid);
        if (gi === undefined || lc >= b.e + MAX_GHOST) continue;
        const A = L[si];
        const B = L[gi];
        writeCurve(lc, A, B, 0.3, 0.9, 0.2);
        PP[lc * 4] = 0.35;
        PP[lc * 4 + 1] = Math.min(A.vis, Math.max(B.vis, 0.5)) * 0.95;
        PP[lc * 4 + 2] = 0;
        PP[lc * 4 + 3] = 1;
        FF[lc * 4 + 2] = 0;
        lc++;
      }
    }
    b.linkGeo.instanceCount = lc;
    for (const [k] of LINK_ATTRS) la[k].needsUpdate = true;

    // ondes en attente (le lien apparaît une image après le changement de données)
    if (pending.current.length) {
      const nowMs = performance.now();
      pending.current = pending.current.filter((p) => {
        const ei = b.edgeIndex.get(edgeKey(p.a, p.b));
        if (ei === undefined || ei >= E) return nowMs < p.until;
        fire(ei, p.a, p.intensity);
        // et la réponse de l'autre neurone, un instant plus tard : ils s'échangent une première impulsion
        fire(ei, p.b, p.intensity * 0.8, 0.5);
        const n = layout.nodes.get(p.a);
        if (n) {
          n.flash = Math.max(n.flash, 0.5);
          if (level === 'vif') pulses.burst(n.render, visuals.get(p.a).color, 14, 7, 0.9);
        }
        return false;
      });
    }
    // impulsions programmées (propagation vers les voisins des voisins, réponses)
    if (later.current.length) {
      const due = later.current.filter((x) => x.at <= t);
      if (due.length) {
        later.current = later.current.filter((x) => x.at > t);
        for (const x of due) fire(x.ei, x.from, x.intensity);
      }
      if (later.current.length > 400) later.current.splice(0, later.current.length - 400);
    }

    // ── impulsions : déplacement, arrivées
    pulses.update(dt, b.curves, E);
    const arrivals = pulses.arrivals;
    if (arrivals.length) {
      const inFlight = pulses.active;
      for (const a of arrivals) {
        const node = a.target >= 0 ? L[a.target] : undefined;
        if (!node) continue;
        // le neurone touché s'illumine…
        node.flash = Math.min(2.2, node.flash + 0.35 * a.strength);
        if (level !== 'vif' || inFlight > ECHO_CAP || a.strength < 0.3 || node.vis < 0.3) continue;
        const ed = layout.edges[a.edge];
        if (!ed) continue;
        const r = Math.random();
        if (r < 0.32) {
          // …et parfois il répond : les deux neurones s'échangent l'impulsion
          fire(a.edge, node.id, a.strength * 0.62, 0.12 + Math.random() * 0.35);
        } else if (r < 0.52) {
          // …ou il la transmet plus loin, à un de ses autres voisins
          const inc = b.incident[a.target];
          if (inc && inc.length > 1) {
            const next = inc[Math.floor(Math.random() * inc.length)];
            if (next !== a.edge) fire(next, node.id, a.strength * 0.55, 0.1 + Math.random() * 0.25);
          }
        }
      }
    }

    // vie ambiante : des impulsions spontanées, de préférence sur les liens forts entre neurones vivants,
    // plus nombreuses quand tu voles dans le réseau
    const tm = timers.current;
    const rate =
      level === 'vif'
        ? (1.7 + Math.min(telemetry.speed, 60) * 0.12) * Math.min(2.2, Math.max(1, Math.sqrt(E / 60)))
        : level === 'calme'
          ? 0.6
          : 0.85;
    tm.ambient += dt * rate;
    // le neurone survolé envoie un flot d'impulsions à ses voisins
    const hi = hovId && level !== 'off' ? b.index.get(hovId) : undefined;
    if (hi !== undefined && b.incident[hi].length) {
      tm.hover += dt * (level === 'vif' ? 4 : 1.5);
      while (tm.hover > 1) {
        tm.hover -= 1;
        const list = b.incident[hi];
        fire(list[Math.floor(Math.random() * list.length)], hovId!, 0.85);
      }
    }
    while (E > 0 && tm.ambient > 1) {
      tm.ambient -= 1;
      let best = -1;
      let bestScore = 0;
      for (let k = 0; k < 5; k++) {
        const ei = Math.floor(Math.random() * E);
        const A = L[layout.edgeIdx[ei * 2]];
        const B = L[layout.edgeIdx[ei * 2 + 1]];
        if (!A || !B) continue;
        const ev = visuals.edges.get(layout.edges[ei].key);
        const s = (ev?.strength ?? 0.5) * (1 + (ev?.fresh ?? 0)) * Math.min(A.vis, B.vis) * Math.max(A.bright, B.bright);
        if (s > bestScore) {
          bestScore = s;
          best = ei;
        }
      }
      if (best >= 0 && bestScore > 0.06) {
        const ed = layout.edges[best];
        const A = L[layout.edgeIdx[best * 2]];
        const B = L[layout.edgeIdx[best * 2 + 1]];
        // le neurone le plus vivant parle le premier (au hasard s'ils se valent)
        const fromA = Math.abs(A.bright - B.bright) < 0.08 ? Math.random() < 0.5 : A.bright > B.bright;
        fire(best, fromA ? ed.a : ed.b, 0.42 + Math.random() * 0.3);
      }
    }
    tm.stats += dt;
    if (tm.stats > 2) {
      telemetry.pulsesPerMin = telemetry.pulsesPerMin * 0.5 + (tm.waves / tm.stats) * 60 * 0.5;
      tm.waves = 0;
      tm.stats = 0;
    }
  }, -2);

  return (
    <group>
      <mesh geometry={built.linkGeo} material={mats.link} frustumCulled={false} renderOrder={1} />
      <mesh geometry={built.nodeGeo} material={mats.node} frustumCulled={false} renderOrder={2} />
      <points geometry={pulses.geo} material={mats.pulse} frustumCulled={false} renderOrder={3} />
    </group>
  );
}
