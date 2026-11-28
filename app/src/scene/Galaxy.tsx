import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { Structure } from './structure';
import { layout, CORE, RADIUS } from './layout';
import { buildConstellation, densityFor, type CGeo } from './constellation';
import { makeCoreMaterial, makeLineMaterial, makePointMaterial } from './shaders';
import { PulseSystem } from './pulses';
import { telemetry } from './telemetry';
import { fx } from '../store/fx';
import { useUI } from '../store/ui';
import { useData } from '../store/data';
import { mulberry32, hashString } from '../lib/random';

const SEG = 22; // segments per axon curve
const STREAM_PER = 12; // flowing particles per connection

interface Built {
  key: string;
  n: number;
  e: number;
  geos: CGeo[];
  offsets: Int32Array;
  baseColor: THREE.Color[];
  pos: Float32Array;
  ints: Float32Array;
  streamStart: number;
  streamU: Float32Array;
  streamSpeed: Float32Array;
  streamOff: Float32Array;
  pointsGeo: THREE.BufferGeometry;
  webGeo: THREE.BufferGeometry;
  bundleGeo: THREE.BufferGeometry;
  axonGeo: THREE.BufferGeometry;
  axonPos: Float32Array;
  axonCol: Float32Array;
  curves: Float32Array;
  edgeSeed: Float32Array;
  edgeKey: Map<string, number>;
  incident: number[][];
}

const HUGE = new THREE.Sphere(new THREE.Vector3(), 1e6);

