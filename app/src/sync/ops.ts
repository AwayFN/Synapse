import type { Activity, Entity, Link } from '../types';
import { useData, type DataState } from '../store/data';
import { fx } from '../store/fx';
import { can } from './perm';

/**
 * Les changements échangés avec le serveur. Chaque modification locale du cerveau est comparée à l'état
 * précédent et traduite en petites opérations (au champ près : deux personnes qui modifient des champs
 * différents d'un même élément ne s'écrasent pas).
 */
type Fields = Record<string, unknown>;
export type Op =
  | { t: 'put'; e: Entity }
  | { t: 'patch'; id: string; f: Fields }
  | { t: 'del'; id: string }
  | { t: 'link'; l: Link }
  | { t: 'unlink'; id: string }
  | { t: 'act'; a: Activity };

let applying = false;
export const isApplyingRemote = () => applying;

function same(a: unknown, b: unknown) {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function changed(a: Fields, b: Fields): Fields {
  const out: Fields = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!same(a[k], b[k])) out[k] = b[k] === undefined ? null : b[k];
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
        const f = changed(a as unknown as Fields, b as unknown as Fields);
        if (Object.keys(f).length) ops.push({ t: 'patch', id, f });
      }
    }
    for (const id in prev.entities) if (!next.entities[id]) ops.push({ t: 'del', id });
  }
  if (prev.links !== next.links) {
    const pm = new Map(prev.links.map((l) => [l.id, l]));
    const nm = new Map(next.links.map((l) => [l.id, l]));
    for (const [id, l] of nm) if (!pm.has(id)) ops.push({ t: 'link', l });
    for (const id of pm.keys()) if (!nm.has(id)) ops.push({ t: 'unlink', id });
  }
  if (prev.activity !== next.activity) {
    const seen = new Set(prev.activity.map((a) => a.id));
    for (const a of [...next.activity].reverse()) if (!seen.has(a.id)) ops.push({ t: 'act', a });
  }
  return ops;
}

/** « Peut regarder » : rien ne part (ce qui bouge chez lui reste un effet local, sans conséquence) */
export function allowed(ops: Op[]): Op[] {
  return can.write() ? ops : [];
}

/** Regroupe les petites modifications successives d'un même élément (frappe au clavier) */
export function compact(ops: Op[]): Op[] {
  const out: Op[] = [];
  const lastPatch = new Map<string, number>();
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
        const next: Fields = { ...cur, ...op.f };
        for (const k of Object.keys(op.f)) if (op.f[k] === null && (k === 'private' || k === 'seed')) delete next[k];
        E()[op.id] = next as unknown as Entity;
        if (opts.fx) {
          const was = (cur as unknown as Fields).status;
          if (op.f.status === 'done' && was !== 'done') after.push(() => fx.emit({ kind: 'celebrate', id: op.id }));
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
      case 'unlink': {
        if (!links.some((x) => x.id === op.id)) break;
        links = links.filter((x) => x.id !== op.id);
        lCopy = true;
        break;
      }
      case 'act':
        if (!activity.some((a) => a.id === op.a.id)) activity = [op.a, ...activity].slice(0, 60);
        break;
    }
  }
  if (opts.fx) {
    for (const id of born) {
      const e = entities[id] as unknown as Fields;
      const parent = typeof e.projectId === 'string' ? e.projectId : null;
      const l = links.find((x) => x.a === id || x.b === id);
      fx.emit({ kind: 'birth', id, near: parent ?? (l ? (l.a === id ? l.b : l.a) : null) });
    }
  }
  applying = true;
  try {
    useData.setState({ entities, links, activity });
  } finally {
    applying = false;
  }
  for (const f of after) f();
}

/** Remplace tout le contenu (état complet reçu du serveur) */
export function applySnapshot(snap: { entities: Record<string, Entity>; links: Link[]; activity: Activity[] }) {
  applying = true;
  try {
    useData.setState({ entities: snap.entities, links: snap.links, activity: snap.activity });
  } finally {
    applying = false;
  }
}
