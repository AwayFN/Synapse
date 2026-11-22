import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { makePointMaterial } from './shaders';
import { mulberry32 } from '../lib/random';

/** Deep background stars + near "neural dust": gives depth & parallax while flying */
export function Starfield() {
  const { geo, mat } = useMemo(() => {
    const rng = mulberry32(1337);
    const FAR = 2600;
    const DUST = 900;
    const n = FAR + DUST;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const int = new Float32Array(n);
    const phase = new Float32Array(n);
    const c = new THREE.Color();
    const tints = ['#ffffff', '#9fd8ff', '#ffc4e6', '#c9b6ff', '#a6fff0'];
    for (let i = 0; i < n; i++) {
      const u = rng() * 2 - 1;
      const th = rng() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const far = i < FAR;
      const r = far ? 500 + rng() * 900 : 45 + Math.pow(rng(), 0.7) * 320;
      pos[i * 3] = s * Math.cos(th) * r;
      pos[i * 3 + 1] = u * r * (far ? 1 : 0.6);
      pos[i * 3 + 2] = s * Math.sin(th) * r;
      c.set(tints[Math.floor(rng() * tints.length)]);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
      size[i] = far ? 1.6 + rng() * rng() * 5 : 0.12 + rng() * 0.28;
      int[i] = far ? 0.25 + rng() * rng() * 0.9 : 0.18 + rng() * 0.3;
      phase[i] = rng();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aInt', new THREE.BufferAttribute(int, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = makePointMaterial(0.8, 6, 3500, 4800);
    return { geo, mat };
  }, []);

  useFrame((state) => {
    const cam = state.camera as THREE.PerspectiveCamera;
    mat.uniforms.uTime.value = state.clock.elapsedTime;
    mat.uniforms.uScale.value = (state.size.height * state.gl.getPixelRatio()) / (2 * Math.tan((cam.fov * Math.PI) / 360));
  });

  return <points geometry={geo} material={mat} frustumCulled={false} renderOrder={-1} />;
}
