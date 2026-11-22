import type { Entity } from '../types';
import { STATUS_LABEL } from '../types';
import { isHubKind, kindLabel } from './kinds';
import { diffDays, fmtDateNum, fmtDay, fmtWhen, todayISO, whenEndTs, whenStartTs } from './time';

const DAY = 86400000;

export function displayTitle(e: Entity | undefined | null): string {
  if (!e) return '—';
  const t = e.title.trim();
  if (t) return t;
  const first = e.body.trim().split('\n')[0]?.trim();
  if (first) return first.length > 60 ? first.slice(0, 59) + '…' : first;
  return 'Sans titre';
}

export function isDone(e: Entity): boolean {
  return e.status === 'done';
}

/** Moment en cours (entre son début et sa fin) */
export function isNow(e: Entity, now = Date.now()): boolean {
  if (!e.when || e.when.start == null) return false;
  return whenStartTs(e.when) <= now && now < whenEndTs(e.when);
}

/** À accomplir et dépassé : échéance passée, ou action prévue un jour passé */
export function isLate(e: Entity, today = todayISO()): boolean {
  if (e.status === 'done') return false;
  if (e.due && e.due < today) return true;
  if (e.status && e.when && e.when.date < today) return true;
  return false;
}

/** Moment passé (et pas une action en attente) */
export function isPast(e: Entity, now = Date.now()): boolean {
  if (!e.when) return false;
  if (e.status === 'todo' || e.status === 'doing') return false;
  return whenEndTs(e.when) <= now;
}

/**
 * Vitalité 0.1..1 : ce qui est récent, en cours, imminent ou épinglé brille ;
 * ce qui est terminé, passé ou oublié depuis longtemps s'estompe.
 */
export function vitality(e: Entity, now = Date.now()): number {
  const age = Math.max(0, now - (e.touchedAt || e.updatedAt || e.createdAt));
  let v = Math.exp(-age / (14 * DAY));
  if (e.pinned) v = Math.max(v, 0.78);
  if (e.status === 'doing') v = Math.max(v, 0.92);
  if (e.when) {
    const s = whenStartTs(e.when);
    const en = whenEndTs(e.when);
    if (s <= now && now < en) v = 1;
    else if (s > now && s - now < 2 * DAY) v = Math.max(v, 0.9);
    else if (s > now && s - now < 7 * DAY) v = Math.max(v, 0.68);
  }
  if (e.due && e.status !== 'done') {
    const d = diffDays(e.due, todayISO());
    if (d <= 3) v = Math.max(v, 0.88);
  }
  if (isPast(e, now)) v = Math.min(v, 0.3);
  if (e.status === 'done') v = Math.min(v, 0.28);
  return Math.max(0.1, Math.min(1, v));
}

export type LifeState = 'vivid' | 'calm' | 'dormant' | 'done';
export function lifeState(e: Entity, now = Date.now()): LifeState {
  if (e.status === 'done' || isPast(e, now)) return 'done';
  const v = vitality(e, now);
  return v >= 0.6 ? 'vivid' : v >= 0.3 ? 'calm' : 'dormant';
}

/** Importance 0..1 : nœud central, épinglé, très connecté, développé */
export function importance(e: Entity, degree: number, strengthSum: number): number {
  let x = 0.1 + Math.log2(1 + degree) * 0.15 + Math.min(strengthSum, 6) * 0.02;
  if (isHubKind(e.kind)) x += 0.3;
  if (e.pinned) x += 0.2;
  if (e.body.length > 400) x += 0.05;
  return Math.max(0, Math.min(1, x));
}

/** Ligne de méta courte, sans le genre : "EN COURS · DEMAIN 14:00", "⟶ 30/12", "#idee #business" */
export function metaLine(e: Entity, opts?: { progress?: [number, number]; tags?: boolean }): string {
  const parts: string[] = [];
  if (e.status && !(isHubKind(e.kind) && e.status === 'doing')) parts.push(STATUS_LABEL[e.status]);
  if (opts?.progress && opts.progress[1] > 0) parts.push(`${opts.progress[0]}/${opts.progress[1]} actions`);
  if (e.when) parts.push(fmtWhen(e.when));
  if (e.due) parts.push(`⟶ ${fmtDateNum(e.due)}`);
  if (opts?.tags !== false && e.tags.length && parts.length < 2) parts.push(e.tags.slice(0, 3).map((t) => `#${t}`).join(' '));
  return parts.join(' · ');
}

/** "IDÉE", "TÂCHE", "PENSÉE" */
export function kindTag(e: Entity): string {
  return kindLabel(e.kind).toUpperCase();
}

export function dueLabel(e: Entity): string | null {
  if (!e.due) return null;
  return fmtDay(e.due);
}
