import { hasProject, type Entity, type Link, type Note, type Slot, type Task } from '../types';

export type EdgeKind = 'parent' | 'link';

export interface Edge {
  key: string;
  a: string;
  b: string;
  kind: EdgeKind;
}

/** All visible relations: explicit links + task / slot / note → parent project */
export function computeEdges(entities: Record<string, Entity>, links: Link[]): Edge[] {
  const out: Edge[] = [];
  const seen = new Set<string>();
  const push = (a: string, b: string, kind: EdgeKind) => {
    if (!entities[a] || !entities[b] || a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ key, a, b, kind });
  };
  for (const e of Object.values(entities)) {
    if (hasProject(e) && e.projectId) push(e.projectId, e.id, 'parent');
  }
  for (const l of links) push(l.a, l.b, 'link');
  return out;
}

export interface Neighbor {
  entity: Entity;
  kind: EdgeKind;
  /** for 'parent' edges: is the neighbor the parent of the subject? */
  isParent?: boolean;
}

export function neighborsOf(entities: Record<string, Entity>, links: Link[], id: string): Neighbor[] {
  const self = entities[id];
  if (!self) return [];
  const out: Neighbor[] = [];
  const seen = new Set<string>();
  if (hasProject(self) && self.projectId && entities[self.projectId]) {
    out.push({ entity: entities[self.projectId], kind: 'parent', isParent: true });
    seen.add(self.projectId);
  }
  if (self.type === 'project') {
    for (const e of Object.values(entities)) {
      if (hasProject(e) && e.projectId === id && !seen.has(e.id)) {
        out.push({ entity: e, kind: 'parent', isParent: false });
        seen.add(e.id);
      }
    }
  }
  for (const l of links) {
    const other = l.a === id ? l.b : l.b === id ? l.a : null;
    if (!other || seen.has(other) || !entities[other]) continue;
    seen.add(other);
    out.push({ entity: entities[other], kind: 'link' });
  }
  return out;
}

export function projectTasks(entities: Record<string, Entity>, projectId: string): Task[] {
  return Object.values(entities)
    .filter((e): e is Task => e.type === 'task' && e.projectId === projectId)
    .sort((a, b) => a.order - b.order);
}

/** Les notes d'un projet (les plus récemment modifiées d'abord) */
export function projectNotes(entities: Record<string, Entity>, projectId: string): Note[] {
  return Object.values(entities)
    .filter((e): e is Note => e.type === 'note' && e.projectId === projectId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Les créneaux de l'agenda consacrés à un projet (les plus récents d'abord) */
export function projectSlots(entities: Record<string, Entity>, projectId: string): Slot[] {
  return Object.values(entities)
    .filter((e): e is Slot => e.type === 'slot' && e.projectId === projectId)
    .sort((a, b) => b.date.localeCompare(a.date) || b.start - a.start);
}
