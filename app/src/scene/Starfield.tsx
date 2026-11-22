import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { makePointMaterial } from './shaders';
import { mulberry32 } from '../lib/random';

/**
 * Fond : étoiles lointaines et poussière proche, en lumière froide et neutre.
 * Donne la profondeur et la parallaxe du vol, sans voler la vedette aux neurones.
 */
export function Starfield() {
  const { geo, mat } = useMemo(() => {
    const rng = mulberry32(1337);
    const FAR = 2400;
    const DUST = 700;
    const n = FAR + DUST;
    const pos = new Float32Array(n * 3);
    const col = new Float32Array(n * 3);
    const size = new Float32Array(n);
    const int = new Float32Array(n);
    const phase = new Float32Array(n);
    const c = new THREE.Color();
    const tints = ['#ffffff', '#dfe8f7', '#c4d4ee', '#aab9d6'];
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
      size[i] = far ? 1.4 + rng() * rng() * 4 : 0.1 + rng() * 0.22;
      int[i] = far ? 0.16 + rng() * rng() * 0.6 : 0.1 + rng() * 0.18;
      phase[i] = rng();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aInt', new THREE.BufferAttribute(int, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = makePointMaterial(0.7, 5, 3500, 4800);
    return { geo, mat };
  }, []);

  useFrame((state) => {
    const cam = state.camera as THREE.PerspectiveCamera;
    mat.uniforms.uTime.value = state.clock.elapsedTime;
    mat.uniforms.uScale.value = (state.size.height * state.gl.getPixelRatio()) / (2 * Math.tan((cam.fov * Math.PI) / 360));
  });

  return <points geometry={geo} material={mat} frustumCulled={false} renderOrder={-1} />;
}
