import { useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { layout } from './layout';
import { presenceEls } from './telemetry';
import { useUI } from '../store/ui';

/** Place les étiquettes de présence (« LÉA ») sous le neurone que chaque participant regarde */
export function PresenceProjector() {
  const v = useMemo(() => new THREE.Vector3(), []);
  useFrame((state) => {
    const cam = state.camera;
    const { width, height } = state.size;
    const hidden = useUI.getState().view !== 'network';
    for (const { el, focus, slot } of presenceEls.values()) {
      const n = focus ? layout.nodes.get(focus) : undefined;
      if (!n || hidden) {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
        continue;
      }
      v.copy(n.render).project(cam);
      if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
        continue;
      }
      const x = (v.x * 0.5 + 0.5) * width;
      const y = (-v.y * 0.5 + 0.5) * height;
      if (el.style.visibility !== 'visible') el.style.visibility = 'visible';
      el.style.transform = `translate3d(${(x + 10).toFixed(1)}px,${(y + 12 + slot * 16).toFixed(1)}px,0)`;
    }
  }, -1);
  return null;
}
