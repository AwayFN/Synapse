import type { Entity, Link } from '../types';
import { isHubKind } from '../lib/kinds';

export interface Adj {
  other: string;
  link: Link;
}

const DAY = 86400000;
const adjCache = new WeakMap<Link[], Map<string, Adj[]>>();

/** id → connexions (mémorisé par tableau de liens) */
export function adjacency(links: Link[]): Map<string, Adj[]> {
  let m = adjCache.get(links);
  if (m) return m;
  m = new Map();
  for (const l of links) {
    if (!m.has(l.a)) m.set(l.a, []);
    if (!m.has(l.b)) m.set(l.b, []);
    m.get(l.a)!.push({ other: l.b, link: l });
    m.get(l.b)!.push({ other: l.a, link: l });
  }
  adjCache.set(links, m);
  return m;
}

/**
 * Force ressentie d'une connexion : celle qu'on emprunte reste vive,
 * celle qu'on oublie s'affaiblit lentement sans jamais disparaître.
 */
export function effectiveStrength(l: Link, now = Date.now()): number {
  const idle = Math.max(0, now - (l.usedAt || l.createdAt));
  const decay = Math.exp(-idle / (150 * DAY));
  return Math.max(0.12, Math.min(1, l.strength * (0.45 + 0.55 * decay)));
}

/** Fraîcheur 1 → 0 dans les heures qui suivent la création */
export function freshness(l: Link, now = Date.now()): number {
  return Math.exp(-Math.max(0, now - l.createdAt) / (5 * 3600000));
}

export function findLink(links: Link[], a: string, b: string): Link | undefined {
  return adjacency(links).get(a)?.find((x) => x.other === b)?.link;
}

export interface Neighbor {
  entity: Entity;
  link: Link;
  strength: number;
}

export function neighborsOf(entities: Record<string, Entity>, links: Link[], id: string): Neighbor[] {
  const now = Date.now();
  const out: Neighbor[] = [];
  for (const { other, link } of adjacency(links).get(id) ?? []) {
    const e = entities[other];
    if (e) out.push({ entity: e, link, strength: effectiveStrength(link, now) });
  }
  return out.sort((x, y) => y.strength - x.strength || y.entity.touchedAt - x.entity.touchedAt);
}

export function degreeOf(links: Link[], id: string): number {
  return adjacency(links).get(id)?.length ?? 0;
}

export interface Distant {
  entity: Entity;
  via: Entity;
  score: number;
}

/** Plus loin dans le réseau : voisins des voisins, classés par la force du chemin */
export function secondDegree(entities: Record<string, Entity>, links: Link[], id: string, limit = 8): Distant[] {
  const adj = adjacency(links);
  const now = Date.now();
  const direct = new Set((adj.get(id) ?? []).map((x) => x.other));
  direct.add(id);
  const best = new Map<string, Distant>();
  for (const n1 of adj.get(id) ?? []) {
    const via = entities[n1.other];
    if (!via) continue;
    const s1 = effectiveStrength(n1.link, now);
    for (const n2 of adj.get(n1.other) ?? []) {
      if (direct.has(n2.other)) continue;
      const e = entities[n2.other];
      if (!e) continue;
      const score = s1 * effectiveStrength(n2.link, now);
      const cur = best.get(e.id);
      if (!cur || cur.score < score) best.set(e.id, { entity: e, via, score });
    }
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Actions reliées (pour un projet, un objectif ou n'importe quel neurone) */
export function linkedActions(entities: Record<string, Entity>, links: Link[], id: string): Entity[] {
  const out: Entity[] = [];
  for (const { other } of adjacency(links).get(id) ?? []) {
    const e = entities[other];
    if (e && e.status && !isHubKind(e.kind)) out.push(e);
  }
  return out.sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || a.order - b.order);
}

/** Nœuds centraux reliés à un neurone (son « projet ») */
export function linkedHubs(entities: Record<string, Entity>, links: Link[], id: string): Entity[] {
  const out: Entity[] = [];
  for (const { other } of adjacency(links).get(id) ?? []) {
    const e = entities[other];
    if (e && isHubKind(e.kind)) out.push(e);
  }
  return out;
}

export function progressOf(entities: Record<string, Entity>, links: Link[], id: string): [number, number] {
  const acts = linkedActions(entities, links, id);
  return [acts.filter((a) => a.status === 'done').length, acts.length];
}
