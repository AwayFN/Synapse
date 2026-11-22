import type { Entity, Status, When } from '../types';
import { addDays, fromISODate, isValidISODate, minutesNow, parseTime, toISODate, todayISO } from './time';
import { norm, normalizeTag } from './text';
import { bareKind, builtinKind, RAW_WORDS, type KindDef } from './kinds';

/**
 * Capture universelle (français). Rien n'est obligatoire : une phrase brute devient une pensée.
 * Tout le reste est facultatif et peut se combiner :
 *   genre      « tâche … », « note … », « idée: … », « recette: … » (n'importe quel mot suivi de « : »)
 *   moment     « 7h02 », « 22h45 », « 12h01-17h38 », « de 9h à 11h », « demain », « lundi », « 24/12 »,
 *              « ce soir », « demain matin », « dans 2h », « dans 3 jours », « ce week-end »
 *   échéance   « avant vendredi », « deadline 30/12 », « pour le 3 mars »
 *   liens      « @Projet_App », « @"Voyage au Japon" », « [[Léa]] » (crée le neurone s'il n'existe pas)
 *   tags       « #idee »    importance « ! »    case à cocher « [ ] »
 * Les lignes suivantes (Maj+Entrée) deviennent le contenu.
 */
export interface Ref {
  raw: string;
  entity: Entity | null;
}

export type KindFrom = 'prefix' | 'colon' | 'checkbox' | 'question' | 'url';

export interface Parsed {
  kind: string;
  kindDef: KindDef | null;
  kindFrom: KindFrom | null;
  title: string;
  body: string;
  tags: string[];
  refs: Ref[];
  date: string | null;
  start: number | null;
  end: number | null;
  due: string | null;
  status: Status | null;
  pinned: boolean;
  private: boolean;
  url: string | null;
}

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['janv', 'fevr', 'mars', 'avr', 'mai', 'juin', 'juil', 'aout', 'sept', 'oct', 'nov', 'dec'];
const NOT_KINDS = new Set([
  'aujourdhui', 'auj', 'ajd', 'demain', 'hier', 'apres-demain', 'ce', 'cet', 'cette', 'dans', 'de', 'le', 'la', 'les',
  'un', 'une', 'et', 'ou', 'mais', 'donc', 'car', 'pour', 'avec', 'sans', 'avant', 'apres', 'a', 'au', 'aux', 'en',
  ...WEEKDAYS,
]);

