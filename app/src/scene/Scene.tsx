import { useEffect, useMemo, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import * as THREE from 'three';
import { Galaxy } from './Galaxy';
import { Starfield } from './Starfield';
import { FlyControls } from './FlyControls';
import { LabelsProjector } from './LabelsProjector';
import { PresenceProjector } from './PresenceProjector';
import { layout } from './layout';
import { useStructure } from './structure';
import { useUI } from '../store/ui';

/** Drives the render loop ourselves: capped at 60 fps (30 when an overlay hides the network) */
function FrameLimiter() {
  const advance = useThree((s) => s.advance);
  useEffect(() => {
    let raf = 0;
    let next = 0;
    let last = 0; // seconds, monotonic clock fed to r3f
    let offset = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const s = useUI.getState();
      const covered = s.view !== 'network' || !!s.editorId;
      const interval = 1000 / (covered ? 30 : 60);
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

/** Dev only: time spent in each stage of a frame (window.__perf) */
function PerfProbe() {
  const marks = useMemo(() => ({ t: new Float64Array(8), avg: { layout: 0, controls: 0, galaxy: 0, labels: 0, render: 0 } }), []);
  const at = (i: number) => () => {
    marks.t[i] = performance.now();
  };
  useFrame(at(0), -10);
  useFrame(at(1), -3.5);
  useFrame(at(2), -2.5);
  useFrame(at(3), -1.5);
  useFrame(at(4), -0.5);
  useFrame(() => {
    const t = marks.t;
    const now = performance.now();
    const a = marks.avg;
    const k = 0.1;
    a.layout += (t[1] - t[0] - a.layout) * k;
    a.controls += (t[2] - t[1] - a.controls) * k;
    a.galaxy += (t[3] - t[2] - a.galaxy) * k;
    a.labels += (t[4] - t[3] - a.labels) * k;
    a.render += (now - t[4] - a.render) * k;
    (window as unknown as { __perf: unknown }).__perf = a;
  }, 10);
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
      <PresenceProjector />
    </>
  );
}

export function Scene() {
  // sur téléphone, un peu moins de pixels : l'écran est petit, la batterie compte
  const [dpr, setDpr] = useState(Math.min(window.devicePixelRatio || 1, window.innerWidth < 768 ? 1.5 : 1.75));
  return (
    <Canvas
      frameloop="never"
      dpr={dpr}
      gl={{ antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false }}
      camera={{ fov: 58, near: 0.1, far: 6000, position: [0, 60, 420] }}
      onCreated={({ gl, scene }) => {
        // noir pur : aucun dégradé ni halo possible dans le vide
        gl.setClearColor(0x000000, 1);
        scene.background = new THREE.Color(0x000000);
      }}
      style={{ position: 'absolute', inset: 0 }}
    >
      <FrameLimiter />
      {import.meta.env.DEV && <PerfProbe />}
      <PerformanceMonitor
        onDecline={() => setDpr((d) => Math.max(1, d - 0.25))}
        onIncline={() => setDpr((d) => Math.min(window.devicePixelRatio || 1, 1.75, d + 0.25))}
      />
      <World />
      <EffectComposer multisampling={0}>
        {/* néon : noyaux, branches, axones et impulsions rayonnent ; le fond reste noir pur */}
        <Bloom mipmapBlur intensity={0.95} luminanceThreshold={0.28} luminanceSmoothing={0.4} radius={0.7} />
        <Vignette offset={0.22} darkness={0.78} />
      </EffectComposer>
    </Canvas>
  );
}
