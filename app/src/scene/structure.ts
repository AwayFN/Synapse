import { useMemo } from 'react';
import { useData, type DataState } from '../store/data';

export interface SNode {
  id: string;
}

export interface SEdge {
  key: string;
  a: string;
  b: string;
}

export interface Structure {
  key: string;
  nodes: SNode[];
  edges: SEdge[];
}

export const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Ce qui change la géométrie 3D : quels neurones existent et lesquels sont reliés.
 * Genre, statut, force des liens… sont des attributs mis à jour à chaque image, sans reconstruction.
 */
function structureKey(s: DataState): string {
  const ents = Object.values(s.entities).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  let k = '';
  for (const e of ents) k += `${e.id};`;
  k += '#';
  for (const l of s.links) k += `${l.a}${l.b};`;
  return k;
}

export function useStructure(): Structure {
  const key = useData(structureKey);
  return useMemo(() => {
    const s = useData.getState();
    const nodes = Object.values(s.entities)
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map((e) => ({ id: e.id }));
    const seen = new Set<string>();
    const edges: SEdge[] = [];
    for (const l of s.links) {
      if (!s.entities[l.a] || !s.entities[l.b] || l.a === l.b) continue;
      const k = edgeKey(l.a, l.b);
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push({ key: k, a: l.a, b: l.b });
    }
    return { key, nodes, edges };
  }, [key]);
}