/** « note de frais », « idée de cadeau », « projet de loi » : un nom composé, pas un genre en préfixe */
const COMPOUND = /^(?:de|du|des|d['’]|à|au|aux|en|pour|sur)(?:\s|$)/i;

/** Genre en tête de ligne : « tâche … », « idée: … », « recette : … » */
function detectKind(
  line: string,
  entities: Record<string, Entity>,
): { label: string; def: KindDef | null; rest: string; from: 'prefix' | 'colon' | 'raw' | 'ref'; ref?: Entity } | null {
  const m = line.match(/^\s*([\p{L}][\p{L}\p{N}'’-]*)(\s*:(?:\s+|$)|\s+|$)([\s\S]*)$/u);
  if (!m) return null;
  const word = m[1];
  const sep = m[2];
  const rest = m[3];
  const key = norm(word).replace(/['’]/g, '');
  const colon = sep.includes(':');
  if (RAW_WORDS.includes(key) && (colon || rest)) return { label: '', def: null, rest, from: 'raw' };
  if (colon) {
    const def = builtinKind(word);
    if (def) return { label: def.label, def, rest, from: 'colon' };
    // « Léa: rappeler pour le dîner » : le mot est le titre d'un neurone existant → c'est un lien, pas un genre
    const named = Object.values(entities).find((e) => norm(e.title) === norm(word));
    if (named) return { label: '', def: null, rest, from: 'ref', ref: named };
    if (/^[\p{L}][\p{L}'’-]{1,23}$/u.test(word) && !NOT_KINDS.has(key)) {
      return { label: word.toLowerCase(), def: null, rest, from: 'colon' };
    }
    return null;
  }
  const def = bareKind(word);
  if (!def) return null;
  // les raccourcis d'une lettre veulent un espace après (« t Faire… »), les mots entiers peuvent être seuls
  if (key.length === 1 && !sep) return null;
  if (COMPOUND.test(rest)) return null;
  return { label: def.label, def, rest, from: 'prefix' };
}

/** Meilleur neurone pour une référence @nom / [[nom]] */
export function resolveRef(raw: string, entities: Record<string, Entity>): Entity | null {
  const q = norm(raw);
  if (!q) return null;
  let best: Entity | null = null;
  let bestScore = 0;
  for (const e of Object.values(entities)) {
    const t = norm(e.title);
    if (!t) continue;
    const score = t === q ? 100 : t.startsWith(q) ? 70 : t.split(/\s+/).some((w) => w.startsWith(q)) ? 50 : q.length >= 3 && t.includes(q) ? 30 : 0;
    if (!score) continue;
    const bonus = (builtinKind(e.kind)?.hub ? 6 : 0) + (e.status === 'done' ? -4 : 0) + Math.min(4, (e.touchedAt - e.createdAt) / 8.64e7);
    if (score + bonus > bestScore) {
      bestScore = score + bonus;
      best = e;
    }
  }
  return best;
}

const TIME = String.raw`(?:\d{1,2}[h:]\d{0,2}|\d{1,2}\.\d{2}|midi|minuit)`;
const DUE_WORDS = String.raw`(?:deadline|avant\s+le|avant|pour\s+le|pour|d['’]ici(?:\s+le)?|au\s+plus\s+tard(?:\s+le)?|[ée]ch[ée]ance)`;
const DAY_PART: Record<string, number> = { matin: 9 * 60, midi: 12 * 60, apresmidi: 14 * 60, aprem: 14 * 60, soir: 19 * 60, nuit: 23 * 60 };

function resolveDateWord(w: string, today: string): string | null {
  const x = norm(w).replace(/['’]/g, '');
  if (x === 'aujourdhui' || x === 'auj' || x === 'ajd') return today;
  if (x === 'demain') return addDays(today, 1);
  if (x === 'apres-demain' || x === 'apresdemain') return addDays(today, 2);
  if (x === 'hier') return addDays(today, -1);
  const wd = WEEKDAYS.indexOf(x);
  if (wd >= 0) {
    const cur = fromISODate(today).getDay();
    return addDays(today, (wd - cur + 7) % 7);
  }
  return null;
}

function prettyUrl(u: string): string {
  try {
    const url = new URL(u);
    const path = url.pathname.replace(/\/$/, '');
    const s = `${url.hostname.replace(/^www\./, '')}${path}`;
    return s.length > 60 ? s.slice(0, 59) + '…' : s;
  } catch {
    return u;
  }
}

export function parseCapture(input: string, entities: Record<string, Entity>, opts?: { today?: string }): Parsed {
  const today = opts?.today ?? todayISO();
  const nl = input.indexOf('\n');
  let first = nl >= 0 ? input.slice(0, nl) : input;
  const body = nl >= 0 ? input.slice(nl + 1).replace(/^\s*\n/, '').trimEnd() : '';
  const out: Parsed = {
    kind: '', kindDef: null, kindFrom: null, title: '', body, tags: [], refs: [],
    date: null, start: null, end: null, due: null, status: null, pinned: false, private: false, url: null,
  };

  // ── genre
  let m: RegExpMatchArray | null;
  if ((m = first.match(/^\s*(?:[-*]\s*)?\[( |x|X)?\]\s*/))) {
    out.kindDef = builtinKind('tâche') ?? null;
    out.kind = out.kindDef?.label ?? 'tâche';
    out.kindFrom = 'checkbox';
    out.status = m[1] && m[1].toLowerCase() === 'x' ? 'done' : 'todo';
    first = first.slice(m[0].length);
  } else if ((m = first.match(/^\s*(?:à|a)\s+faire\s*:?\s+/i))) {
    out.kindDef = builtinKind('tâche') ?? null;
    out.kind = out.kindDef?.label ?? 'tâche';
    out.kindFrom = 'prefix';
    first = first.slice(m[0].length);
  } else {
    const k = detectKind(first, entities);
    if (k) {
      first = k.rest;
      if (k.from === 'ref' && k.ref) {
        out.refs.push({ raw: k.ref.title, entity: k.ref });
      } else if (k.from === 'prefix' || k.from === 'colon') {
        out.kind = k.label;
        out.kindDef = k.def;
        out.kindFrom = k.from;
      }
    }
  }

  let text = ` ${first} `;

  // ── liens : [[Titre]], @"Titre long", @Titre_court
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_m, raw: string) => {
    out.refs.push({ raw: raw.trim(), entity: resolveRef(raw, entities) });
    return ' ';
  });
  text = text.replace(/(^|\s)@(?:"([^"]+)"|(\S+))/g, (_m, pre: string, quoted: string | undefined, bare: string | undefined, offset: number, whole: string) => {
    const raw = (quoted ?? bare ?? '').replace(/_/g, ' ').replace(/[.,;:!?]+$/, '').trim();
    if (!raw) return pre;
    const entity = resolveRef(raw, entities);
    out.refs.push({ raw, entity });
    // « Déjeuner avec @Léa » : le nom fait partie de la phrase, il reste dans le titre
    const before = whole.slice(Math.max(0, offset - 8), offset + pre.length).toLowerCase();
    if (!whole.slice(0, offset).trim() || /(?:^|\s)(?:avec|chez|à|a|de|du|pour|et|sur|par|voir|appeler)\s*$|[ld]['’]\s*$/.test(before)) {
      return `${pre}${entity?.title || raw}`;
    }
    return pre;
  });

  // ── #tags
  text = text.replace(/(^|\s)#([\p{L}\p{N}_\-/]+)/gu, (_m, pre: string, tag: string) => {
    const t = normalizeTag(tag);
    if (t && !out.tags.includes(t)) out.tags.push(t);
    return pre;
  });

  // ── privé (jamais montré aux invités)
  text = text.replace(/(^|\s)(?:!priv[ée]e?|🔒)(?=\s|$)/giu, (_m, pre: string) => {
    out.private = true;
    return pre;
  });

  // ── importance
  text = text.replace(/(^|\s)(?:!{1,3}|!important|!urgent)(?=\s|$)/gi, (_m, pre: string) => {
    out.pinned = true;
    return pre;
  });

  // ── adresse web
  text = text.replace(/(https?:\/\/[^\s<>"]+)/i, (u: string) => {
    out.url = u.replace(/[.,;)]+$/, '');
    return ' ';
  });

  // ── « dans 2h », « dans 30 min », « dans 1h30 »
  text = text.replace(/(^|\s)dans\s+(\d{1,3})\s*(min|minutes?|h|heures?)\s*(\d{1,2})?(?=\s|$)/i, (mm, pre: string, n: string, unit: string, extra?: string) => {
    const delta = unit.toLowerCase().startsWith('h') ? Number(n) * 60 + (extra ? Number(extra) : 0) : Number(n);
    if (!delta || delta > 60 * 72) return mm;
    const at = new Date(Date.now() + delta * 60000);
    out.date = toISODate(at);
    out.start = at.getHours() * 60 + at.getMinutes();
    return pre;
  });

  // ── plage horaire : « 12h01-17h38 », « de 9h à 11h30 », « 22:47 → 23:12 »
  const range = new RegExp(String.raw`(^|\s)(?:de\s+)?(${TIME})\s*(?:-|–|—|→|->|>|à|a|jusqu'?à)\s*(${TIME})(?=\s|$)`, 'gi');
  text = text.replace(range, (mm, pre: string, a: string, b: string) => {
    if (out.start != null && out.end != null) return mm;
    const s = parseTime(a);
    const e = parseTime(b);
    if (s == null || e == null) return mm;
    out.start = s;
    out.end = e;
    return pre;
  });

  // ── heure seule : « 7h02 », « à 14h », « 17:45 » (mais pas une durée : « 2h de sport », « pendant 3h »)
  const single = new RegExp(String.raw`(^|\s)(?:à\s+|a\s+|vers\s+|dès\s+)?(${TIME})(?=\s|$)`, 'gi');
  text = text.replace(single, (mm, pre: string, a: string, offset: number, whole: string) => {
    if (out.start != null) return mm;
    const before = whole.slice(Math.max(0, offset - 14), offset + pre.length).toLowerCase();
    const after = whole.slice(offset + mm.length, offset + mm.length + 5).toLowerCase();
    if (/(pendant|durant|en|toutes les|tous les|chaque|environ)\s*$/.test(before)) return mm;
    if (/^\d{1,2}h$/i.test(a) && /^\s+de\s/.test(after)) return mm;
    const t = parseTime(a);
    if (t == null) return mm;
    out.start = t;
    return pre;
  });

  // ── « ce soir », « demain matin », « cet après-midi » (une heure écrite garde la priorité)
  text = text.replace(/(^|\s)(ce|cet|cette|demain)\s+(matin|midi|apr[eè]s-?midi|aprem|apr[eè]m|soir|nuit)(?=\s|$)/i, (mm, pre: string, w: string, part: string) => {
    const minutes = DAY_PART[norm(part).replace(/[-\s]/g, '')];
    if (minutes == null) return mm;
    out.date = norm(w) === 'demain' ? addDays(today, 1) : today;
    if (out.start == null) out.start = minutes;
    return pre;
  });

  // ── dates relatives longues
  text = text.replace(/(^|\s)dans\s+(\d{1,3})\s+(jours?|semaines?|mois)(?=\s|$)/i, (mm, pre: string, n: string, unit: string) => {
    const k = Number(n);
    const u = norm(unit);
    if (u.startsWith('jour')) out.date = addDays(today, k);
    else if (u.startsWith('semaine')) out.date = addDays(today, k * 7);
    else {
      const d = fromISODate(today);
      d.setMonth(d.getMonth() + k);
      out.date = toISODate(d);
    }
    return pre;
  });
  text = text.replace(/(^|\s)(?:la\s+)?semaine\s+prochaine(?=\s|$)/i, (_mm, pre: string) => {
    const cur = fromISODate(today).getDay();
    out.date = addDays(today, ((8 - cur) % 7) || 7);
    return pre;
  });
  text = text.replace(/(^|\s)ce\s+week-?end(?=\s|$)/i, (_mm, pre: string) => {
    const cur = fromISODate(today).getDay();
    out.date = cur === 6 || cur === 0 ? today : addDays(today, 6 - cur);
    return pre;
  });

  // ── dates : mot, ISO, 24/12, « 24 décembre » — précédées d'« avant / deadline / pour » = échéance
  const setDate = (d: string, prefix?: string) => {
    if (prefix && new RegExp(`^${DUE_WORDS}$`, 'i').test(prefix.trim())) out.due = d;
    else out.date = d;
  };
  const dateWords = new RegExp(
    String.raw`(^|\s)(?:(${DUE_WORDS}|le|du)\s+)?(aujourd['’]?hui|auj|ajd|demain|apr[eè]s-?demain|hier|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(?:\s+prochain)?(?=\s|$)`,
    'i',
  );
  text = text.replace(dateWords, (mm, pre: string, prefix: string | undefined, w: string) => {
    const d = resolveDateWord(w, today);
    if (!d) return mm;
    setDate(d, prefix);
    return pre;
  });
  const iso = new RegExp(String.raw`(^|\s)(?:(${DUE_WORDS}|le|du)\s+)?(\d{4}-\d{2}-\d{2})(?=\s|$)`, 'i');
  text = text.replace(iso, (mm, pre: string, prefix: string | undefined, d: string) => {
    if (!isValidISODate(d)) return mm;
    setDate(d, prefix);
    return pre;
  });
  const dm = new RegExp(String.raw`(^|\s)(?:(${DUE_WORDS}|le|du)\s+)?(\d{1,2})[/](\d{1,2})(?:[/](\d{2,4}))?(?=\s|$)`, 'i');
  text = text.replace(dm, (mm, pre: string, prefix: string | undefined, dd: string, mo: string, yy?: string) => {
    const now = fromISODate(today);
    let y = yy ? Number(yy.length === 2 ? `20${yy}` : yy) : now.getFullYear();
    let d = new Date(y, Number(mo) - 1, Number(dd));
    if (d.getMonth() !== Number(mo) - 1) return mm;
    if (!yy && d.getTime() < now.getTime() - 30 * 86400000) {
      y += 1;
      d = new Date(y, Number(mo) - 1, Number(dd));
    }
    setDate(toISODate(d), prefix);
    return pre;
  });
  const named = new RegExp(String.raw`(^|\s)(?:(${DUE_WORDS}|le|du)\s+)?(\d{1,2})\s+([a-zéû]+)\.?(?=\s|$)`, 'i');
  text = text.replace(named, (mm, pre: string, prefix: string | undefined, dd: string, mon: string) => {
    const k = norm(mon).slice(0, 4);
    if (k.length < 3) return mm;
    const mi = MONTHS.findIndex((x) => x.startsWith(k) || k.startsWith(x));
    if (mi < 0) return mm;
    const now = fromISODate(today);
    let d = new Date(now.getFullYear(), mi, Number(dd));
    if (d.getTime() < now.getTime() - 30 * 86400000) d = new Date(now.getFullYear() + 1, mi, Number(dd));
    setDate(toISODate(d), prefix);
    return pre;
  });

  // mots de liaison restés orphelins en fin de phrase (« … deadline », « … pour le »)
  text = text.replace(/(\s)(?:deadline|pour le|avant le|pour|avant|[ée]ch[ée]ance)\s*$/i, '$1');
  let title = text.replace(/\s+/g, ' ').replace(/^[\s:–—-]+|[\s:–—-]+$/g, '').trim();
  const urlOnly = !title && !!out.url;
  if (urlOnly) title = prettyUrl(out.url!);
  else if (title) title = title[0].toUpperCase() + title.slice(1);
  out.title = title;

  // ── le système structure un peu tout seul (jamais bloquant)
  if (!out.kind && /\?\s*$/.test(title)) {
    out.kindDef = builtinKind('question') ?? null;
    out.kind = 'question';
    out.kindFrom = 'question';
  }
  if (!out.kind && urlOnly) {
    out.kindDef = builtinKind('lien') ?? null;
    out.kind = 'lien';
    out.kindFrom = 'url';
  }
  if (!out.status && out.kindDef?.status) out.status = out.kindDef.hub ? 'doing' : 'todo';
  if (out.kindDef?.slot) {
    if (out.start == null) {
      out.start = Math.min(1435, Math.ceil(minutesNow() / 5) * 5);
      if (!out.date) out.date = today;
    }
    if (out.end == null) out.end = (out.start + 60) % 1440;
  }
  return out;
}

export function whenOf(p: Parsed, today = todayISO()): When | null {
  if (!p.date && p.start == null) return null;
  return { date: p.date ?? today, start: p.start, end: p.start == null ? null : p.end };
}

/** Champs du neurone à créer (les références sont traitées à part) */
export function captureFields(p: Parsed, today = todayISO()): Partial<Entity> {
  let body = p.body;
  if (p.url && !body.includes(p.url)) body = body ? `${p.url}\n\n${body}` : p.url;
  return {
    title: p.title,
    body,
    kind: p.kind,
    tags: p.tags,
    status: p.status,
    when: whenOf(p, today),
    due: p.due,
    pinned: p.pinned,
    ...(p.private ? { private: true } : {}),
  };
}

/** Le texte contient-il autre chose que du texte brut ? (pour l'aperçu) */
export function hasStructure(p: Parsed): boolean {
  return !!(p.kind || p.tags.length || p.refs.length || p.date || p.start != null || p.due || p.pinned || p.private || p.url || p.body);
}

/** [[mentions]] d'un contenu → titres référencés */
export function mentionsIn(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\[\[([^\]\n]{1,120})\]\]/g)) {
    const t = m[1].trim();
    if (t && !out.some((x) => norm(x) === norm(t))) out.push(t);
  }
  return out;
}
