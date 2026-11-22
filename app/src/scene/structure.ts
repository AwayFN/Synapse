import { useMemo } from 'react';
import type { EntityType } from '../types';
import { useData, type DataState } from '../store/data';
import { computeEdges, type Edge } from '../store/graph';

export interface SNode {
  id: string;
  type: EntityType;
  color: string;
}

export interface Structure {
  key: string;
  nodes: SNode[];
  edges: Edge[];
}

/** Only what changes the 3D geometry: ids, types, colors, relations (not titles / text) */
function structureKey(s: DataState): string {
  const ents = Object.values(s.entities).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  let k = '';
  for (const e of ents) k += `${e.id}:${e.type[0]}${e.color}${e.type === 'task' ? (e.projectId ?? '') : ''};`;
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
      .map((e) => ({ id: e.id, type: e.type, color: e.color }));
    return { key, nodes, edges: computeEdges(s.entities, s.links) };
  }, [key]);
}
