import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Activity, Entity, EntityType, Link, Note, Project, Slot, Task, TaskStatus } from '../types';
import { hasProject, TASK_STATUS_LABEL, TYPE_LABEL } from '../types';
import { uid } from '../lib/random';
import { pickColor } from '../lib/color';
import { minutesNow, todayISO } from '../lib/time';
import { debouncedStorage } from './storage';
import { fx } from './fx';
import { buildSeed } from './seed';

export interface Snapshot {
  entity: Entity;
  links: Link[];
  childTaskIds: string[];
}

export interface CreateOpts {
  /** entity ids to link the new one to */
  linkTo?: string[];
  /** spawn the constellation near this entity */
  near?: string | null;
}

type Fields<T> = Partial<Omit<T, 'id' | 'type' | 'createdAt' | 'updatedAt'>>;

export interface DataState {
  entities: Record<string, Entity>;
  links: Link[];
  activity: Activity[];

  createProject: (input?: Fields<Project>, opts?: CreateOpts) => Project;
  createTask: (input?: Fields<Task>, opts?: CreateOpts) => Task;
  createNote: (input?: Fields<Note>, opts?: CreateOpts) => Note;
  createSlot: (input?: Fields<Slot>, opts?: CreateOpts) => Slot;
  update: (id: string, patch: Partial<Entity>) => void;
  setTaskStatus: (id: string, status: TaskStatus) => void;
  /** Kanban drop: put task in `status` column, before `beforeId` (or at the end) */
  moveTask: (id: string, status: TaskStatus, beforeId: string | null) => void;
  remove: (id: string, opts?: { silent?: boolean }) => Snapshot | null;
  restore: (snap: Snapshot) => void;
  link: (a: string, b: string) => boolean;
  unlink: (a: string, b: string) => void;
  clearSeed: () => number;
  replaceAll: (data: { entities: Record<string, Entity>; links: Link[] }) => void;
  log: (text: string, color: string, entityId?: string) => void;
}

const now = () => Date.now();

/**
 * Invité « peut regarder » : rien ne se modifie chez lui (et on le lui dit). Le serveur refuse de toute façon
 * ses modifications ; ici on évite qu'il croie avoir changé quelque chose.
 */
let readOnly = false;
let onDenied: (() => void) | null = null;
export function setDataReadOnly(v: boolean, denied?: () => void) {
  readOnly = v;
  if (denied) onDenied = denied;
}
const blocked = () => {
  if (!readOnly) return false;
  onDenied?.();
  return true;
};

function nextOrder(entities: Record<string, Entity>, status: TaskStatus): number {
  let max = 0;
  for (const e of Object.values(entities)) if (e.type === 'task' && e.status === status) max = Math.max(max, e.order);
  return max + 1;
}

const TYPE_OFFSET: Record<EntityType, number> = { project: 0, task: 1, note: 2, slot: 4 };

/**
 * Un élément avec tous ses champs V6 : des tags (sur tout), et un projet pour les notes (null : indépendante).
 * Les éléments d'avant (navigateur, export, ancien serveur) n'en avaient pas forcément.
 */
export function withDefaults(e: Entity): Entity {
  let x = e;
  if (!Array.isArray(x.tags)) x = { ...x, tags: [] } as Entity;
  if (x.type === 'note' && x.projectId === undefined) x = { ...x, projectId: null };
  return x;
}

export function normalizeEntities(entities: Record<string, Entity>): Record<string, Entity> {
  let out: Record<string, Entity> | null = null;
  for (const [id, e] of Object.entries(entities)) {
    const x = withDefaults(e);
    if (x !== e) {
      out ??= { ...entities };
      out[id] = x;
    }
  }
  return out ?? entities;
}

export function displayTitle(e: Entity | undefined | null): string {
  if (!e) return '—';
  const t = e.title.trim();
  if (t) return t;
  if (e.type === 'note') {
    const first = e.content.trim().split('\n')[0]?.trim();
    if (first) return first.length > 48 ? first.slice(0, 47) + '…' : first;
  }
  return 'Sans titre';
}

