import * as THREE from 'three';
import type { Nature } from '../types';
import { useData, type DataState } from '../store/data';
import { adjacency, effectiveStrength, freshness } from '../store/graph';
import { isHubKind, natureOfKind, NATURES } from '../lib/kinds';
import { importance, isLate, isNow, isPast, vitality } from '../lib/entity';
import { todayISO } from '../lib/time';
import { edgeKey } from './structure';

/** Ce que le réseau doit montrer d'un neurone, dérivé des données (pas de couleur arbitraire) */
export interface Visual {
  nature: Nature;
  color: THREE.Color;
  /** nombre de branches (dendrites) du neurone : 3 + ses liens, jusqu'à 10 */
  branches: number;
  /** nœud central (projet, objectif, ou très relié) : branches plus épaisses */
  hub: number;
  /** rayon du glyphe (unités monde) */
  glyph: number;
  /** encombrement dans la mise en page */
  space: number;
  importance: number;
  vitality: number;
  /** terminé ou passé : néon éteint */
  done: number;
  /** en retard : le néon grésille */
  alert: number;
  /** en cours / maintenant : bat comme un cœur */
  active: number;
  degree: number;
  tags: string[];
}

export interface EdgeVisual {
  strength: number;
  fresh: number;
}

export const NATURE_COLOR: Record<Nature, THREE.Color> = {
  pensee: new THREE.Color(NATURES.pensee.hex),
  action: new THREE.Color(NATURES.action.hex),
  temps: new THREE.Color(NATURES.temps.hex),
  monde: new THREE.Color(NATURES.monde.hex),
};

export const DEFAULT_VISUAL: Visual = {
  nature: 'pensee',
  color: NATURE_COLOR.pensee,
  branches: 3,
  hub: 0,
  glyph: 1,
  space: 5,
  importance: 0.2,
  vitality: 0.6,
  done: 0,
  alert: 0,
  active: 0,
  degree: 0,
  tags: [],
};

class Visuals {
  nodes = new Map<string, Visual>();
  edges = new Map<string, EdgeVisual>();
  version = 0;
  private seen: { e: unknown; l: unknown; k: unknown } = { e: null, l: null, k: null };
  private at = 0;

  /** Recalcule si les données ont changé, ou toutes les 30 s (la vitalité dépend de l'heure) */
  refresh(force = false) {
    const s = useData.getState();
    const stale = performance.now() - this.at > 30000;
    if (!force && !stale && s.entities === this.seen.e && s.links === this.seen.l && s.kinds === this.seen.k) return false;
    this.seen = { e: s.entities, l: s.links, k: s.kinds };
    this.at = performance.now();
    this.compute(s);
    return true;
  }

  private compute(s: DataState) {
    const now = Date.now();
    const today = todayISO();
    const adj = adjacency(s.links);
    const nodes = new Map<string, Visual>();
    for (const e of Object.values(s.entities)) {
      const nb = adj.get(e.id) ?? [];
      let sum = 0;
      for (const x of nb) sum += effectiveStrength(x.link, now);
      const imp = importance(e, nb.length, sum);
      const vit = vitality(e, now);
      const done = e.status === 'done' || isPast(e, now) ? 1 : 0;
      const nature = natureOfKind(e.kind, s.kinds);
      const hub = isHubKind(e.kind) || nb.length >= 7 ? 1 : 0;
      let glyph = 0.8 + imp * 1.85;
      if (done) glyph *= 0.72;
      else if (vit < 0.3) glyph *= 0.88;
      nodes.set(e.id, {
        nature,
        color: NATURE_COLOR[nature],
        // un neurone se ramifie avec ses liens : une pensée isolée a 3 branches, une pensée très reliée en a 10
        branches: Math.min(10, 3 + Math.min(nb.length, 7) + hub),
        hub,
        glyph,
        space: 4.4 + imp * 5.4,
        importance: imp,
        vitality: vit,
        done,
        alert: isLate(e, today) ? 1 : 0,
        active: e.status === 'doing' || isNow(e, now) ? 1 : 0,
        degree: nb.length,
        tags: e.tags,
      });
    }
    const edges = new Map<string, EdgeVisual>();
    for (const l of s.links) edges.set(edgeKey(l.a, l.b), { strength: effectiveStrength(l, now), fresh: freshness(l, now) });
    this.nodes = nodes;
    this.edges = edges;
    this.version++;
  }

  get(id: string): Visual {
    return this.nodes.get(id) ?? DEFAULT_VISUAL;
  }
}

export const visuals = new Visuals();