function build(structure: Structure): Built {
  layout.sync(structure.nodes, structure.edges);
  const { nodes, edges } = structure;
  const density = densityFor(nodes.map((n) => n.type));
  const geos = nodes.map((n) => buildConstellation(n.id, n.type, n.color, density, RADIUS[n.type]));
  const baseColor = nodes.map((n) => new THREE.Color(n.color));

  const offsets = new Int32Array(nodes.length);
  let total = 0;
  geos.forEach((g, i) => {
    offsets[i] = total;
    total += g.count;
  });
  const streamStart = total;
  total += edges.length * STREAM_PER;

  const pos = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const sizes = new Float32Array(total);
  const ints = new Float32Array(total);
  const phases = new Float32Array(total);
  geos.forEach((g, i) => {
    const o = offsets[i];
    colors.set(g.colors, o * 3);
    sizes.set(g.sizes, o);
    phases.set(g.phases, o);
  });

  // flowing particles along each connection
  const streamU = new Float32Array(edges.length * STREAM_PER);
  const streamSpeed = new Float32Array(edges.length * STREAM_PER);
  const streamOff = new Float32Array(edges.length * STREAM_PER * 2);
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const tmp = new THREE.Color();
  const white = new THREE.Color(1, 1, 1);
  edges.forEach((e, ei) => {
    const rng = mulberry32(hashString(e.key));
    const ca = baseColor[index.get(e.a)!];
    const cb = baseColor[index.get(e.b)!];
    for (let s = 0; s < STREAM_PER; s++) {
      const k = ei * STREAM_PER + s;
      const p = streamStart + k;
      streamU[k] = rng();
      streamSpeed[k] = (0.025 + rng() * 0.05) * (rng() < 0.5 ? 1 : -1);
      streamOff[k * 2] = (rng() - 0.5) * 2.4;
      streamOff[k * 2 + 1] = (rng() - 0.5) * 2.4;
      tmp.copy(rng() < 0.5 ? ca : cb).lerp(white, 0.25 + rng() * 0.3);
      colors[p * 3] = tmp.r;
      colors[p * 3 + 1] = tmp.g;
      colors[p * 3 + 2] = tmp.b;
      sizes[p] = 0.2 + rng() * 0.3;
      phases[p] = rng();
    }
  });

  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(colors, 3);
  const intAttr = new THREE.BufferAttribute(ints, 1).setUsage(THREE.DynamicDrawUsage);
  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute('position', posAttr);
  pointsGeo.setAttribute('aColor', colAttr);
  pointsGeo.setAttribute('aInt', intAttr);
  pointsGeo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  pointsGeo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  pointsGeo.boundingSphere = HUGE;

  // neural web inside constellations: indexes into the shared particle buffer
  const web: number[] = [];
  geos.forEach((g, i) => {
    const o = offsets[i];
    for (let k = 0; k < g.web.length; k++) web.push(g.web[k] + o);
  });
  const webGeo = new THREE.BufferGeometry();
  webGeo.setAttribute('position', posAttr);
  webGeo.setAttribute('aColor', colAttr);
  webGeo.setAttribute('aInt', intAttr);
  webGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(web), 1));
  webGeo.boundingSphere = HUGE;

  // fibre bundles between connected constellations (particle → particle)
  const bundle: number[] = [];
  const incident: number[][] = nodes.map(() => []);
  const edgeKey = new Map<string, number>();
  edges.forEach((e, ei) => {
    const ia = index.get(e.a)!;
    const ib = index.get(e.b)!;
    incident[ia].push(ei);
    incident[ib].push(ei);
    edgeKey.set(e.key, ei);
    const rng = mulberry32(hashString(e.key) ^ 0xabcdef);
    const K = e.kind === 'parent' ? 9 : 6;
    for (let k = 0; k < K; k++) {
      bundle.push(offsets[ia] + Math.floor(rng() * geos[ia].count), offsets[ib] + Math.floor(rng() * geos[ib].count));
    }
  });
  const bundleGeo = new THREE.BufferGeometry();
  bundleGeo.setAttribute('position', posAttr);
  bundleGeo.setAttribute('aColor', colAttr);
  bundleGeo.setAttribute('aInt', intAttr);
  bundleGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(bundle), 1));
  bundleGeo.boundingSphere = HUGE;

  // (V6 : plus de halo flou autour des noyaux. Il formait une « aura » désagréable dès qu'on s'éloignait ;
  // l'éclat néon vient des noyaux et des particules eux-mêmes)

  // axons: curved lines between nuclei, carrying the impulses
  const axonPos = new Float32Array(edges.length * SEG * 2 * 3);
  const axonCol = new Float32Array(edges.length * SEG * 2 * 3);
  const axonGeo = new THREE.BufferGeometry();
  axonGeo.setAttribute('position', new THREE.BufferAttribute(axonPos, 3).setUsage(THREE.DynamicDrawUsage));
  axonGeo.setAttribute('aColor', new THREE.BufferAttribute(axonCol, 3).setUsage(THREE.DynamicDrawUsage));
  axonGeo.setAttribute('aInt', new THREE.BufferAttribute(new Float32Array(edges.length * SEG * 2).fill(1), 1));
  axonGeo.boundingSphere = HUGE;

  const edgeSeed = new Float32Array(edges.length * 3);
  edges.forEach((e, ei) => {
    const rng = mulberry32(hashString(e.key) ^ 0x51ed);
    const u = rng() * 2 - 1;
    const th = rng() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    edgeSeed[ei * 3] = s * Math.cos(th);
    edgeSeed[ei * 3 + 1] = u;
    edgeSeed[ei * 3 + 2] = s * Math.sin(th);
  });

  return {
    key: structure.key,
    n: nodes.length,
    e: edges.length,
    geos,
    offsets,
    baseColor,
    pos,
    ints,
    streamStart,
    streamU,
    streamSpeed,
    streamOff,
    pointsGeo,
    webGeo,
    bundleGeo,
    axonGeo,
    axonPos,
    axonCol,
    curves: new Float32Array(edges.length * 9),
    edgeSeed,
    edgeKey,
    incident,
  };
}

