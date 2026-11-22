import type { Activity, Entity, Link } from '../types';
import type { KindRegistry } from '../lib/kinds';
import { useData, type DataState } from '../store/data';
import { fx } from '../store/fx';
import { can } from './perm';

/**
 * Les changements échangés avec le serveur. Chaque modification locale du cerveau est comparée à l'état
 * précédent et traduite en petites opérations (au champ près : deux personnes qui modifient des champs
 * différents d'un même neurone ne s'écrasent pas).
 */
export type Op =
  | { t: 'put'; e: Entity }
  | { t: 'patch'; id: string; f: Partial<Entity> }
  | { t: 'del'; id: string }
  | { t: 'link'; l: Link }
  | { t: 'linkPatch'; id: string; f: Partial<Link> }
  | { t: 'unlink'; id: string }
  | { t: 'kind'; k: string; v: KindRegistry[string] }
  | { t: 'act'; a: Activity };

let applying = false;
export const isApplyingRemote = () => applying;

function same(a: unknown, b: unknown) {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function changed<T extends object>(a: T, b: T): Partial<T> {
  const out: Partial<T> = {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof T>;
  for (const k of keys) if (!same(a[k], b[k])) out[k] = b[k] === undefined ? (null as T[keyof T]) : b[k];
  return out;
}

/** Ce qui a changé entre deux états du cerveau */
export function diff(prev: DataState, next: DataState): Op[] {
  const ops: Op[] = [];
  if (prev.entities !== next.entities) {
    for (const id in next.entities) {
      const a = prev.entities[id];
      const b = next.entities[id];
      if (!a) ops.push({ t: 'put', e: b });
      else if (a !== b) {
        const f = changed(a, b);
        if (Object.keys(f).length) ops.push({ t: 'patch', id, f });
      }
    }
    for (const id in prev.entities) if (!next.entities[id]) ops.push({ t: 'del', id });
  }
  if (prev.links !== next.links) {
    const pm = new Map(prev.links.map((l) => [l.id, l]));
    const nm = new Map(next.links.map((l) => [l.id, l]));
    for (const [id, l] of nm) {
      const o = pm.get(id);
      if (!o) ops.push({ t: 'link', l });
      else if (o !== l) {
        const f = changed(o, l);
        if (Object.keys(f).length) ops.push({ t: 'linkPatch', id, f });
      }
    }
    for (const id of pm.keys()) if (!nm.has(id)) ops.push({ t: 'unlink', id });
  }
  if (prev.kinds !== next.kinds) {
    for (const k in next.kinds) if (!same(prev.kinds[k], next.kinds[k])) ops.push({ t: 'kind', k, v: next.kinds[k] });
  }
  if (prev.activity !== next.activity) {
    const seen = new Set(prev.activity.map((a) => a.id));
    for (const a of [...next.activity].reverse()) if (!seen.has(a.id)) ops.push({ t: 'act', a });
  }
  return ops;
}

/**
 * Ne garde que ce que mes droits permettent d'envoyer. Le reste (par exemple la « date de dernière visite »
 * d'un neurone que je ne peux pas modifier) reste un effet local, sans conséquence pour les autres.
 */
export function allowed(ops: Op[], prev: DataState): Op[] {
  if (!can.write()) return [];
  const editAll = can.editAll();
  return ops.filter((op) => {
    switch (op.t) {
      case 'put':
        return true;
      case 'patch':
        return can.edit(prev.entities[op.id] ?? useData.getState().entities[op.id]);
      case 'del':
        return can.edit(prev.entities[op.id]);
      case 'link':
        return true;
      case 'linkPatch':
        return editAll;
      case 'unlink':
        return can.unlink(prev.links.find((l) => l.id === op.id));
      case 'kind':
        return editAll || (!prev.kinds[op.k] && op.v?.nature === 'pensee');
      case 'act':
        return true;
    }
    return false;
  });
}

/** Regroupe les petites modifications successives d'un même neurone (frappe au clavier) */
export function compact(ops: Op[]): Op[] {
  const out: Op[] = [];
  const lastPatch = new Map<string, number>();
  const lastLinkPatch = new Map<string, number>();
  for (const op of ops) {
    if (op.t === 'patch') {
      const i = lastPatch.get(op.id);
      if (i !== undefined) {
        const prev = out[i] as Extract<Op, { t: 'patch' }>;
        out[i] = { t: 'patch', id: op.id, f: { ...prev.f, ...op.f } };
        continue;
      }
      lastPatch.set(op.id, out.length);
    } else if (op.t === 'put' || op.t === 'del') {
      lastPatch.delete(op.t === 'put' ? op.e.id : op.id);
    } else if (op.t === 'linkPatch') {
      const i = lastLinkPatch.get(op.id);
      if (i !== undefined) {
        const prev = out[i] as Extract<Op, { t: 'linkPatch' }>;
        out[i] = { t: 'linkPatch', id: op.id, f: { ...prev.f, ...op.f } };
        continue;
      }
      lastLinkPatch.set(op.id, out.length);
    }
    out.push(op);
  }
  return out;
}

/** Applique des changements venus du serveur (sans les renvoyer), avec leurs effets visuels */
export function applyRemote(ops: Op[], opts: { fx?: boolean } = {}) {
  if (!ops.length) return;
  const s = useData.getState();
  let entities = s.entities;
  let links = s.links;
  let kinds = s.kinds;
  let activity = s.activity;
  let eCopy = false;
  let lCopy = false;
  const E = () => {
    if (!eCopy) {
      entities = { ...entities };
      eCopy = true;
    }
    return entities;
  };
  const L = () => {
    if (!lCopy) {
      links = [...links];
      lCopy = true;
    }
    return links;
  };
  const after: (() => void)[] = [];
  const born: string[] = [];
  for (const op of ops) {
    switch (op.t) {
      case 'put': {
        const existed = !!entities[op.e.id];
        E()[op.e.id] = op.e;
        if (!existed) born.push(op.e.id);
        break;
      }
      case 'patch': {
        const cur = entities[op.id];
        if (!cur) break;
        const next = { ...cur, ...op.f } as Entity;
        for (const k of Object.keys(op.f) as (keyof Entity)[]) if (op.f[k] === null && (k === 'private' || k === 'seed')) delete next[k];
        E()[op.id] = next;
        if (opts.fx) {
          if (op.f.status === 'done' && cur.status !== 'done') after.push(() => fx.emit({ kind: 'celebrate', id: op.id }));
          else after.push(() => fx.emit({ kind: 'touch', id: op.id }));
        }
        break;
      }
      case 'del': {
        if (!entities[op.id]) break;
        if (opts.fx) fx.emit({ kind: 'death', id: op.id });
        delete E()[op.id];
        if (links.some((l) => l.a === op.id || l.b === op.id)) {
          // filter() crée un nouveau tableau : on peut ensuite le modifier sans toucher à l'ancien
          links = links.filter((l) => l.a !== op.id && l.b !== op.id);
          lCopy = true;
        }
        break;
      }
      case 'link': {
        const l = op.l;
        if (links.some((x) => x.id === l.id || (x.a === l.a && x.b === l.b) || (x.a === l.b && x.b === l.a))) break;
        L().push(l);
        if (opts.fx) after.push(() => fx.emit({ kind: 'link', a: l.a, b: l.b }));
        break;
      }
      case 'linkPatch': {
        const i = links.findIndex((x) => x.id === op.id);
        if (i < 0) break;
        L()[i] = { ...links[i], ...op.f } as Link;
        break;
      }
      case 'unlink': {
        if (!links.some((x) => x.id === op.id)) break;
        links = links.filter((x) => x.id !== op.id);
        lCopy = true;
        break;
      }
      case 'kind':
        kinds = { ...kinds, [op.k]: op.v };
        break;
      case 'act':
        if (!activity.some((a) => a.id === op.a.id)) activity = [op.a, ...activity].slice(0, 60);
        break;
    }
  }
  if (opts.fx) {
    for (const id of born) {
      const near = links.find((l) => l.a === id || l.b === id);
      fx.emit({ kind: 'birth', id, near: near ? (near.a === id ? near.b : near.a) : null });
    }
  }
  applying = true;
  try {
    useData.setState({ entities, links, kinds, activity });
  } finally {
    applying = false;
  }
  for (const f of after) f();
}

/** Remplace tout le contenu (état complet reçu du serveur) */
export function applySnapshot(snap: { entities: Record<string, Entity>; links: Link[]; kinds: KindRegistry; activity: Activity[] }) {
  applying = true;
  try {
    useData.setState({ entities: snap.entities, links: snap.links, kinds: snap.kinds, activity: snap.activity });
  } finally {
    applying = false;
  }
}
