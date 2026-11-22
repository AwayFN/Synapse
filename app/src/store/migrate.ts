import type { Activity, Entity, Link, Nature, Status, When } from '../types';
import { uid } from '../lib/random';
import { builtinKind, kindKey, type KindRegistry } from '../lib/kinds';
import { isValidISODate } from '../lib/time';
import { normalizeTag } from '../lib/text';

/**
 * V1 → V2 : projets, tâches, notes et créneaux deviennent des neurones avec un genre
 * (projet, tâche, note, créneau). Rien n'est perdu : descriptions → contenu, projet parent → lien,
 * dates/heures → moment, deadline → échéance. Les identifiants sont conservés (positions 3D comprises).
 */
export const V1_BACKUP_KEY = 'synapse-data-v1-backup';

interface V1Entity {
  id: string;
  type: 'project' | 'task' | 'note' | 'slot';
  title?: string;
  description?: string;
  content?: string;
  tags?: string[];
  status?: string;
  deadline?: string | null;
  projectId?: string | null;
  date?: string | null;
  time?: number | null;
  start?: number;
  end?: number;
  order?: number;
  doneAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  seed?: boolean;
}

interface V1Link {
  id?: string;
  a: string;
  b: string;
  createdAt?: number;
}

export interface V2Data {
  entities: Record<string, Entity>;
  links: Link[];
  kinds: KindRegistry;
  activity?: Activity[];
}

const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const minutes = (x: unknown): number | null => (typeof x === 'number' && x >= 0 && x < 1440 ? Math.round(x) : null);

function v1ToEntity(e: V1Entity): { entity: Entity; parent: string | null } | null {
  if (!e || typeof e.id !== 'string') return null;
  const now = Date.now();
  const createdAt = num(e.createdAt, now);
  const updatedAt = num(e.updatedAt, createdAt);
  const base: Entity = {
    id: e.id,
    title: typeof e.title === 'string' ? e.title : '',
    body: '',
    kind: '',
    tags: [],
    status: null,
    when: null,
    due: null,
    pinned: false,
    order: num(e.order, 0),
    createdAt,
    updatedAt,
    touchedAt: updatedAt,
    doneAt: null,
    ...(e.seed ? { seed: true } : {}),
  };
  switch (e.type) {
    case 'project':
      return {
        entity: {
          ...base,
          kind: 'projet',
          body: e.description ?? '',
          status: e.status === 'done' ? 'done' : 'doing',
          due: isValidISODate(e.deadline) ? e.deadline : null,
          doneAt: e.status === 'done' ? updatedAt : null,
        },
        parent: null,
      };
    case 'task': {
      const status: Status = e.status === 'doing' || e.status === 'done' ? e.status : 'todo';
      const when: When | null = isValidISODate(e.date) ? { date: e.date, start: minutes(e.time), end: null } : null;
      return {
        entity: {
          ...base,
          kind: 'tâche',
          body: e.description ?? '',
          status,
          when,
          doneAt: status === 'done' ? num(e.doneAt, updatedAt) : null,
        },
        parent: typeof e.projectId === 'string' ? e.projectId : null,
      };
    }
    case 'note':
      return {
        entity: {
          ...base,
          kind: 'note',
          body: e.content ?? '',
          tags: Array.isArray(e.tags) ? e.tags.map((t) => normalizeTag(String(t))).filter(Boolean) : [],
        },
        parent: null,
      };
    case 'slot': {
      const date = isValidISODate(e.date) ? e.date : null;
      return {
        entity: {
          ...base,
          kind: 'créneau',
          body: e.description ?? '',
          when: date ? { date, start: minutes(e.start) ?? 0, end: minutes(e.end) } : null,
        },
        parent: null,
      };
    }
    default:
      return null;
  }
}

/** Convertit un état V1 (stockage local ou export JSON) */
export function migrateV1(data: { entities?: Record<string, unknown> | unknown[]; links?: unknown[]; activity?: unknown[] }): V2Data {
  const entities: Record<string, Entity> = {};
  const parents: [string, string][] = [];
  const list = Array.isArray(data.entities) ? data.entities : Object.values(data.entities ?? {});
  for (const raw of list) {
    const r = v1ToEntity(raw as V1Entity);
    if (!r) continue;
    entities[r.entity.id] = r.entity;
    if (r.parent) parents.push([r.entity.id, r.parent]);
  }
  const links: Link[] = [];
  const seen = new Set<string>();
  const push = (a: string, b: string, at: number, strength: number) => {
    if (!entities[a] || !entities[b] || a === b) return;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ id: uid(), a, b, createdAt: at, strength, usedAt: at, origin: 'manuel' });
  };
  for (const [task, project] of parents) push(project, task, entities[task].createdAt, 0.65);
  for (const l of (data.links ?? []) as V1Link[]) {
    if (!l || typeof l.a !== 'string' || typeof l.b !== 'string') continue;
    push(l.a, l.b, num(l.createdAt, Date.now()), 0.5);
  }
  const activity: Activity[] = [];
  for (const a of (data.activity ?? []) as { id?: string; at?: number; text?: string; entityId?: string }[]) {
    if (!a || typeof a.text !== 'string') continue;
    activity.push({ id: a.id ?? uid(), at: num(a.at, Date.now()), text: a.text, tone: 'system', entityId: a.entityId });
  }
  return { entities, links, kinds: {}, activity };
}

