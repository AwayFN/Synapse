import type { Entity } from '../types';
import { kindLabel } from './kinds';
import { vitality } from './entity';
import { norm } from './text';

/**
 * Recherche instantanée : chaque mot doit se retrouver quelque part (titre, genre, tags, contenu).
 * Pas de dossiers dans Synapse, donc la recherche doit retrouver une idée même sans savoir « où » elle est.
 */
interface Doc {
  e: Entity;
  title: string;
  words: string[];
  kind: string;
  tags: string[];
  body: string;
}

let cache: { ents: Record<string, Entity> | null; docs: Doc[] } = { ents: null, docs: [] };

function docsFor(ents: Record<string, Entity>): Doc[] {
  if (cache.ents === ents) return cache.docs;
  const docs: Doc[] = [];
  for (const e of Object.values(ents)) {
    const title = norm(e.title || e.body.split('\n')[0] || '');
    docs.push({
      e,
      title,
      words: title.split(/[\s\-_/:·,.;!?'’()«»"]+/).filter(Boolean),
      kind: norm(kindLabel(e.kind)),
      tags: e.tags,
      body: norm(e.body.slice(0, 4000)),
    });
  }
  cache = { ents, docs };
  return docs;
}

export interface Hit {
  e: Entity;
  score: number;
  /** extrait du contenu autour du mot trouvé */
  snippet: string | null;
}

function subsequence(q: string, t: string): boolean {
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

export function searchEntities(ents: Record<string, Entity>, query: string, limit = 24): Hit[] {
  const raw = query.trim();
  if (!raw) return [];
  const tokens = norm(raw).split(/\s+/).filter(Boolean);
  const tagTokens = tokens.filter((t) => t.startsWith('#') && t.length > 1).map((t) => t.slice(1));
  const words = tokens.filter((t) => !t.startsWith('#'));
  const now = Date.now();
  const out: Hit[] = [];
  for (const d of docsFor(ents)) {
    if (tagTokens.length && !tagTokens.every((t) => d.tags.some((x) => x.startsWith(t)))) continue;
    let score = tagTokens.length ? 6 : 0;
    let bodyAt = -1;
    let bodyLen = 0;
    let ok = true;
    for (const t of words) {
      let s = 0;
      if (d.words.includes(t)) s = 14;
      else if (d.words.some((w) => w.startsWith(t))) s = 10;
      else if (t.length >= 2 && d.title.includes(t)) s = 6;
      if (d.tags.some((x) => x === t)) s = Math.max(s, 9);
      else if (d.tags.some((x) => x.startsWith(t))) s = Math.max(s, 7);
      if (d.kind.startsWith(t)) s = Math.max(s, 5);
      if (!s && t.length >= 2) {
        let i = d.body.indexOf(' ' + t);
        if (i < 0 && d.body.startsWith(t)) i = 0;
        else if (i >= 0) i += 1;
        if (i >= 0) {
          s = 3;
          if (bodyAt < 0) {
            bodyAt = i;
            bodyLen = t.length;
          }
        } else if (t.length >= 3) {
          const j = d.body.indexOf(t);
          if (j >= 0) {
            s = 1.5;
            if (bodyAt < 0) {
              bodyAt = j;
              bodyLen = t.length;
            }
          }
        }
      }
      if (!s) {
        ok = false;
        break;
      }
      score += s;
    }
    if (!ok) {
      // dernier recours : lettres dans l'ordre (« prjapp » → « Projet App »)
      const q = words.join('');
      if (words.length === 1 && q.length >= 3 && subsequence(q, d.title.replace(/\s+/g, ''))) score = 1;
      else continue;
    }
    if (!words.length && !tagTokens.length) continue;
    score += vitality(d.e, now) * 2 + (d.e.pinned ? 1 : 0);
    let snippet: string | null = null;
    if (bodyAt >= 0) {
      const src = d.e.body;
      const a = Math.max(0, bodyAt - 40);
      const b = Math.min(src.length, bodyAt + bodyLen + 70);
      snippet = `${a > 0 ? '…' : ''}${src.slice(a, b).replace(/\s+/g, ' ').trim()}${b < src.length ? '…' : ''}`;
    }
    out.push({ e: d.e, score, snippet });
  }
  out.sort((x, y) => y.score - x.score || y.e.touchedAt - x.e.touchedAt);
  return out.slice(0, limit);
}

/** Identifiants de tous les résultats (pour les éclairer dans le réseau) */
export function searchIds(ents: Record<string, Entity>, query: string): Set<string> {
  return new Set(searchEntities(ents, query, 400).map((h) => h.e.id));
}
