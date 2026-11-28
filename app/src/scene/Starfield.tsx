import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { makePointMaterial } from './shaders';
import { layout } from './layout';
import { mulberry32 } from '../lib/random';

const TINTS = ['#ffffff', '#9fd8ff', '#ffc4e6', '#c9b6ff', '#a6fff0'];
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function starGeometry(seed: number, count: number, place: (rng: () => number, i: number, out: Float32Array) => void, sizeOf: (rng: () => number, i: number) => number, intOf: (rng: () => number, i: number) => number) {
  const rng = mulberry32(seed);
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const int = new Float32Array(count);
  const phase = new Float32Array(count);
  const c = new THREE.Color();
  const p = new Float32Array(3);
  for (let i = 0; i < count; i++) {
    place(rng, i, p);
    pos.set(p, i * 3);
    c.set(TINTS[Math.floor(rng() * TINTS.length)]);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
    size[i] = sizeOf(rng, i);
    int[i] = intOf(rng, i);
    phase[i] = rng();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aInt', new THREE.BufferAttribute(int, 1));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return geo;
}

/**
 * Deep background stars + near "neural dust": gives depth & parallax while flying.
 * V8.1 : le champ d'étoiles s'agrandit avec le réseau, et un ciel lointain (qui suit la caméra) prend le relais quand on
 * s'en éloigne beaucoup : où que l'on emmène un neurone, il y a toujours des étoiles autour.
 */
export function Starfield() {
  const { geo, mat } = useMemo(() => {
    const FAR = 2600;
    const DUST = 900;
    const geo = starGeometry(
      1337,
      FAR + DUST,
      (rng, i, out) => {
        const u = rng() * 2 - 1;
        const th = rng() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        const far = i < FAR;
        const r = far ? 500 + rng() * 900 : 45 + Math.pow(rng(), 0.7) * 320;
        out[0] = s * Math.cos(th) * r;
        out[1] = u * r * (far ? 1 : 0.6);
        out[2] = s * Math.sin(th) * r;
      },
      (rng, i) => (i < FAR ? 1.6 + rng() * rng() * 5 : 0.12 + rng() * 0.28),
      (rng, i) => (i < FAR ? 0.25 + rng() * rng() * 0.9 : 0.18 + rng() * 0.3),
    );
    return { geo, mat: makePointMaterial(0.8, 6, 3500, 4800) };
  }, []);

  // le ciel lointain : des étoiles « à l'infini » (sur une sphère autour de la caméra), sans fondu
  const sky = useMemo(() => {
    const geo = starGeometry(
      4242,
      1800,
      (rng, _i, out) => {
        const u = rng() * 2 - 1;
        const th = rng() * Math.PI * 2;
        const s = Math.sqrt(1 - u * u);
        const r = 900 + rng() * 500;
        out[0] = s * Math.cos(th) * r;
        out[1] = u * r;
        out[2] = s * Math.sin(th) * r;
      },
      (rng) => 1.6 + rng() * rng() * 5,
      (rng) => 0.25 + rng() * rng() * 0.9,
    );
    return { geo, mat: makePointMaterial(0.8, 6, 1e9, 2e9) };
  }, []);

  const fieldRef = useRef<THREE.Points>(null);
  const skyRef = useRef<THREE.Points>(null);

  useFrame((state) => {
    const cam = state.camera as THREE.PerspectiveCamera;
    const t = state.clock.elapsedTime;
    const scale = (state.size.height * state.gl.getPixelRatio()) / (2 * Math.tan((cam.fov * Math.PI) / 360));
    const vs = layout.viewScale;
    mat.uniforms.uTime.value = t;
    mat.uniforms.uScale.value = scale;
    (mat.uniforms.uFar.value as THREE.Vector2).set(3500 * vs, 4800 * vs);
    if (fieldRef.current) fieldRef.current.scale.setScalar(vs);
    sky.mat.uniforms.uTime.value = t;
    sky.mat.uniforms.uScale.value = scale;
    // le ciel s'allume quand la caméra quitte le champ d'étoiles du réseau
    const k = smooth(2400 * vs, 4200 * vs, cam.position.length());
    sky.mat.uniforms.uGain.value = 0.8 * k;
    if (skyRef.current) {
      skyRef.current.visible = k > 0.001;
      skyRef.current.position.copy(cam.position);
    }
  });

  return (
    <>
      <points ref={fieldRef} geometry={geo} material={mat} frustumCulled={false} renderOrder={-1} />
      <points ref={skyRef} geometry={sky.geo} material={sky.mat} frustumCulled={false} renderOrder={-1} visible={false} />
    </>
  );
}