const ease3 = (x: number) => 1 - Math.pow(1 - x, 3);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function Galaxy({ structure }: { structure: Structure }) {
  const built = useMemo(() => build(structure), [structure]);
  const builtRef = useRef(built);
  builtRef.current = built;

  const mats = useMemo(
    () => ({
      points: makePointMaterial(1.15, 90),
      pulses: makePointMaterial(1.1, 60),
      web: makeLineMaterial(0.3),
      bundle: makeLineMaterial(0.07),
      axon: makeLineMaterial(1),
      core: makeCoreMaterial(),
    }),
    [],
  );
  const coreGeo = useMemo(() => new THREE.SphereGeometry(1, 28, 20), []);
  const pulses = useMemo(() => new PulseSystem(), []);
  const coresRef = useRef<THREE.InstancedMesh>(null);
  /**
   * V8.1 : tout le réseau est dessiné par rapport à un repère qui suit la caméra (« origine flottante ») : les positions
   * envoyées à la carte graphique restent petites, même pour un neurone posé à des millions d'unités. Pas de tremblement,
   * quelle que soit la distance.
   */
  const groupRef = useRef<THREE.Group>(null);
  const origin = useMemo(() => new THREE.Vector3(), []);
  const tmpO = useMemo(() => new THREE.Vector3(), []);
  const linkQueue = useRef<{ a: string; b: string; until: number }[]>([]);
  const timers = useRef({ idle: 0, hover: 0, stats: 0, spawnedAt: 0 });

  useEffect(() => {
    pulses.dropEdgePulses();
    return () => {
      built.pointsGeo.dispose();
      built.webGeo.dispose();
      built.bundleGeo.dispose();
      built.axonGeo.dispose();
    };
  }, [built, pulses]);

  // visual effects triggered by data changes
  useEffect(() => {
    const emitFrom = (nodeIdx: number, strength: number, onlyTo?: Set<string>) => {
      const b = builtRef.current;
      const node = layout.list[nodeIdx];
      if (!node) return;
      for (const ei of b.incident[nodeIdx] ?? []) {
        const edge = layout.edges[ei];
        if (!edge) continue;
        const fromA = edge.a === node.id;
        const otherId = fromA ? edge.b : edge.a;
        if (onlyTo && !onlyTo.has(otherId)) continue;
        const target = layout.list.findIndex((x) => x.id === otherId);
        pulses.pulse(ei, fromA, strength, b.baseColor[nodeIdx], target);
      }
    };
    const idxOf = (id: string) => layout.list.findIndex((n) => n.id === id);
    return fx.on((e) => {
      const b = builtRef.current;
      if (e.kind === 'celebrate') {
        const i = idxOf(e.id);
        if (i < 0) return;
        const node = layout.list[i];
        node.flash = 2.4;
        pulses.burst(node.render, b.baseColor[i], 70, 16, 1.6);
        emitFrom(i, 2.2);
        // second wave toward the parent project
        const ent = useData.getState().entities[e.id];
        if (ent?.type === 'task' && ent.projectId) {
          const pid = ent.projectId;
          setTimeout(() => {
            const j = idxOf(e.id);
            if (j >= 0) emitFrom(j, 2.4, new Set([pid]));
          }, 350);
        }
      } else if (e.kind === 'touch') {
        const i = idxOf(e.id);
        if (i >= 0) {
          emitFrom(i, 0.9);
          layout.list[i].flash = Math.max(layout.list[i].flash, 0.35);
        }
      } else if (e.kind === 'link') {
        linkQueue.current.push({ a: e.a, b: e.b, until: performance.now() + 2000 });
      } else if (e.kind === 'death') {
        const i = idxOf(e.id);
        if (i < 0) return;
        pulses.burst(layout.list[i].render, b.baseColor[i], 90, 22, 1.8);
      }
    });
  }, [pulses]);

  const q = useMemo(() => new THREE.Quaternion(), []);
  const m = useMemo(() => new THREE.Matrix4(), []);
  const tmpM = useMemo(() => new THREE.Matrix4(), []);
  const tmpV = useMemo(() => new THREE.Vector3(), []);
  const tmpS = useMemo(() => new THREE.Vector3(), []);
  const tmpQ = useMemo(() => new THREE.Quaternion(), []);
  const tmpC = useMemo(() => new THREE.Color(), []);
  const perp = useMemo(() => new THREE.Vector3(), []);
  const bin = useMemo(() => new THREE.Vector3(), []);
  const ab = useMemo(() => new THREE.Vector3(), []);
  const neighborCache = useRef<{ id: string | null; key: string; set: Set<string> }>({ id: null, key: '', set: new Set() });

  useFrame((state, rawDt) => {
    const b = builtRef.current;
    const dt = Math.min(rawDt, 0.05);
    const t = state.clock.elapsedTime;
    const L = layout.list;
    if (L.length !== b.n) return; // structure in flux

    // shader uniforms
    const cam = state.camera as THREE.PerspectiveCamera;
    const scale = (state.size.height * state.gl.getPixelRatio()) / (2 * Math.tan((cam.fov * Math.PI) / 360));
    // les fondus avec la distance s'agrandissent avec le réseau : un réseau très espacé (ou un neurone posé très loin)
    // reste visible de loin, comme un réseau normal
    const vs = layout.viewScale;
    for (const mat of [mats.points, mats.pulses]) {
      mat.uniforms.uTime.value = t;
      mat.uniforms.uScale.value = scale;
      (mat.uniforms.uFar.value as THREE.Vector2).set(420 * vs, 1300 * vs);
    }
    for (const mat of [mats.web, mats.bundle, mats.axon]) (mat.uniforms.uFar.value as THREE.Vector2).set(320 * vs, 900 * vs);
    // l'origine flottante : la caméra (tout ce qui suit est écrit par rapport à elle)
    const O = origin.copy(cam.position);
    if (groupRef.current) groupRef.current.position.copy(O);

    const ui = useUI.getState();
    const ents = useData.getState().entities;
    const selId = ui.editorId ?? ui.selectedId;
    const nc = neighborCache.current;
    if (nc.id !== selId || nc.key !== b.key) {
      nc.id = selId;
      nc.key = b.key;
      nc.set = selId ? layout.neighbors(selId) : new Set();
    }
    const tagsOn = ui.activeTags.length > 0;
    const k5 = 1 - Math.exp(-dt * 5);
    const k9 = 1 - Math.exp(-dt * 9);
    const k2 = 1 - Math.exp(-dt * 2);

    const { pos, ints } = b;
    const me = m.elements;
    const cores = coresRef.current;

    for (let i = 0; i < L.length; i++) {
      const node = L[i];
      const ent = ents[node.id];
      let vis = 1;
      if (ui.hiddenTypes.includes(node.type)) vis = 0;
      else {
        if (tagsOn) {
          const ok = !!ent && Array.isArray(ent.tags) && ent.tags.some((tg) => ui.activeTags.includes(tg));
          if (!ok) vis = 0.09;
        }
        if (selId && selId !== node.id && !nc.set.has(node.id)) vis = Math.min(vis, 0.36);
      }
      node.vis += (vis - node.vis) * k5;
      node.hover += ((ui.hoveredId === node.id ? 1 : 0) - node.hover) * k9;
      node.sel += ((selId === node.id ? 1 : 0) - node.sel) * k5;
      const isDone = !!ent && ((ent.type === 'task' && ent.status === 'done') || (ent.type === 'project' && ent.status === 'done'));
      node.done += ((isDone ? 1 : 0) - node.done) * k2;
      node.flash *= Math.exp(-dt * 2.3);
      if (node.birth < 1) node.birth = Math.min(1, node.birth + dt * node.birthSpeed);
      if (node.birth >= 1 && !node.bornFlashed) {
        node.bornFlashed = true;
        node.flash = Math.max(node.flash, 1.1);
        pulses.burst(node.render, b.baseColor[i], 26, 9, 1.1);
        for (const ei of b.incident[i]) {
          const edge = layout.edges[ei];
          const fromA = edge.a === node.id;
          const other = fromA ? edge.b : edge.a;
          pulses.pulse(ei, fromA, 1.2, b.baseColor[i], L.findIndex((x) => x.id === other));
        }
      }

      const g = b.geos[i];
      q.setFromAxisAngle(g.axis, t * g.spin);
      m.makeRotationFromQuaternion(q);
      // par rapport à l'origine flottante (la caméra)
      const cx = node.render.x - O.x;
      const cy = node.render.y - O.y;
      const cz = node.render.z - O.z;
      const birth = node.birth;
      const forming = birth < 1;
      const inten = node.vis * (1 + node.hover * 0.7 + node.sel * 0.4 + node.flash * 1.4) * (1 - node.done * 0.42);
      const scl = 1 + node.hover * 0.07 + node.flash * 0.2;
      const o = b.offsets[i];
      const { local, scatter, delays } = g;
      for (let p = 0; p < g.count; p++) {
        const lx = local[p * 3];
        const ly = local[p * 3 + 1];
        const lz = local[p * 3 + 2];
        let x = (me[0] * lx + me[4] * ly + me[8] * lz) * scl;
        let y = (me[1] * lx + me[5] * ly + me[9] * lz) * scl;
        let z = (me[2] * lx + me[6] * ly + me[10] * lz) * scl;
        let a = 1;
        if (forming) {
          const e = ease3(clamp01((birth - delays[p]) / 0.6));
          const sx = scatter[p * 3];
          const sy = scatter[p * 3 + 1];
          const sz = scatter[p * 3 + 2];
          x = sx + (x - sx) * e;
          y = sy + (y - sy) * e;
          z = sz + (z - sz) * e;
          a = e * e;
        }
        const k = (o + p) * 3;
        pos[k] = cx + x;
        pos[k + 1] = cy + y;
        pos[k + 2] = cz + z;
        ints[o + p] = inten * a;
      }

      const be = ease3(clamp01(birth));
      if (cores) {
        const r = CORE[node.type] * (1 + node.hover * 0.3 + node.sel * 0.15 + node.flash * 0.45) * be * (node.vis < 0.02 ? 0 : 1);
        tmpS.set(r, r, r);
        tmpM.compose(tmpO.subVectors(node.render, O), tmpQ.identity(), tmpS);
        cores.setMatrixAt(i, tmpM);
        const gain = (1.5 + node.hover * 1.6 + node.sel * 0.9 + node.flash * 3.2) * (0.18 + 0.82 * node.vis) * (1 - node.done * 0.3);
        tmpC.copy(b.baseColor[i]).multiplyScalar(gain);
        cores.setColorAt(i, tmpC);
      }
    }
    if (cores) {
      cores.count = L.length;
      cores.instanceMatrix.needsUpdate = true;
      if (cores.instanceColor) cores.instanceColor.needsUpdate = true;
    }

    // connections: curves, axon lines, streams
    const E = layout.edges.length === b.e ? b.e : 0;
    const { curves, edgeSeed, axonPos, axonCol, streamU, streamSpeed, streamOff } = b;
    for (let ei = 0; ei < E; ei++) {
      const ia = layout.edgeIdx[ei * 2];
      const ib = layout.edgeIdx[ei * 2 + 1];
      if (ia < 0 || ib < 0) continue;
      const A = L[ia];
      const B = L[ib];
      const parent = layout.edges[ei].kind === 'parent';
      ab.subVectors(B.render, A.render);
      const dist = ab.length() || 1;
      tmpV.set(edgeSeed[ei * 3], edgeSeed[ei * 3 + 1], edgeSeed[ei * 3 + 2]);
      perp.crossVectors(ab, tmpV).normalize();
      bin.crossVectors(ab, perp).normalize();
      const bend = dist * (parent ? 0.1 : 0.18);
      const c = ei * 9;
      // les courbes aussi, par rapport à l'origine flottante (les impulsions les suivent)
      curves[c] = A.render.x - O.x;
      curves[c + 1] = A.render.y - O.y;
      curves[c + 2] = A.render.z - O.z;
      curves[c + 3] = (A.render.x + B.render.x) * 0.5 + perp.x * bend - O.x;
      curves[c + 4] = (A.render.y + B.render.y) * 0.5 + perp.y * bend - O.y;
      curves[c + 5] = (A.render.z + B.render.z) * 0.5 + perp.z * bend - O.z;
      curves[c + 6] = B.render.x - O.x;
      curves[c + 7] = B.render.y - O.y;
      curves[c + 8] = B.render.z - O.z;
      const hl = Math.max(A.hover, B.hover, A.sel, B.sel);
      const eb = Math.min(ease3(clamp01(A.birth)), ease3(clamp01(B.birth)));
      const ei2 = Math.min(A.vis, B.vis) * eb * (0.55 + hl * 1.1 + Math.max(A.flash, B.flash) * 0.4);
      const ca = b.baseColor[ia];
      const cb = b.baseColor[ib];
      const gain = ei2 * (parent ? 0.34 : 0.26);
      for (let s = 0; s < SEG; s++) {
        for (let h = 0; h < 2; h++) {
          const u = (s + h) / SEG;
          const iu = 1 - u;
          const v = (ei * SEG * 2 + s * 2 + h) * 3;
          axonPos[v] = iu * iu * curves[c] + 2 * iu * u * curves[c + 3] + u * u * curves[c + 6];
          axonPos[v + 1] = iu * iu * curves[c + 1] + 2 * iu * u * curves[c + 4] + u * u * curves[c + 7];
          axonPos[v + 2] = iu * iu * curves[c + 2] + 2 * iu * u * curves[c + 5] + u * u * curves[c + 8];
          // brighter towards the ends, a faint gap mid-way like a real fibre
          const shape = 0.55 + 0.45 * Math.cos(u * Math.PI * 2) * 0.5 + 0.22;
          axonCol[v] = (ca.r * iu + cb.r * u) * gain * shape;
          axonCol[v + 1] = (ca.g * iu + cb.g * u) * gain * shape;
          axonCol[v + 2] = (ca.b * iu + cb.b * u) * gain * shape;
        }
      }
      for (let s = 0; s < STREAM_PER; s++) {
        const k = ei * STREAM_PER + s;
        let u = (streamU[k] + t * streamSpeed[k]) % 1;
        if (u < 0) u += 1;
        const iu = 1 - u;
        const bulge = Math.sin(u * Math.PI);
        const oa = streamOff[k * 2] * bulge;
        const ob = streamOff[k * 2 + 1] * bulge;
        const p = (b.streamStart + k) * 3;
        pos[p] = iu * iu * curves[c] + 2 * iu * u * curves[c + 3] + u * u * curves[c + 6] + perp.x * oa + bin.x * ob;
        pos[p + 1] = iu * iu * curves[c + 1] + 2 * iu * u * curves[c + 4] + u * u * curves[c + 7] + perp.y * oa + bin.y * ob;
        pos[p + 2] = iu * iu * curves[c + 2] + 2 * iu * u * curves[c + 5] + u * u * curves[c + 8] + perp.z * oa + bin.z * ob;
        ints[b.streamStart + k] = ei2 * 0.6 * bulge;
      }
    }

    // pending link pulses (edge appears one render after the data change)
    if (linkQueue.current.length) {
      const now = performance.now();
      linkQueue.current = linkQueue.current.filter((lq) => {
        const key = lq.a < lq.b ? `${lq.a}|${lq.b}` : `${lq.b}|${lq.a}`;
        const ei = b.edgeKey.get(key);
        if (ei === undefined || ei >= E) return now < lq.until;
        const ia = layout.edgeIdx[ei * 2];
        const ib = layout.edgeIdx[ei * 2 + 1];
        const fromA = layout.edges[ei].a === lq.a;
        const srcIdx = fromA ? ia : ib;
        const dstIdx = fromA ? ib : ia;
        pulses.pulse(ei, fromA, 1.6, b.baseColor[srcIdx], dstIdx);
        pulses.pulse(ei, !fromA, 1.1, b.baseColor[dstIdx], srcIdx);
        L[srcIdx].flash = Math.max(L[srcIdx].flash, 0.6);
        return false;
      });
    }

    // ambient life: idle impulses, more when navigating, more around the hovered constellation
    const tm = timers.current;
    if (E > 0) {
      tm.idle += dt * (1.6 + Math.min(telemetry.speed, 60) * 0.18);
      while (tm.idle > 1) {
        tm.idle -= 1;
        const ei = Math.floor(Math.random() * E);
        const fromA = Math.random() < 0.5;
        const ia = layout.edgeIdx[ei * 2];
        const ib = layout.edgeIdx[ei * 2 + 1];
        if (Math.min(L[ia].vis, L[ib].vis) > 0.3) {
          pulses.pulse(ei, fromA, 0.45 + Math.random() * 0.4, b.baseColor[fromA ? ia : ib], fromA ? ib : ia);
        }
      }
      const hIdx = ui.hoveredId ? L.findIndex((x) => x.id === ui.hoveredId) : -1;
      if (hIdx >= 0 && b.incident[hIdx].length) {
        tm.hover += dt * 5;
        while (tm.hover > 1) {
          tm.hover -= 1;
          const list = b.incident[hIdx];
          const ei = list[Math.floor(Math.random() * list.length)];
          const fromA = layout.edges[ei].a === ui.hoveredId;
          const other = fromA ? layout.edgeIdx[ei * 2 + 1] : layout.edgeIdx[ei * 2];
          pulses.pulse(ei, fromA, 0.9, b.baseColor[hIdx], other);
        }
      }
    }
    pulses.update(dt, curves, E, O);

    tm.stats += dt;
    if (tm.stats > 1) {
      const per = (pulses.spawned - tm.spawnedAt) / tm.stats;
      telemetry.pulsesPerMin = telemetry.pulsesPerMin * 0.6 + per * 60 * 0.4;
      tm.spawnedAt = pulses.spawned;
      tm.stats = 0;
    }

    const pa = b.pointsGeo.attributes;
    pa.position.needsUpdate = true;
    pa.aInt.needsUpdate = true;
    const aa = b.axonGeo.attributes;
    aa.position.needsUpdate = true;
    aa.aColor.needsUpdate = true;
  }, -2);

  return (
    <group ref={groupRef}>
      <lineSegments geometry={built.axonGeo} material={mats.axon} frustumCulled={false} />
      <lineSegments geometry={built.bundleGeo} material={mats.bundle} frustumCulled={false} />
      <lineSegments geometry={built.webGeo} material={mats.web} frustumCulled={false} />
      <points geometry={built.pointsGeo} material={mats.points} frustumCulled={false} />
      <points geometry={pulses.geo} material={mats.pulses} frustumCulled={false} />
      <instancedMesh
        key={built.n}
        ref={coresRef}
        args={[coreGeo, mats.core, Math.max(1, built.n)]}
        frustumCulled={false}
      />
    </group>
  );
}
