import type { Entity, EntityType } from '../types';
import { addDays, fromISODate, isValidISODate, parseTime, toISODate, todayISO } from './time';
import { norm, normalizeTag } from './text';

/**
 * Spotlight-style command parser (French):
 *   "tâche Finir la maquette @App demain 14h"
 *   "créneau 12h01-17h38 Deep work @Projet_App"
 *   "note Idée startup #idee #business"
 *   "projet Site vitrine deadline 30/12"
 */
export interface Parsed {
  type: EntityType | null;
  title: string;
  date: string | null;
  time: number | null;
  start: number | null;
  end: number | null;
  tags: string[];
  refs: { raw: string; entity: Entity | null }[];
}

const TYPE_WORDS: Record<string, EntityType> = {
  note: 'note',
  n: 'note',
  tache: 'task',
  task: 'task',
  t: 'task',
  todo: 'task',
  projet: 'project',
  project: 'project',
  p: 'project',
  creneau: 'slot',
  slot: 'slot',
  c: 'slot',
  rdv: 'slot',
};

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['janv', 'fevr', 'mars', 'avr', 'mai', 'juin', 'juil', 'aout', 'sept', 'oct', 'nov', 'dec'];

/** Returns the matched type keyword and the rest of the input */
export function detectType(input: string): { type: EntityType | null; rest: string } {
  const m = input.match(/^\s*(\S+)(\s+|$)([\s\S]*)$/);
  if (!m) return { type: null, rest: input };
  const word = norm(m[1]).replace(/[:]$/, '');
  const type = TYPE_WORDS[word] ?? null;
  // single-letter shortcuts need a following space ("t Faire…"), full words may stand alone
  if (!type || (word.length === 1 && !m[2])) return { type: null, rest: input };
  return { type, rest: m[3] };
}

const TIME = String.raw`(?:\d{1,2}[h:.]\d{0,2}|\d{1,2}h|midi|minuit)`;

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

export function parseCommand(input: string, entities: Record<string, Entity>): Parsed {
  const today = todayISO();
  const { type, rest } = detectType(input);
  let text = ` ${rest} `;
  const out: Parsed = { type, title: '', date: null, time: null, start: null, end: null, tags: [], refs: [] };

  // @mentions → links (or parent project for a task)
  text = text.replace(/(^|\s)@(?:"([^"]+)"|(\S+))/g, (_m, pre: string, quoted?: string, bare?: string) => {
    const raw = (quoted ?? bare ?? '').replace(/[_]/g, ' ');
    const q = norm(raw);
    let best: Entity | null = null;
    let bestScore = 0;
    for (const e of Object.values(entities)) {
      const t = norm(e.title);
      if (!t) continue;
      const score = t === q ? 100 : t.startsWith(q) ? 70 : t.split(/\s+/).some((w) => w.startsWith(q)) ? 50 : t.includes(q) ? 30 : 0;
      const bonus = e.type === 'project' ? 5 : 0;
      if (score && score + bonus > bestScore) {
        bestScore = score + bonus;
        best = e;
      }
    }
    out.refs.push({ raw, entity: best });
    return pre;
  });

  // #tags
  text = text.replace(/(^|\s)#([\p{L}\p{N}_\-/]+)/gu, (_m, pre: string, tag: string) => {
    const t = normalizeTag(tag);
    if (t && !out.tags.includes(t)) out.tags.push(t);
    return pre;
  });

  // time range: "12h01-17h38", "de 9h à 11h30", "22:47 → 23:12"
  const range = new RegExp(String.raw`(^|\s)(?:de\s+)?(${TIME})\s*(?:-|–|—|→|->|>|à|a|jusqu'?à)\s*(${TIME})(?=\s|$)`, 'gi');
  text = text.replace(range, (m, pre: string, a: string, b: string) => {
    if (out.start != null) return m;
    const s = parseTime(a);
    const e = parseTime(b);
    if (s == null || e == null) return m;
    out.start = s;
    out.end = e;
    return pre;
  });

  // single time: "14h", "à 9h30", "17:45"
  const single = new RegExp(String.raw`(^|\s)(?:à\s+|a\s+|vers\s+)?(${TIME})(?=\s|$)`, 'gi');
  text = text.replace(single, (m, pre: string, a: string) => {
    if (out.time != null) return m;
    const t = parseTime(a);
    if (t == null) return m;
    out.time = t;
    return pre;
  });

  // dates
  const dateWords = /(^|\s)(?:(?:deadline|pour|avant|le|du|pour le|avant le)\s+)?(aujourd['’]?hui|auj|ajd|demain|apr[eè]s-?demain|hier|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)(?:\s+prochain)?(?=\s|$)/i;
  text = text.replace(dateWords, (m, pre: string, w: string) => {
    const d = resolveDateWord(w, today);
    if (!d) return m;
    out.date = d;
    return pre;
  });
  if (!out.date) {
    const iso = /(^|\s)(?:(?:deadline|pour|avant|le)\s+)?(\d{4}-\d{2}-\d{2})(?=\s|$)/i;
    text = text.replace(iso, (m, pre: string, d: string) => {
      if (!isValidISODate(d)) return m;
      out.date = d;
      return pre;
    });
  }
  if (!out.date) {
    const dm = /(^|\s)(?:(?:deadline|pour|avant|le)\s+)?(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?(?=\s|$)/i;
    text = text.replace(dm, (m, pre: string, dd: string, mm: string, yy?: string) => {
      const now = fromISODate(today);
      let y = yy ? Number(yy.length === 2 ? `20${yy}` : yy) : now.getFullYear();
      let d = new Date(y, Number(mm) - 1, Number(dd));
      if (d.getMonth() !== Number(mm) - 1) return m;
      if (!yy && d.getTime() < now.getTime() - 30 * 86400000) {
        y += 1;
        d = new Date(y, Number(mm) - 1, Number(dd));
      }
      out.date = toISODate(d);
      return pre;
    });
  }
  if (!out.date) {
    const named = /(^|\s)(?:(?:deadline|pour|avant|le)\s+)?(\d{1,2})\s+([a-zéû]+)\.?(?=\s|$)/i;
    text = text.replace(named, (m, pre: string, dd: string, mon: string) => {
      const k = norm(mon).slice(0, 4);
      if (k.length < 3) return m;
      const mi = MONTHS.findIndex((x) => x.startsWith(k) || k.startsWith(x));
      if (mi < 0) return m;
      const now = fromISODate(today);
      let d = new Date(now.getFullYear(), mi, Number(dd));
      if (d.getTime() < now.getTime() - 30 * 86400000) d = new Date(now.getFullYear() + 1, mi, Number(dd));
      out.date = toISODate(d);
      return pre;
    });
  }

  // leftover connector words
  text = text.replace(/(^|\s)(deadline|pour le|avant le)(?=\s|$)/gi, '$1');
  out.title = text.replace(/\s+/g, ' ').replace(/^[\s:–—-]+|[\s:–—-]+$/g, '').trim();
  if (out.title) out.title = out.title[0].toUpperCase() + out.title.slice(1);
  return out;
}
