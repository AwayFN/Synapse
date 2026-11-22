// Ce que le créateur peut savoir de son serveur : des chiffres et des métadonnées, jamais le contenu
// des cerveaux. Statistiques par jour, retours des utilisateurs, erreurs, journal des évènements.
import crypto from 'node:crypto';
import path from 'node:path';
import { randomToken, readJsonFile, writeJsonAtomic } from './util.mjs';

const KEEP_DAYS = 400;
/** Au-delà, on ne garde que le nombre de personnes actives d'un jour, plus qui elles étaient */
const ID_DAYS = 35;
const MAX_FEEDBACK = 1000;
const MAX_ERRORS = 200;
const MAX_JOURNAL = 3000;
export const VIEWS = ['network', 'flux', 'agenda', 'tasks'];
export const NATURES = ['pensee', 'action', 'temps', 'monde'];

const pad = (n) => String(n).padStart(2, '0');
export const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Adresse IP raccourcie pour le journal : assez pour repérer des tentatives répétées, pas pour localiser quelqu'un */
export function maskIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return s.split('.').slice(0, 2).join('.') + '.x.x';
  if (s.includes(':')) return s.split(':').slice(0, 3).join(':') + ':…';
  return s ? '?' : '';
}

class Store {
  constructor(file, init, log) {
    this.file = file;
    this.log = log;
    const d = readJsonFile(file);
    this.d = d && typeof d === 'object' ? { ...init, ...d } : init;
    this.timer = null;
  }
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      writeJsonAtomic(this.file, JSON.stringify(this.d));
    } catch (e) {
      this.log(`${path.basename(this.file)}: ${e.message}`);
    }
  }
}

const emptyDay = () => ({ a: [], g: [], su: 0, cap: 0, ops: 0, vis: 0, log: 0, pk: 0, err: 0, fb: 0, v: {}, nat: {} });

export class Telemetry {
  constructor(dir, log = () => {}) {
    this.stats = new Store(path.join(dir, 'stats.json'), { days: {} }, log);
    this.fb = new Store(path.join(dir, 'retours.json'), { items: [] }, log);
    this.err = new Store(path.join(dir, 'erreurs.json'), { groups: {} }, log);
    this.jr = new Store(path.join(dir, 'journal.json'), { items: [] }, log);
    if (!Array.isArray(this.fb.d.items)) this.fb.d.items = [];
    if (!Array.isArray(this.jr.d.items)) this.jr.d.items = [];
    if (!this.err.d.groups || typeof this.err.d.groups !== 'object') this.err.d.groups = {};
    this.compact();
  }

