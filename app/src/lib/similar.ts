import type { Entity, Link } from '../types';
import { adjacency } from '../store/graph';
import { kindLabel } from './kinds';
import { norm } from './text';

/**
 * « Connexions possibles » : Synapse propose des liens comme le ferait une association d'idées —
 * mots rares partagés (TF-IDF), mêmes tags, capturées dans le même élan, amis communs.
 * Tout est calculé localement, rien ne quitte l'ordinateur.
 */
const STOP = new Set(
  (
    'avec dans pour sans sous chez vers entre apres avant depuis pendant comme aussi tres bien plus moins encore deja alors ' +
    'quand comment pourquoi parce donc mais leur leurs nous vous elles elle ils cette ceux celle celui cela ceci quel quelle ' +
    'quels quelles chaque autre autres meme memes dont tout tous toute toutes rien personne fait faire faut peut peux doit ' +
    'dois sont etre avoir etait sera serait seront avait avaient suis sommes etes fois jour jours semaine mois annee ' +
    'notre votre notes note idee tache projet creneau question cette celles ceux voila juste vraiment toujours jamais ' +
    'beaucoup peu trop assez plutot ensuite enfin puis demain hier aujourdhui matin soir midi minuit lundi mardi mercredi ' +
    'jeudi vendredi samedi dimanche penser pense avoir about that this with from have will what when your'
  ).split(' '),
);

function stem(w: string): string {
  if (w.length > 5 && (w.endsWith('s') || w.endsWith('x'))) w = w.slice(0, -1);
  if (w.length > 6 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

function terms(e: Entity): string[] {
  const text = `${e.title} ${e.title} ${e.body.slice(0, 3000)} ${kindLabel(e.kind)}`;
  return norm(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

interface Index {
  ents: Record<string, Entity>;
  builtAt: number;
  vec: Map<string, Map<string, number>>;
  norms: Map<string, number>;
  inv: Map<string, string[]>;
}

let index: Index | null = null;

function getIndex(ents: Record<string, Entity>): Index {
  const now = performance.now();
  // l'index est recalculé au plus toutes les 1,5 s (la frappe modifie les données à chaque touche)
  if (index && (index.ents === ents || now - index.builtAt < 1500)) return index;
  const tf = new Map<string, Map<string, number>>();
  const df = new Map<string, number>();
  for (const e of Object.values(ents)) {
    const m = new Map<string, number>();
    for (const t of terms(e)) m.set(t, (m.get(t) ?? 0) + 1);
    tf.set(e.id, m);
    for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = Math.max(1, tf.size);
  const vec = new Map<string, Map<string, number>>();
  const norms = new Map<string, number>();
  const inv = new Map<string, string[]>();
  for (const [id, m] of tf) {
    const v = new Map<string, number>();
    let n2 = 0;
    for (const [t, c] of m) {
      const d = df.get(t) ?? 1;
      if (d > N * 0.35 && N > 12) continue; // trop courant pour dire quelque chose
      const w = (1 + Math.log(c)) * Math.log(1 + N / d);
      v.set(t, w);
      n2 += w * w;
      if (!inv.has(t)) inv.set(t, []);
      inv.get(t)!.push(id);
    }
    vec.set(id, v);
    norms.set(id, Math.sqrt(n2) || 1);
  }
  index = { ents, builtAt: now, vec, norms, inv };
  return index;
}

export interface Suggestion {
  e: Entity;
  score: number;
  reasons: string[];
}

export function suggestionsFor(ents: Record<string, Entity>, links: Link[], id: string, k = 4, min = 0.14): Suggestion[] {
  const self = ents[id];
  if (!self) return [];
  const ix = getIndex(ents);
  const adj = adjacency(links);
  const linked = new Set((adj.get(id) ?? []).map((x) => x.other));
  const v = ix.vec.get(id) ?? new Map<string, number>();
  const nSelf = ix.norms.get(id) ?? 1;
  const cands = new Set<string>();
  for (const t of v.keys()) for (const other of ix.inv.get(t) ?? []) cands.add(other);
  for (const e of Object.values(ents)) {
    if (Math.abs(e.createdAt - self.createdAt) < 45 * 60000) cands.add(e.id);
    else if (self.tags.length && e.tags.some((t) => self.tags.includes(t))) cands.add(e.id);
  }
  for (const n of adj.get(id) ?? []) for (const n2 of adj.get(n.other) ?? []) cands.add(n2.other);
  cands.delete(id);

  const out: Suggestion[] = [];
  for (const cid of cands) {
    if (linked.has(cid)) continue;
    const c = ents[cid];
    if (!c) continue;
    const cv = ix.vec.get(cid);
    let dot = 0;
    const shared: [string, number][] = [];
    if (cv) {
      for (const [t, w] of v) {
        const w2 = cv.get(t);
        if (w2) {
          dot += w * w2;
          shared.push([t, w * w2]);
        }
      }
    }
    const cos = dot / (nSelf * (ix.norms.get(cid) ?? 1));
    const tags = c.tags.filter((t) => self.tags.includes(t));
    const close = Math.abs(c.createdAt - self.createdAt) < 45 * 60000;
    const common = (adj.get(cid) ?? []).filter((x) => linked.has(x.other));
    const score = cos + 0.22 * Math.min(2, tags.length) + (close ? 0.12 : 0) + 0.07 * Math.min(3, common.length);
    if (score < min) continue;
    const reasons: string[] = [];
    if (shared.length && cos > 0.05) {
      shared.sort((a, b) => b[1] - a[1]);
      reasons.push(`mots communs : ${shared.slice(0, 3).map((s) => s[0]).join(', ')}`);
    }
    if (tags.length) reasons.push(tags.map((t) => `#${t}`).join(' '));
    if (close) reasons.push('capturées dans le même élan');
    if (common.length) {
      const via = ents[common[0].other];
      if (via) reasons.push(`relié${common.length > 1 ? 's' : ''} à « ${via.title || 'Sans titre'} »${common.length > 1 ? ` +${common.length - 1}` : ''}`);
    }
    out.push({ e: c, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k);
}