export const useData = create<DataState>()(
  persist(
    (set, get) => {
      const log = (text: string, color: string, entityId?: string) => {
        if (readOnly) return;
        const item: Activity = { id: uid(), at: now(), text, color, entityId };
        set((s) => ({ activity: [item, ...s.activity].slice(0, 60) }));
      };

      function insert<T extends Entity>(entity: T, opts?: CreateOpts): T {
        if (blocked()) return entity;
        const linkTo = (opts?.linkTo ?? []).filter((id) => id !== entity.id);
        set((s) => {
          const links = [...s.links];
          for (const other of linkTo) {
            if (!s.entities[other]) continue;
            if (hasProject(entity) && entity.projectId === other) continue;
            if (links.some((l) => (l.a === entity.id && l.b === other) || (l.b === entity.id && l.a === other))) continue;
            links.push({ id: uid(), a: entity.id, b: other, createdAt: now() });
          }
          return { entities: { ...s.entities, [entity.id]: entity }, links };
        });
        const near = opts?.near ?? (hasProject(entity) ? entity.projectId : null) ?? linkTo[0] ?? null;
        fx.emit({ kind: 'birth', id: entity.id, near });
        log(`+ ${TYPE_LABEL[entity.type].toUpperCase()}  ${displayTitle(entity)}`, entity.color, entity.id);
        return entity;
      }

      function base(type: EntityType) {
        const t = now();
        return {
          id: uid(),
          color: pickColor(
            Object.values(get().entities).map((e) => e.color),
            TYPE_OFFSET[type],
          ),
          createdAt: t,
          updatedAt: t,
        };
      }

      const initial = buildSeed();

      return {
        entities: initial.entities,
        links: initial.links,
        activity: [{ id: uid(), at: now(), text: 'RÉSEAU INITIALISÉ', color: '#00e5ff' }],
        log,

        createProject: (input, opts) =>
          insert<Project>(
            {
              ...base('project'),
              type: 'project',
              title: '',
              description: '',
              status: 'active',
              deadline: null,
              tags: [],
              ...input,
            } as Project,
            opts,
          ),

        createTask: (input, opts) => {
          const status = input?.status ?? 'todo';
          return insert<Task>(
            {
              ...base('task'),
              type: 'task',
              title: '',
              description: '',
              projectId: null,
              status,
              date: null,
              time: null,
              order: nextOrder(get().entities, status),
              doneAt: status === 'done' ? now() : null,
              tags: [],
              ...input,
            } as Task,
            opts,
          );
        },

        createNote: (input, opts) =>
          insert<Note>(
            {
              ...base('note'),
              type: 'note',
              title: '',
              content: '',
              tags: [],
              projectId: null,
              ...input,
            } as Note,
            opts,
          ),

        createSlot: (input, opts) => {
          const start = input?.start ?? Math.min(1380, Math.ceil(minutesNow() / 15) * 15);
          return insert<Slot>(
            {
              ...base('slot'),
              type: 'slot',
              title: '',
              description: '',
              projectId: null,
              date: todayISO(),
              start,
              end: (start + 60) % 1440,
              tags: [],
              ...input,
            } as Slot,
            opts,
          );
        },

        update: (id, patch) => {
          const e = get().entities[id];
          if (!e || blocked()) return;
          if (e.type === 'task' && 'status' in patch && patch.status && patch.status !== e.status) {
            const { status, ...rest } = patch as Partial<Task>;
            if (Object.keys(rest).length) get().update(id, rest as Partial<Entity>);
            get().setTaskStatus(id, status as TaskStatus);
            return;
          }
          const prevProject = hasProject(e) ? e.projectId : null;
          set((s) => ({
            entities: { ...s.entities, [id]: { ...s.entities[id], ...patch, updatedAt: now() } as Entity },
          }));
          const next = get().entities[id];
          if (hasProject(next) && next.projectId && next.projectId !== prevProject) {
            // a parent link replaces any explicit link between the two
            set((s) => ({
              links: s.links.filter(
                (l) => !((l.a === id && l.b === next.projectId) || (l.b === id && l.a === next.projectId)),
              ),
            }));
            fx.emit({ kind: 'link', a: id, b: next.projectId });
          } else {
            fx.emit({ kind: 'touch', id });
          }
          if ('status' in patch && e.type === 'project' && patch.status !== e.status) {
            log(
              `${patch.status === 'done' ? '✓ PROJET TERMINÉ' : '↺ PROJET RELANCÉ'}  ${displayTitle(e)}`,
              e.color,
              id,
            );
            if (patch.status === 'done') fx.emit({ kind: 'celebrate', id });
          }
        },

        setTaskStatus: (id, status) => {
          if (blocked()) return;
          const t = get().entities[id];
          if (!t || t.type !== 'task' || t.status === status) return;
          const order = nextOrder(get().entities, status);
          set((s) => ({
            entities: {
              ...s.entities,
              [id]: { ...t, status, order, doneAt: status === 'done' ? now() : null, updatedAt: now() },
            },
          }));
          if (status === 'done') {
            fx.emit({ kind: 'celebrate', id });
            log(`✓ ACCOMPLIE  ${displayTitle(t)}`, t.color, id);
          } else {
            fx.emit({ kind: 'touch', id });
            log(`→ ${TASK_STATUS_LABEL[status].toUpperCase()}  ${displayTitle(t)}`, t.color, id);
          }
        },

        moveTask: (id, status, beforeId) => {
          if (blocked()) return;
          const t = get().entities[id];
          if (!t || t.type !== 'task') return;
          const col = Object.values(get().entities)
            .filter((e): e is Task => e.type === 'task' && e.status === status && e.id !== id)
            .sort((a, b) => a.order - b.order);
          let order: number;
          const idx = beforeId ? col.findIndex((x) => x.id === beforeId) : -1;
          if (idx === -1) order = (col[col.length - 1]?.order ?? 0) + 1;
          else if (idx === 0) order = col[0].order - 1;
          else order = (col[idx - 1].order + col[idx].order) / 2;
          const statusChanged = t.status !== status;
          set((s) => ({
            entities: {
              ...s.entities,
              [id]: {
                ...t,
                status,
                order,
                doneAt: status === 'done' ? (t.doneAt ?? now()) : null,
                updatedAt: now(),
              },
            },
          }));
          if (statusChanged) {
            if (status === 'done') {
              fx.emit({ kind: 'celebrate', id });
              log(`✓ ACCOMPLIE  ${displayTitle(t)}`, t.color, id);
            } else {
              fx.emit({ kind: 'touch', id });
              log(`→ ${TASK_STATUS_LABEL[status].toUpperCase()}  ${displayTitle(t)}`, t.color, id);
            }
          }
        },

        remove: (id, opts) => {
          if (blocked()) return null;
          const s = get();
          const e = s.entities[id];
          if (!e) return null;
          const links = s.links.filter((l) => l.a === id || l.b === id);
          // tâches et créneaux du projet : ils restent, sans projet
          const childTaskIds = Object.values(s.entities)
            .filter((x) => hasProject(x) && x.projectId === id)
            .map((x) => x.id);
          fx.emit({ kind: 'death', id });
          const entities = { ...s.entities };
          delete entities[id];
          for (const cid of childTaskIds) entities[cid] = { ...(entities[cid] as Task | Slot), projectId: null };
          set({ entities, links: s.links.filter((l) => l.a !== id && l.b !== id) });
          if (opts?.silent) {
            // discarded draft: leave no trace in the activity log
            set((st) => ({ activity: st.activity.filter((a) => a.entityId !== id) }));
          } else {
            log(`− ${TYPE_LABEL[e.type].toUpperCase()}  ${displayTitle(e)}`, '#ff4d6d');
          }
          return { entity: e, links, childTaskIds };
        },

        restore: (snap) => {
          if (blocked()) return;
          set((s) => {
            const entities = { ...s.entities, [snap.entity.id]: snap.entity };
            for (const cid of snap.childTaskIds) {
              const t = entities[cid];
              if (hasProject(t) && t.projectId == null) entities[cid] = { ...t, projectId: snap.entity.id };
            }
            const links = [
              ...s.links,
              ...snap.links.filter((l) => entities[l.a] && entities[l.b] && !s.links.some((x) => x.id === l.id)),
            ];
            return { entities, links };
          });
          fx.emit({ kind: 'birth', id: snap.entity.id });
          log(`↺ RESTAURÉ  ${displayTitle(snap.entity)}`, snap.entity.color, snap.entity.id);
        },

        link: (a, b) => {
          if (blocked()) return false;
          const s = get();
          const ea = s.entities[a];
          const eb = s.entities[b];
          if (!ea || !eb || a === b) return false;
          if (hasProject(ea) && ea.projectId === b) return false;
          if (hasProject(eb) && eb.projectId === a) return false;
          if (s.links.some((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a))) return false;
          set({ links: [...s.links, { id: uid(), a, b, createdAt: now() }] });
          fx.emit({ kind: 'link', a, b });
          log(`⟷ LIEN  ${displayTitle(ea)} ↔ ${displayTitle(eb)}`, ea.color);
          return true;
        },

        unlink: (a, b) => {
          if (blocked()) return;
          const s = get();
          const ea = s.entities[a];
          const eb = s.entities[b];
          if (hasProject(ea) && ea.projectId === b) {
            set({ entities: { ...s.entities, [a]: { ...ea, projectId: null, updatedAt: now() } } });
          } else if (hasProject(eb) && eb.projectId === a) {
            set({ entities: { ...s.entities, [b]: { ...eb, projectId: null, updatedAt: now() } } });
          }
          set((st) => ({ links: st.links.filter((l) => !((l.a === a && l.b === b) || (l.a === b && l.b === a))) }));
          if (ea && eb) log(`✕ LIEN  ${displayTitle(ea)} ↔ ${displayTitle(eb)}`, '#888');
        },

        clearSeed: () => {
          if (blocked()) return 0;
          const s = get();
          const seedIds = new Set(Object.values(s.entities).filter((e) => e.seed).map((e) => e.id));
          if (!seedIds.size) return 0;
          for (const id of seedIds) fx.emit({ kind: 'death', id });
          const entities: Record<string, Entity> = {};
          for (const e of Object.values(s.entities)) {
            if (seedIds.has(e.id)) continue;
            entities[e.id] = hasProject(e) && e.projectId && seedIds.has(e.projectId) ? { ...e, projectId: null } : e;
          }
          set({ entities, links: s.links.filter((l) => !seedIds.has(l.a) && !seedIds.has(l.b)) });
          log(`− ${seedIds.size} EXEMPLES SUPPRIMÉS`, '#ff4d6d');
          return seedIds.size;
        },

        replaceAll: (data) => {
          if (blocked()) return;
          set({ entities: normalizeEntities(data.entities), links: data.links });
          log(`↓ IMPORT  ${Object.keys(data.entities).length} ENTITÉS`, '#00e5ff');
        },
      };
    },
    {
      name: 'synapse-data',
      // 2 : des tags sur tout, et un projet (ou rien) pour les notes
      version: 2,
      storage: createJSONStorage(() => debouncedStorage),
      partialize: (s) => ({ entities: s.entities, links: s.links, activity: s.activity }),
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Partial<DataState>;
        return { ...p, entities: normalizeEntities(p.entities ?? {}) } as DataState;
      },
    },
  ),
);
