import { useEffect, useMemo } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { layout } from './layout';
import { labelHover, telemetry } from './telemetry';
import { toggleLink, useUI } from '../store/ui';
import { can } from '../sync/perm';
import { useSession } from '../sync/session';
import { fx } from '../store/fx';

export function isTyping() {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

export function overlayOpen() {
  const s = useUI.getState();
  const ss = useSession.getState();
  return s.view !== 'network' || !!s.editorId || s.paletteOpen || ss.adminOpen || ss.accountOpen || ss.feedbackOpen || ss.shareOpen;
}

const UP = new THREE.Vector3(0, 1, 0);
const ZERO2 = new THREE.Vector2();

function smoothDamp(cur: THREE.Vector3, target: THREE.Vector3, vel: THREE.Vector3, smoothTime: number, dt: number) {
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  for (const c of ['x', 'y', 'z'] as const) {
    const change = cur[c] - target[c];
    const temp = (vel[c] + omega * change) * dt;
    vel[c] = (vel[c] - omega * temp) * exp;
    cur[c] = target[c] + (change + temp) * exp;
  }
}

type Mode = 'free' | 'focus' | 'point';

/**
 * "Floating in space" camera:
 *  - free mode: wheel = forward/back with inertia, right-drag = pivot (look around),
 *    left-drag = drift, WASD/ZQSD + E/Q = fly, mouse position = gentle parallax float
 *  - focus mode: orbit around the selected constellation (follows it as it breathes)
 *  - point mode: smooth flight to a viewpoint (overview), then back to free
 */
class Rig {
  cam: THREE.PerspectiveCamera;
  basePos = new THREE.Vector3();
  baseQuat = new THREE.Quaternion();
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  yawVel = 0;
  pitchVel = 0;
  mode: Mode = 'point';
  focusId: string | null = null;
  pendingFocus = false;
  pointTarget = new THREE.Vector3();
  orbit = { dist: 40, theta: 0, phi: 0.2, thetaVel: 0, phiVel: 0 };
  keys = new Set<string>();
  mouse = new THREE.Vector2();
  float = new THREE.Vector2();
  pointerIn = false;
  drag: { button: number; x: number; y: number; moved: number } | null = null;
  shift = 0;
  shiftY = 0;
  booted = false;
  speedScale = 1;
  cursor = '';
  el: HTMLElement | null = null;
  private ray = new THREE.Raycaster();
  private v1 = new THREE.Vector3();
  private v2 = new THREE.Vector3();
  private v3 = new THREE.Vector3();
  private desired = new THREE.Vector3();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private qf = new THREE.Quaternion();
  private e = new THREE.Euler(0, 0, 0, 'YXZ');

  constructor(cam: THREE.PerspectiveCamera) {
    this.cam = cam;
    this.basePos.copy(cam.position);
    this.baseQuat.copy(cam.quaternion);
    // new constellations are born in front of the camera (so the birth is seen),
    // but never outside the galaxy: they would drift in from the void otherwise
    layout.spawnPoint = () => {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.baseQuat);
      const p = this.basePos.clone().addScaledVector(fwd, 46);
      if (layout.list.length > 1) {
        const { center, radius } = layout.bounds();
        const max = Math.max(30, radius * 0.75);
        if (p.distanceTo(center) > max) p.sub(center).setLength(max).add(center);
      }
      return p;
    };
  }

  private fitDistance(radius: number) {
    const fovV = (this.cam.fov * Math.PI) / 180;
    const fovH = 2 * Math.atan(Math.tan(fovV / 2) * this.cam.aspect);
    return (radius / Math.sin(Math.min(fovV, fovH) / 2)) * 0.92;
  }

  boot() {
    this.booted = true;
    const { center, radius } = layout.bounds();
    const fit = this.fitDistance(radius);
    this.pointTarget.copy(center);
    this.orbit.dist = fit;
    this.orbit.theta = 0.55;
    this.orbit.phi = 0.32;
    // start far away and glide in
    this.sphere(this.basePos, center, fit * 3.4, this.orbit.theta + 0.5, 0.55);
    this.m.lookAt(this.basePos, center, UP);
    this.baseQuat.setFromRotationMatrix(this.m);
    this.vel.set(0, 0, 0);
    this.mode = 'point';
  }

  private sphere(out: THREE.Vector3, c: THREE.Vector3, d: number, th: number, ph: number) {
    return out.set(
      c.x + Math.sin(th) * Math.cos(ph) * d,
      c.y + Math.sin(ph) * d,
      c.z + Math.cos(th) * Math.cos(ph) * d,
    );
  }

  private setOrbitFrom(target: THREE.Vector3, minPhi = -0.9, maxPhi = 0.9) {
    const off = this.v1.subVectors(this.basePos, target);
    const d = off.length();
    if (d < 1e-3) off.set(0, 0.2, 1);
    off.normalize();
    this.orbit.theta = Math.atan2(off.x, off.z);
    this.orbit.phi = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(off.y, -1, 1)), minPhi, maxPhi);
    this.orbit.thetaVel = 0;
    this.orbit.phiVel = 0;
  }

  enterFocus(id: string) {
    const node = layout.nodes.get(id);
    if (!node) return;
    this.setOrbitFrom(node.render);
    this.orbit.dist = node.radius * 4.4 + 7;
    this.mode = 'focus';
  }

  overview() {
    const { center, radius } = layout.bounds();
    this.pointTarget.copy(center);
    this.setOrbitFrom(center, 0.12, 0.6);
    this.orbit.dist = this.fitDistance(radius);
    this.mode = 'point';
    this.focusId = null;
    if (useUI.getState().focusId) useUI.setState({ focusId: null });
  }

  toFree() {
    this.mode = 'free';
    this.e.setFromQuaternion(this.baseQuat, 'YXZ');
    this.yaw = this.e.y;
    this.pitch = this.e.x;
    this.yawVel = 0;
    this.pitchVel = 0;
  }

  private releaseFocus() {
    if (this.mode !== 'free') this.toFree();
    if (useUI.getState().focusId) {
      this.focusId = null;
      useUI.getState().setFocus(null);
    }
  }

  rotate(dx: number, dy: number) {
    if (this.mode === 'free') {
      this.yawVel -= dx * 0.0032 * 6;
      this.pitchVel -= dy * 0.0032 * 6;
    } else {
      this.orbit.thetaVel -= dx * 0.0055 * 6;
      this.orbit.phiVel += dy * 0.0055 * 6;
    }
  }

  pan(dx: number, dy: number) {
    this.releaseFocus();
    const right = this.v1.set(1, 0, 0).applyQuaternion(this.baseQuat);
    const up = this.v2.set(0, 1, 0).applyQuaternion(this.baseQuat);
    const k = 0.05 * this.speedScale * 2.2;
    this.vel.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
  }

  wheel(dy: number) {
    const d = THREE.MathUtils.clamp(dy, -240, 240);
    if (this.mode === 'free') {
      const fwd = this.v1.set(0, 0, -1).applyQuaternion(this.baseQuat);
      this.vel.addScaledVector(fwd, -d * 0.045 * this.speedScale * 2.2);
    } else {
      const node = this.mode === 'focus' && this.focusId ? layout.nodes.get(this.focusId) : null;
      const min = node ? node.radius * 1.5 : 12;
      this.orbit.dist = THREE.MathUtils.clamp(this.orbit.dist * Math.exp(d * 0.0012), min, 1200);
    }
  }

  /** Un doigt : tourner AUTOUR du réseau (ou du neurone ouvert), sans perdre le réseau de vue */
  touchOrbit(dx: number, dy: number) {
    if (this.mode === 'free') {
      const { center } = layout.bounds();
      this.pointTarget.copy(center);
      this.setOrbitFrom(center, -1.2, 1.2);
      this.orbit.dist = Math.max(12, this.basePos.distanceTo(center));
      this.vel.set(0, 0, 0);
      this.mode = 'point';
    }
    this.orbit.thetaVel -= dx * 0.0055 * 6;
    this.orbit.phiVel += dy * 0.0055 * 6;
  }

  /** Pincer : avancer ou reculer d'une fraction de la distance, sans élan (ratio > 1 = doigts écartés = s'approcher) */
  pinchZoom(ratio: number) {
    if (!(ratio > 0)) return;
    if (this.mode === 'free') {
      let minD = Infinity;
      for (const n of layout.list) minD = Math.min(minD, n.render.distanceTo(this.basePos) - n.radius);
      if (!Number.isFinite(minD)) minD = 40;
      const fwd = this.v1.set(0, 0, -1).applyQuaternion(this.baseQuat);
      this.basePos.addScaledVector(fwd, Math.max(4, minD) * (1 - 1 / ratio));
      this.vel.multiplyScalar(0.5);
    } else {
      const node = this.mode === 'focus' && this.focusId ? layout.nodes.get(this.focusId) : null;
      const min = node ? node.radius * 1.5 : 12;
      this.orbit.dist = THREE.MathUtils.clamp(this.orbit.dist / ratio, min, 1200);
    }
  }

  click(shift = false) {
    if (overlayOpen()) return;
    const ui = useUI.getState();
    // Maj+clic sur un autre neurone : relier (ou délier) avec celui qui est ouvert
    if (shift && ui.hoveredId && ui.selectedId && ui.hoveredId !== ui.selectedId && can.link()) {
      toggleLink(ui.selectedId, ui.hoveredId);
      return;
    }
    if (ui.hoveredId) ui.openEntity(ui.hoveredId);
    else if (ui.selectedId) ui.closePanel();
  }

  /** Neurone sous le pointeur (rayon élargi pour un doigt) */
  pick(scale = 1): string | null {
    this.ray.setFromCamera(this.mouse, this.cam);
    const ray = this.ray.ray;
    let best = Infinity;
    let hit: string | null = null;
    for (const n of layout.list) {
      if (n.vis < 0.05 || n.birth < 0.5) continue;
      const toC = this.v3.subVectors(n.render, ray.origin);
      const along = toC.dot(ray.direction);
      if (along < 0.5) continue;
      const d2 = toC.lengthSq() - along * along;
      const r = Math.max(n.glyph * 1.9 + 0.6, along * 0.014) * scale;
      if (d2 < r * r && along < best) {
        best = along;
        hit = n.id;
      }
    }
    return hit;
  }

  attach(el: HTMLElement) {
    this.el = el;
    const inUI = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('[data-ui]');

    // ── au doigt (téléphone, tablette) : un doigt = tourner · pincer = avancer / reculer · deux doigts = se déplacer
    //    toucher = ouvrir le neurone (ou refermer) · double toucher dans le vide = vue d'ensemble
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { d: number; mx: number; my: number } | null = null;
    let tap: { t: number; moved: number } | null = null;
    let lastTap = 0;
    let lastTouchAt = 0;
    const two = () => {
      const [a, b] = [...touches.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    const touchDown = (e: PointerEvent) => {
      lastTouchAt = performance.now();
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 1) tap = { t: performance.now(), moved: 0 };
      else {
        tap = null;
        if (touches.size === 2) pinch = two();
      }
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const touchMove = (e: PointerEvent) => {
      const p = touches.get(e.pointerId);
      if (!p) return;
      lastTouchAt = performance.now();
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (touches.size === 1) {
        if (tap) tap.moved += Math.abs(dx) + Math.abs(dy);
        if (!tap || tap.moved > 8) this.touchOrbit(dx, dy);
      } else if (touches.size === 2 && pinch) {
        const now = two();
        if (pinch.d > 10) this.pinchZoom(now.d / pinch.d);
        const mx = now.mx - pinch.mx;
        const my = now.my - pinch.my;
        if (Math.abs(mx) + Math.abs(my) > 0.5) this.pan(mx, my);
        pinch = now;
      }
    };
    const touchUp = (e: PointerEvent) => {
      if (!touches.has(e.pointerId)) return;
      lastTouchAt = performance.now();
      touches.delete(e.pointerId);
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (touches.size < 2) pinch = null;
      if (touches.size === 0 && tap && e.type === 'pointerup' && tap.moved < 10 && performance.now() - tap.t < 450) {
        const r = el.getBoundingClientRect();
        this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
        const hit = overlayOpen() ? null : this.pick(1.8);
        useUI.getState().setHovered(hit);
        const now = performance.now();
        if (!hit && now - lastTap < 350) this.overview();
        lastTap = now;
        this.click();
      }
      if (touches.size === 0) tap = null;
    };

    const onDown = (e: PointerEvent) => {
      if (inUI(e.target)) return;
      if (e.pointerType === 'touch') {
        if ((e.target as HTMLElement).closest('[data-label]')) return;
        return touchDown(e);
      }
      if (e.button === 0 && (e.target as HTMLElement).closest('[data-label]')) return;
      this.drag = { button: e.button, x: e.clientX, y: e.clientY, moved: 0 };
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return touchMove(e);
      const r = el.getBoundingClientRect();
      this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1));
      this.pointerIn = !inUI(e.target);
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.x = e.clientX;
      d.y = e.clientY;
      d.moved += Math.abs(dx) + Math.abs(dy);
      if (d.button === 2) this.rotate(dx, dy);
      else if (d.moved > 4) this.pan(dx, dy);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return touchUp(e);
      const d = this.drag;
      this.drag = null;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (d && d.button === 0 && d.moved < 5) this.click(e.shiftKey);
    };
    const onWheel = (e: WheelEvent) => {
      if (inUI(e.target)) return;
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 33;
      else if (e.deltaMode === 2) dy *= 400;
      this.wheel(dy);
    };
    const onDbl = (e: MouseEvent) => {
      if (inUI(e.target)) return;
      // au doigt, le double toucher est déjà géré (le navigateur imite ensuite un double clic)
      if (performance.now() - lastTouchAt < 800) return;
      if (!useUI.getState().hoveredId) this.overview();
    };
    const onLeave = () => {
      this.pointerIn = false;
    };
    const onCtx = (e: MouseEvent) => e.preventDefault();
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping() || e.ctrlKey || e.metaKey || e.altKey) return;
      if (overlayOpen()) return;
      this.keys.add(e.code);
      if (e.code === 'Space') e.preventDefault();
      if (e.code === 'KeyH' || e.code === 'Home') this.overview();
      if (e.code === 'KeyF') {
        const s = useUI.getState().selectedId;
        if (s) useUI.getState().setFocus(s);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
    const onBlur = () => this.keys.clear();
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('dblclick', onDbl);
    el.addEventListener('pointerleave', onLeave);
    el.addEventListener('contextmenu', onCtx);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('dblclick', onDbl);
      el.removeEventListener('pointerleave', onLeave);
      el.removeEventListener('contextmenu', onCtx);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }

  update(dt: number, width: number, height: number) {
    if (!this.booted) {
      if (!layout.ready) return;
      this.boot();
    }
    const ui = useUI.getState();
    if (ui.focusId !== this.focusId) {
      this.focusId = ui.focusId;
      this.pendingFocus = false;
      if (ui.focusId && layout.nodes.get(ui.focusId)) this.enterFocus(ui.focusId);
      else if (ui.focusId) this.pendingFocus = true; // constellation not born yet
      else if (this.mode === 'focus') this.toFree();
    } else if (this.pendingFocus && this.focusId && layout.nodes.get(this.focusId)) {
      this.pendingFocus = false;
      this.enterFocus(this.focusId);
    }
    const blocked = overlayOpen() || isTyping();
    const k = this.keys;
    let f = 0;
    let s = 0;
    let l = 0;
    if (!blocked) {
      if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
      if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) s += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) s -= 1;
      if (k.has('KeyE') || k.has('Space')) l += 1;
      if (k.has('KeyQ') || k.has('ShiftLeft')) l -= 1;
    }
    const flying = f !== 0 || s !== 0 || l !== 0;
    if (flying && this.mode !== 'free') this.releaseFocus();

    // move slower near constellations, faster in the void
    let minD = Infinity;
    for (const n of layout.list) minD = Math.min(minD, n.render.distanceTo(this.basePos) - n.radius);
    if (!Number.isFinite(minD)) minD = 40;
    this.speedScale = THREE.MathUtils.clamp(minD / 22, 0.3, 6);

    if (this.mode === 'free') {
      const fwd = this.v1.set(0, 0, -1).applyQuaternion(this.baseQuat);
      const right = this.v2.set(1, 0, 0).applyQuaternion(this.baseQuat);
      const up = this.v3.set(0, 1, 0).applyQuaternion(this.baseQuat);
      if (flying) {
        const a = 80 * this.speedScale * dt;
        this.vel.addScaledVector(fwd, f * a).addScaledVector(right, s * a).addScaledVector(up, l * a);
      }
      this.basePos.addScaledVector(this.vel, dt);
      this.vel.multiplyScalar(Math.exp(-dt * 2.2));
      this.yaw += this.yawVel * dt;
      this.pitch = THREE.MathUtils.clamp(this.pitch + this.pitchVel * dt, -1.45, 1.45);
      this.yawVel *= Math.exp(-dt * 6);
      this.pitchVel *= Math.exp(-dt * 6);
      this.baseQuat.setFromEuler(this.e.set(this.pitch, this.yaw, 0, 'YXZ'));
    } else {
      let target: THREE.Vector3 | null = this.pointTarget;
      if (this.mode === 'focus') {
        const node = this.focusId ? layout.nodes.get(this.focusId) : null;
        target = node ? node.render : null;
      }
      if (!target) {
        this.toFree();
      } else {
        const o = this.orbit;
        o.theta += o.thetaVel * dt;
        o.phi = THREE.MathUtils.clamp(o.phi + o.phiVel * dt, -1.35, 1.35);
        o.thetaVel *= Math.exp(-dt * 6);
        o.phiVel *= Math.exp(-dt * 6);
        this.sphere(this.desired, target, o.dist, o.theta, o.phi);
        smoothDamp(this.basePos, this.desired, this.vel, this.mode === 'point' ? 0.85 : 0.5, dt);
        this.m.lookAt(this.basePos, target, UP);
        this.q.setFromRotationMatrix(this.m);
        this.baseQuat.slerp(this.q, 1 - Math.exp(-dt * 4.2));
        if (this.mode === 'point' && this.basePos.distanceTo(this.desired) < 0.8 && this.vel.length() < 1.2) {
          this.toFree();
        }
      }
    }

    // gentle float toward the cursor → parallax (near constellations shift more than far ones)
    const floatTarget = this.pointerIn && !this.drag && !blocked ? this.mouse : ZERO2;
    this.float.lerp(floatTarget, 1 - Math.exp(-dt * 1.6));
    const right = this.v1.set(1, 0, 0).applyQuaternion(this.baseQuat);
    const up = this.v2.set(0, 1, 0).applyQuaternion(this.baseQuat);
    this.cam.position
      .copy(this.basePos)
      .addScaledVector(right, this.float.x * 1.5)
      .addScaledVector(up, this.float.y * 1.0);
    this.qf.setFromEuler(this.e.set(this.float.y * 0.022, -this.float.x * 0.032, 0, 'YXZ'));
    this.cam.quaternion.copy(this.baseQuat).multiply(this.qf);

    // shift the projection when the panel is open so the focused constellation stays visible:
    // to the left beside the side panel on a computer, upward above the bottom sheet on a phone
    const panelOpen = !!ui.selectedId && ui.view === 'network' && !ui.editorId;
    const phone = width < 768;
    const shiftTarget = panelOpen && !phone ? Math.min(width * 0.2, 225) : 0;
    const shiftYTarget = panelOpen && phone ? height * 0.24 : 0;
    this.shift += (shiftTarget - this.shift) * (1 - Math.exp(-dt * 5));
    this.shiftY += (shiftYTarget - this.shiftY) * (1 - Math.exp(-dt * 5));
    if (Math.abs(this.shift) > 0.5 || Math.abs(this.shiftY) > 0.5) this.cam.setViewOffset(width, height, this.shift, this.shiftY, width, height);
    else if (this.cam.view?.enabled) this.cam.clearViewOffset();
    this.cam.updateMatrixWorld();

    // picking: label hover wins, else ray vs constellation spheres (a finger picks on tap, in attach)
    if (!this.drag || this.drag.moved < 4) {
      let hit: string | null = labelHover.id;
      if (!hit && this.pointerIn && !overlayOpen()) hit = this.pick();
      ui.setHovered(hit);
    }
    const cursor = this.drag && this.drag.moved > 4 ? 'grabbing' : ui.hoveredId ? 'pointer' : 'default';
    if (cursor !== this.cursor && this.el) {
      this.cursor = cursor;
      this.el.style.cursor = cursor;
    }

    this.e.setFromQuaternion(this.baseQuat, 'YXZ');
    telemetry.heading = ((((-this.e.y * 180) / Math.PI) % 360) + 360) % 360;
    telemetry.pitch = (this.e.x * 180) / Math.PI;
    telemetry.speed = this.vel.length();
    telemetry.x = this.basePos.x;
    telemetry.y = this.basePos.y;
    telemetry.z = this.basePos.z;
  }
}

export function FlyControls() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const rig = useMemo(() => new Rig(camera), [camera]);
  useEffect(() => {
    const el = document.getElementById('stage');
    if (!el) return;
    const off = rig.attach(el);
    const offFx = fx.on((e) => {
      if (e.kind === 'overview') rig.overview();
    });
    return () => {
      off();
      offFx();
    };
  }, [rig]);
  useFrame((state, dt) => {
    telemetry.fps = telemetry.fps * 0.95 + (1 / Math.max(dt, 0.001)) * 0.05;
    rig.update(Math.min(dt, 0.05), state.size.width, state.size.height);
  }, -3);
  return null;
}