  // ── statistiques du jour
  day(t) {
    const k = dayKey(t);
    const days = this.stats.d.days;
    if (!days[k]) days[k] = emptyDay();
    return days[k];
  }
  bump(field, n = 1) {
    this.day()[field] = (this.day()[field] || 0) + n;
    this.stats.save();
  }
  active(accountId) {
    const d = this.day();
    if (!d.a.includes(accountId)) {
      d.a.push(accountId);
      this.stats.save();
    }
  }
  guest(key) {
    const d = this.day();
    if (!d.g.includes(key)) {
      d.g.push(key);
      this.stats.save();
    }
  }
  capture(nature) {
    const d = this.day();
    const n = NATURES.includes(nature) ? nature : 'pensee';
    d.nat[n] = (d.nat[n] || 0) + 1;
    d.cap++;
    this.stats.save();
  }
  view(view, seconds) {
    if (!VIEWS.includes(view) || !(seconds > 0)) return;
    const d = this.day();
    d.v[view] = Math.round((d.v[view] || 0) + seconds);
    this.stats.save();
  }
  peak(n) {
    const d = this.day();
    if (n > d.pk) {
      d.pk = n;
      this.stats.save();
    }
  }
  compact() {
    const days = this.stats.d.days || (this.stats.d.days = {});
    const now = Date.now();
    for (const [k, d] of Object.entries(days)) {
      const age = (now - new Date(`${k}T12:00:00`).getTime()) / 86400_000;
      if (!(age < KEEP_DAYS)) delete days[k];
      else if (age > ID_DAYS) {
        if (Array.isArray(d.a)) {
          d.ac = d.a.length;
          delete d.a;
        }
        if (Array.isArray(d.g)) {
          d.gc = d.g.length;
          delete d.g;
        }
      }
    }
    this.stats.save();
  }
  /** Les `n` derniers jours, du plus ancien au plus récent */
  lastDays(n) {
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const t = Date.now() - i * 86400_000;
      const k = dayKey(t);
      out.push([k, this.stats.d.days[k] || null]);
    }
    return out;
  }
  series(n = 30) {
    return this.lastDays(n).map(([date, d]) => ({
      date,
      active: d ? (d.a ? d.a.length : d.ac || 0) : 0,
      guests: d ? (d.g ? d.g.length : d.gc || 0) : 0,
      signups: d?.su || 0,
      captures: d?.cap || 0,
      ops: d?.ops || 0,
      visits: d?.vis || 0,
      logins: d?.log || 0,
      peak: d?.pk || 0,
      errors: d?.err || 0,
      feedback: d?.fb || 0,
    }));
  }
  uniqueActive(n) {
    const s = new Set();
    for (const [, d] of this.lastDays(n)) for (const id of d?.a || []) s.add(id);
    return s.size;
  }
  activeDaysOf(accountId, n = 30) {
    let c = 0;
    for (const [, d] of this.lastDays(n)) if (d?.a?.includes(accountId)) c++;
    return c;
  }
  viewTotals(n = 30) {
    const out = Object.fromEntries(VIEWS.map((v) => [v, 0]));
    for (const [, d] of this.lastDays(n)) for (const v of VIEWS) out[v] += d?.v?.[v] || 0;
    return out;
  }
  natureTotals(n = 30) {
    const out = Object.fromEntries(NATURES.map((v) => [v, 0]));
    for (const [, d] of this.lastDays(n)) for (const v of NATURES) out[v] += d?.nat?.[v] || 0;
    return out;
  }

  // ── retours (idées, problèmes) envoyés depuis l'application
  addFeedback({ kind, text, from, view, version, ua }) {
    const item = {
      id: randomToken(6),
      at: Date.now(),
      kind: ['idee', 'probleme', 'autre'].includes(kind) ? kind : 'autre',
      text: String(text || '').slice(0, 3000),
      from,
      view: VIEWS.includes(view) ? view : null,
      version: String(version || '').slice(0, 40),
      ua: String(ua || '').slice(0, 160),
      status: 'nouveau',
    };
    this.fb.d.items.unshift(item);
    if (this.fb.d.items.length > MAX_FEEDBACK) this.fb.d.items.length = MAX_FEEDBACK;
    this.fb.save();
    this.bump('fb');
    return item;
  }
  feedbackList() {
    return this.fb.d.items;
  }
  unreadFeedback() {
    return this.fb.d.items.filter((f) => f.status === 'nouveau').length;
  }
  updateFeedback(id, status) {
    const f = this.fb.d.items.find((x) => x.id === id);
    if (!f || !['nouveau', 'lu', 'traite'].includes(status)) return false;
    f.status = status;
    this.fb.save();
    return true;
  }
  deleteFeedback(id) {
    this.fb.d.items = this.fb.d.items.filter((x) => x.id !== id);
    this.fb.save();
  }

  // ── erreurs (regroupées : une même erreur ne remplit pas la liste)
  addError({ source, message, stack, where, version, ua, who }) {
    const msg = String(message || 'erreur').slice(0, 400);
    const st = String(stack || '').slice(0, 3000);
    const firstFrame = (st.split('\n').find((l) => /at |@/.test(l)) || '').trim().replace(/\?[^:)]*/g, '');
    const sig = crypto
      .createHash('sha1')
      .update(`${source}|${msg}|${firstFrame}`)
      .digest('hex')
      .slice(0, 12);
    const groups = this.err.d.groups;
    const g = groups[sig] || { sig, source: source === 'serveur' ? 'serveur' : 'client', message: msg, stack: st, first: Date.now(), count: 0, people: [] };
    g.count++;
    g.last = Date.now();
    g.where = String(where || '').slice(0, 120);
    g.version = String(version || '').slice(0, 40);
    g.ua = String(ua || '').slice(0, 160);
    if (who && !g.people.includes(who)) g.people = [...g.people, who].slice(-50);
    groups[sig] = g;
    const keys = Object.keys(groups);
    if (keys.length > MAX_ERRORS) {
      keys.sort((a, b) => groups[a].last - groups[b].last);
      for (const k of keys.slice(0, keys.length - MAX_ERRORS)) delete groups[k];
    }
    this.err.save();
    this.bump('err');
  }
  errorsList() {
    return Object.values(this.err.d.groups)
      .sort((a, b) => b.last - a.last)
      .map((g) => ({ ...g, people: g.people.length }));
  }
  errorsSince(ms) {
    return Object.values(this.err.d.groups).filter((g) => g.last > Date.now() - ms).length;
  }
  clearErrors() {
    this.err.d.groups = {};
    this.err.save();
  }

  // ── journal : inscriptions, connexions, échecs, actions d'administration, accès ouverts…
  event(type, text, who = null, ip = '') {
    this.jr.d.items.unshift({ id: randomToken(5), at: Date.now(), type, text: String(text).slice(0, 300), who: who ? { id: who.id, name: who.name } : null, ip: ip || '' });
    if (this.jr.d.items.length > MAX_JOURNAL) this.jr.d.items.length = MAX_JOURNAL;
    this.jr.save();
  }
  journal(type, limit = 400) {
    const items = type ? this.jr.d.items.filter((x) => x.type === type) : this.jr.d.items;
    return items.slice(0, limit);
  }

  flush() {
    this.stats.flush();
    this.fb.flush();
    this.err.flush();
    this.jr.flush();
  }
}
