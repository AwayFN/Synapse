import { useEffect, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { Galaxy } from './Galaxy';
import { Starfield } from './Starfield';
import { FlyControls } from './FlyControls';
import { LabelsProjector } from './LabelsProjector';
import { layout } from './layout';
import { useStructure } from './structure';
import { useUI } from '../store/ui';
import { isNarrow } from '../lib/useNarrow';

/** Une vue plein écran (tâches, agenda, notes, éditeur) cache-t-elle le réseau ? */
const covered = () => {
  const s = useUI.getState();
  return s.view !== 'network' || !!s.editorId;
};

/**
 * Drives the render loop ourselves: capped at 60 fps (30 when an overlay hides the network). Sur téléphone, une vue
 * plein écran cache tout le réseau : on ne le redessine plus du tout (la dernière image reste, floutée derrière) ; la
 * batterie est épargnée et les listes défilent sans à-coups. Il repart dès qu'on revient au réseau.
 */
function FrameLimiter() {
  const advance = useThree((s) => s.advance);
  useEffect(() => {
    let raf = 0;
    let next = 0;
    let last = 0; // seconds, monotonic clock fed to r3f
    let offset = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const hidden = covered();
      if (hidden && isNarrow()) {
        next = now;
        return;
      }
      const interval = 1000 / (hidden ? 30 : 60);
      if (now < next - 2) return;
      next = Math.max(next + interval, now);
      last = Math.max(now / 1000 + offset, last + 0.001);
      advance(last);
    };
    raf = requestAnimationFrame(loop);
    if (import.meta.env.DEV) {
      // dev helper: step the simulation without relying on requestAnimationFrame (hidden tabs)
      (window as unknown as { __step: (n?: number) => void }).__step = (n = 60) => {
        for (let i = 0; i < n; i++) {
          last += 1 / 60;
          advance(last);
        }
        offset = Math.max(offset, last - performance.now() / 1000);
      };
    }
    return () => cancelAnimationFrame(raf);
  }, [advance]);
  return null;
}

function LayoutDriver() {
  useFrame((state, dt) => layout.step(Math.min(dt, 0.05), state.clock.elapsedTime), -4);
  return null;
}

function World() {
  const structure = useStructure();
  return (
    <>
      <LayoutDriver />
      <FlyControls />
      <Starfield />
      <Galaxy structure={structure} />
      <LabelsProjector />
    </>
  );
}

export function Scene() {
  const [dpr, setDpr] = useState(Math.min(window.devicePixelRatio || 1, 1.75));
  return (
    <Canvas
      frameloop="never"
      dpr={dpr}
      gl={{ antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false }}
      camera={{ fov: 58, near: 0.1, far: 6000, position: [0, 60, 420] }}
      onCreated={({ gl, scene }) => {
        gl.setClearColor(0x000000, 1);
        scene.background = new THREE.Color(0x000000);
      }}
      style={{ position: 'absolute', inset: 0 }}
    >
      <FrameLimiter />
      {/* derrière une vue, on dessine exprès moins souvent : ce n'est pas l'appareil qui peine, la netteté reste */}
      <PerformanceMonitor
        onDecline={() => !covered() && setDpr((d) => Math.max(1, d - 0.25))}
        onIncline={() => setDpr((d) => Math.min(window.devicePixelRatio || 1, 1.75, d + 0.25))}
      />
      <World />
      <EffectComposer multisampling={0}>
        {/*
          L'éclat néon des neurones, sans « aura » : seuls les points vraiment lumineux (noyaux, étincelles) brillent,
          et la lueur reste serrée autour d'eux. Avant (seuil 0,16, rayon 0,72), tout le réseau s'auréolait d'un
          brouillard dès qu'on s'éloignait un peu.
        */}
        <Bloom mipmapBlur intensity={1.05} luminanceThreshold={0.3} luminanceSmoothing={0.22} radius={0.42} />
        <Vignette offset={0.2} darkness={0.85} />
      </EffectComposer>
    </Canvas>
  );
}