const STATUSES = ['todo', 'doing', 'done'];

/** Nettoie un état V2 (import JSON) : champs manquants, valeurs invalides */
export function sanitizeV2(data: { entities?: Record<string, unknown>; links?: unknown[]; kinds?: unknown }): V2Data {
  const entities: Record<string, Entity> = {};
  const now = Date.now();
  for (const raw of Object.values(data.entities ?? {})) {
    const e = raw as Partial<Entity>;
    if (!e || typeof e.id !== 'string') continue;
    const createdAt = num(e.createdAt, now);
    const w = e.when as When | null | undefined;
    entities[e.id] = {
      id: e.id,
      title: typeof e.title === 'string' ? e.title : '',
      body: typeof e.body === 'string' ? e.body : '',
      kind: typeof e.kind === 'string' ? e.kind : '',
      tags: Array.isArray(e.tags) ? e.tags.map((t) => normalizeTag(String(t))).filter(Boolean) : [],
      status: STATUSES.includes(e.status as string) ? (e.status as Status) : null,
      when: w && isValidISODate(w.date) ? { date: w.date, start: minutes(w.start), end: minutes(w.end) } : null,
      due: isValidISODate(e.due) ? e.due : null,
      pinned: !!e.pinned,
      order: num(e.order, 0),
      createdAt,
      updatedAt: num(e.updatedAt, createdAt),
      touchedAt: num(e.touchedAt, num(e.updatedAt, createdAt)),
      doneAt: typeof e.doneAt === 'number' ? e.doneAt : null,
      ...(e.seed ? { seed: true } : {}),
    };
  }
  const links: Link[] = [];
  const seen = new Set<string>();
  for (const raw of (data.links ?? []) as Partial<Link>[]) {
    if (!raw || typeof raw.a !== 'string' || typeof raw.b !== 'string') continue;
    if (!entities[raw.a] || !entities[raw.b] || raw.a === raw.b) continue;
    const key = raw.a < raw.b ? `${raw.a}|${raw.b}` : `${raw.b}|${raw.a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const at = num(raw.createdAt, now);
    links.push({
      id: typeof raw.id === 'string' ? raw.id : uid(),
      a: raw.a,
      b: raw.b,
      createdAt: at,
      strength: Math.max(0.05, Math.min(1, num(raw.strength, 0.5))),
      usedAt: num(raw.usedAt, at),
      origin: raw.origin === 'capture' || raw.origin === 'mention' ? raw.origin : 'manuel',
    });
  }
  const kinds: KindRegistry = {};
  const natures: Nature[] = ['pensee', 'action', 'temps', 'monde'];
  if (data.kinds && typeof data.kinds === 'object') {
    for (const [k, v] of Object.entries(data.kinds as Record<string, { label?: string; nature?: string }>)) {
      if (v && typeof v.label === 'string' && natures.includes(v.nature as Nature)) kinds[kindKey(k)] = { label: v.label, nature: v.nature as Nature };
    }
  }
  // genres inventés présents dans les données mais absents du registre
  for (const e of Object.values(entities)) {
    if (e.kind && !builtinKind(e.kind) && !kinds[kindKey(e.kind)]) kinds[kindKey(e.kind)] = { label: e.kind, nature: 'pensee' };
  }
  return { entities, links, kinds };
}

/** Reconnaît un fichier exporté (V1 ou V2) et le convertit */
export function importPayload(json: unknown): V2Data {
  const j = json as { app?: string; version?: number; entities?: Record<string, unknown>; links?: unknown[]; kinds?: unknown };
  if (!j || typeof j !== 'object' || !j.entities) throw new Error('format');
  const sample = Object.values(j.entities)[0] as { type?: string; kind?: string } | undefined;
  const isV1 = (j.version ?? 1) < 2 || (!!sample && typeof sample.type === 'string' && sample.kind === undefined);
  return isV1 ? migrateV1(j) : sanitizeV2(j);
}
