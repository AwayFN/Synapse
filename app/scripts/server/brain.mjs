// Le cerveau partagé : état de référence, règles d'accès, application des changements, sauvegardes.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './util.mjs';
import { normalizeTag } from './access.mjs';

const STATUSES = new Set(['todo', 'doing', 'done']);
const NATURES = new Set(['pensee', 'action', 'temps', 'monde']);
const ORIGINS = new Set(['manuel', 'capture', 'mention']);
const TONES = new Set(['pensee', 'action', 'temps', 'monde', 'alert', 'system']);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ACTIVITY = 300;
const MAX_HISTORY = 2000;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const minutes = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1440 ? Math.round(v) : null);
const date = (v) => (typeof v === 'string' && DATE.test(v) ? v : null);

function cleanWhen(w) {
  if (!w || typeof w !== 'object' || !date(w.date)) return null;
  return { date: w.date, start: minutes(w.start), end: minutes(w.end) };
}

function cleanTags(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(normalizeTag).filter(Boolean))].slice(0, 30);
}

/** Valeur propre d'un champ d'entité, ou undefined si le champ n'existe pas */
function cleanField(k, v) {
  switch (k) {
    case 'title':
      return str(v, 500);
    case 'body':
      return str(v, 200_000);
    case 'kind':
      return str(v, 40);
    case 'tags':
      return cleanTags(v);
    case 'status':
      return STATUSES.has(v) ? v : null;
    case 'when':
      return cleanWhen(v);
    case 'due':
      return date(v);
    case 'pinned':
    case 'private':
    case 'seed':
      return !!v;
    case 'order':
      return num(v, 0);
    case 'createdAt':
    case 'updatedAt':
    case 'touchedAt':
      return num(v, Date.now());
    case 'doneAt':
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    default:
      return undefined;
  }
}

const ENTITY_KEYS = ['title', 'body', 'kind', 'tags', 'status', 'when', 'due', 'pinned', 'order', 'createdAt', 'updatedAt', 'touchedAt', 'doneAt', 'seed', 'private'];

export function cleanEntity(raw) {
  if (!raw || typeof raw !== 'object' || !ID.test(String(raw.id))) return null;
  const e = { id: String(raw.id) };
  for (const k of ENTITY_KEYS) {
    const v = cleanField(k, raw[k]);
    if (v !== undefined) e[k] = v;
  }
  if (!e.seed) delete e.seed;
  if (!e.private) delete e.private;
  if (typeof raw.createdBy === 'string' && ID.test(raw.createdBy)) e.createdBy = raw.createdBy;
  if (typeof raw.updatedBy === 'string' && ID.test(raw.updatedBy)) e.updatedBy = raw.updatedBy;
  return e;
}

function cleanLink(raw) {
  if (!raw || typeof raw !== 'object' || !ID.test(String(raw.id)) || !ID.test(String(raw.a)) || !ID.test(String(raw.b)) || raw.a === raw.b) return null;
  const at = num(raw.createdAt, Date.now());
  const l = {
    id: String(raw.id),
    a: String(raw.a),
    b: String(raw.b),
    createdAt: at,
    strength: Math.max(0.05, Math.min(1, num(raw.strength, 0.5))),
    usedAt: num(raw.usedAt, at),
    origin: ORIGINS.has(raw.origin) ? raw.origin : 'manuel',
  };
  if (typeof raw.createdBy === 'string' && ID.test(raw.createdBy)) l.createdBy = raw.createdBy;
  return l;
}

function cleanKind(v) {
  if (!v || typeof v !== 'object' || !NATURES.has(v.nature)) return null;
  return { label: str(v.label, 40), nature: v.nature };
}

function cleanAct(raw) {
  if (!raw || typeof raw !== 'object' || !ID.test(String(raw.id))) return null;
  const a = { id: String(raw.id), at: num(raw.at, Date.now()), text: str(raw.text, 300), tone: TONES.has(raw.tone) ? raw.tone : 'system' };
  if (typeof raw.entityId === 'string' && ID.test(raw.entityId)) a.entityId = raw.entityId;
  const refs = Array.isArray(raw.refs) ? raw.refs.filter((r) => typeof r === 'string' && ID.test(r)).slice(0, 4) : [];
  if (a.entityId && !refs.includes(a.entityId)) refs.unshift(a.entityId);
  if (refs.length) a.refs = refs;
  if (raw.priv) a.priv = true;
  const tags = cleanTags(raw.tags);
  if (tags.length) a.tags = tags;
  return a;
}

// ── droits
export const canWrite = (m) => m.role !== 'lecture';
export const canEditAll = (m) => m.role === 'owner' || m.role === 'edition';
const owns = (m, e) => (e.createdBy || 'owner') === m.id;
export const canEdit = (m, e) => canEditAll(m) || (m.role === 'contribution' && owns(m, e));

export class Brain {
  constructor(dir, log = () => {}) {
    this.dir = dir;
    this.file = path.join(dir, 'cerveau.json');
    this.backupDir = path.join(dir, 'sauvegardes');
    this.log = log;
    const d = readJsonFile(this.file);
    this.s = d && d.entities ? this.normalize(d) : null;
    this.history = [];
    this.timer = null;
    this.lastBackupDay = '';
  }

  get exists() {
    return !!this.s;
  }
  get seq() {
    return this.s ? this.s.seq : 0;
  }

  normalize(d) {
    const entities = {};
    for (const raw of Object.values(d.entities || {})) {
      const e = cleanEntity(raw);
      if (e) entities[e.id] = e;
    }
    const links = [];
    const pairs = new Set();
    for (const raw of d.links || []) {
      const l = cleanLink(raw);
      if (!l || !entities[l.a] || !entities[l.b]) continue;
      const key = l.a < l.b ? `${l.a}|${l.b}` : `${l.b}|${l.a}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      links.push(l);
    }
    const kinds = {};
    for (const [k, v] of Object.entries(d.kinds || {})) {
      const c = cleanKind(v);
      if (c && k.length <= 40) kinds[k] = c;
    }
    const activity = (d.activity || []).map(cleanAct).filter(Boolean).slice(0, MAX_ACTIVITY);
    const layout = {};
    for (const [id, p] of Object.entries(d.layout || {})) {
      if (entities[id] && Array.isArray(p) && p.length === 3 && p.every((x) => Number.isFinite(x))) layout[id] = p;
    }
    return { v: 3, seq: num(d.seq, 0), entities, links, kinds, activity, layout };
  }

  // ── visibilité : le propriétaire voit tout ; un invité ne voit jamais le privé, et seulement sa zone
  visible(m, e) {
    if (!e) return false;
    if (m.role === 'owner') return true;
    if (e.private) return false;
    if (!m.scope || m.scope.all !== false) return true;
    return (e.tags || []).some((t) => m.scope.tags.includes(t));
  }
  actVisible(m, a) {
    if (m.role === 'owner') return true;
    if (a.priv) return false;
    const refs = a.refs || [];
    for (const r of refs) {
      const e = this.s.entities[r];
      if (e && !this.visible(m, e)) return false;
    }
    if (m.scope && m.scope.all === false && refs.length) {
      return (a.tags || []).some((t) => m.scope.tags.includes(t)) || refs.some((r) => this.visible(m, this.s.entities[r]));
    }
    return true;
  }
  /** Retire ce qu'un invité n'a pas à connaître */
  forMember(m, e) {
    if (m.role === 'owner' || !e.private) return e;
    const { private: _p, ...rest } = e;
    return rest;
  }

  snapshot(m) {
    const s = this.s || { seq: 0, entities: {}, links: [], kinds: {}, activity: [], layout: {} };
    const entities = {};
    for (const e of Object.values(s.entities)) if (this.visible(m, e)) entities[e.id] = this.forMember(m, e);
    const links = s.links.filter((l) => entities[l.a] && entities[l.b]);
    const activity = this.s ? s.activity.filter((a) => this.actVisible(m, a)).slice(0, 60) : [];
    const layout = {};
    for (const [id, p] of Object.entries(s.layout || {})) if (entities[id]) layout[id] = p;
    return { seq: s.seq, entities, links, kinds: s.kinds, activity, layout };
  }

  importState(data) {
    const prevSeq = this.s ? this.s.seq : 0;
    this.s = this.normalize({ ...data, seq: prevSeq + 1 });
    this.history = [];
    this.saveNow();
    return this.s.seq;
  }

  setLayout(positions) {
    if (!this.s || !positions || typeof positions !== 'object') return;
    const layout = {};
    for (const [id, p] of Object.entries(positions)) {
      if (this.s.entities[id] && Array.isArray(p) && p.length === 3 && p.every((x) => Number.isFinite(x))) layout[id] = p.map((x) => Math.round(x * 100) / 100);
    }
    this.s.layout = layout;
    this.save();
  }

  linkBetween(a, b) {
    return this.s.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  }

  /** Applique une série de changements d'un participant, dans l'ordre. Renvoie ce qui a été accepté,
   *  ce qui a été refusé, et les corrections à renvoyer à l'auteur pour qu'il rejoigne l'état de référence. */
  apply(m, ops, opts = {}) {
    const accepted = [];
    const rejected = [];
    const fixes = [];
    if (!this.s || !Array.isArray(ops)) return { accepted, rejected, fixes, seq: this.seq };
    this.limit = opts.maxEntities > 0 ? opts.maxEntities : 0;
    ops.slice(0, 500).forEach((op, i) => {
      const r = this.applyOne(m, op);
      if (r.ok) accepted.push(r.op);
      else rejected.push({ i, reason: r.reason });
      if (r.fix) fixes.push(...(Array.isArray(r.fix) ? r.fix : [r.fix]));
    });
    if (accepted.length) {
      this.s.seq++;
      this.history.push({ seq: this.s.seq, by: m.id, ops: accepted });
      if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY);
      this.save();
    }
    return { accepted, rejected, fixes, seq: this.s.seq };
  }

  /** Remet chez l'auteur l'état de référence d'un neurone (ou le retire s'il ne doit pas le voir) */
  restoreFix(m, id) {
    const e = this.s.entities[id];
    if (!e || !this.visible(m, e)) return { t: 'del', id };
    const fix = [{ t: 'put', e: this.forMember(m, e) }];
    for (const l of this.s.links) if ((l.a === id || l.b === id) && this.visible(m, this.s.entities[l.a === id ? l.b : l.a])) fix.push({ t: 'link', l });
    return fix;
  }

  enforceScope(m, e) {
    if (m.role === 'owner' || !m.scope || m.scope.all !== false) return false;
    if ((e.tags || []).some((t) => m.scope.tags.includes(t))) return false;
    e.tags = [...(e.tags || []), m.scope.tags[0]];
    return true;
  }

  applyOne(m, op) {
    const S = this.s;
    if (!op || typeof op !== 'object') return { ok: false, reason: 'invalid' };
    switch (op.t) {
      case 'put': {
        const raw = op.e;
        const e = cleanEntity(raw);
        if (!e) return { ok: false, reason: 'invalid' };
        if (!canWrite(m)) return { ok: false, reason: 'forbidden', fix: { t: 'del', id: e.id } };
        if (S.entities[e.id]) return { ok: false, reason: 'exists', fix: this.restoreFix(m, e.id) };
        // limite de neurones par cerveau, fixée par le créateur du serveur
        if (this.limit && Object.keys(S.entities).length >= this.limit) return { ok: false, reason: 'limit', fix: { t: 'del', id: e.id } };
        let changed = false;
        if (e.private && m.role !== 'owner') {
          delete e.private;
          changed = true;
        }
        if ((raw.createdBy || m.id) !== m.id) changed = true;
        e.createdBy = m.id;
        e.updatedBy = m.id;
        if (this.enforceScope(m, e)) changed = true;
        S.entities[e.id] = e;
        return { ok: true, op: { t: 'put', e }, fix: changed ? { t: 'put', e: this.forMember(m, e) } : null };
      }
      case 'patch': {
        const cur = S.entities[op.id];
        if (!cur || !this.visible(m, cur)) return { ok: false, reason: 'missing', fix: { t: 'del', id: String(op.id) } };
        if (!canEdit(m, cur)) return { ok: false, reason: 'forbidden', fix: this.restoreFix(m, cur.id) };
        const f = {};
        for (const [k, v] of Object.entries(op.f || {})) {
          if (k === 'private' && m.role !== 'owner') continue;
          const c = cleanField(k, v);
          if (c !== undefined && k !== 'createdAt' && k !== 'seed') f[k] = c;
        }
        const next = { ...cur, ...f, updatedBy: m.id };
        if (!next.private) delete next.private;
        let changed = false;
        if (this.enforceScope(m, next)) {
          f.tags = next.tags;
          changed = true;
        }
        S.entities[cur.id] = next;
        return { ok: true, op: { t: 'patch', id: cur.id, f: { ...f, updatedBy: m.id } }, fix: changed ? { t: 'put', e: this.forMember(m, next) } : null };
      }
      case 'del': {
        const cur = S.entities[op.id];
        if (!cur || !this.visible(m, cur)) return { ok: false, reason: 'missing' };
        if (!canEdit(m, cur)) return { ok: false, reason: 'forbidden', fix: this.restoreFix(m, cur.id) };
        delete S.entities[cur.id];
        S.links = S.links.filter((l) => l.a !== cur.id && l.b !== cur.id);
        delete S.layout[cur.id];
        return { ok: true, op: { t: 'del', id: cur.id } };
      }
      case 'link': {
        const l = cleanLink(op.l);
        if (!l) return { ok: false, reason: 'invalid' };
        const ea = S.entities[l.a];
        const eb = S.entities[l.b];
        if (!canWrite(m) || !this.visible(m, ea) || !this.visible(m, eb)) return { ok: false, reason: 'forbidden', fix: { t: 'unlink', id: l.id } };
        const existing = this.linkBetween(l.a, l.b);
        if (existing) return { ok: false, reason: 'exists', fix: [{ t: 'unlink', id: l.id }, { t: 'link', l: existing }] };
        if (S.links.some((x) => x.id === l.id)) return { ok: false, reason: 'exists' };
        l.createdBy = m.id;
        S.links.push(l);
        return { ok: true, op: { t: 'link', l } };
      }
      case 'linkPatch': {
        const l = S.links.find((x) => x.id === op.id);
        if (!l || !this.visible(m, S.entities[l.a]) || !this.visible(m, S.entities[l.b])) return { ok: false, reason: 'missing', fix: { t: 'unlink', id: String(op.id) } };
        if (!canEditAll(m)) return { ok: false, reason: 'forbidden', fix: { t: 'linkPatch', id: l.id, f: { strength: l.strength, usedAt: l.usedAt } } };
        const f = {};
        if (op.f && 'strength' in op.f) f.strength = Math.max(0.05, Math.min(1, num(op.f.strength, l.strength)));
        if (op.f && 'usedAt' in op.f) f.usedAt = num(op.f.usedAt, l.usedAt);
        Object.assign(l, f);
        return { ok: true, op: { t: 'linkPatch', id: l.id, f } };
      }
      case 'unlink': {
        const l = S.links.find((x) => x.id === op.id);
        if (!l) return { ok: false, reason: 'missing' };
        if (!this.visible(m, S.entities[l.a]) || !this.visible(m, S.entities[l.b])) return { ok: false, reason: 'missing' };
        if (!(canEditAll(m) || (m.role === 'contribution' && (l.createdBy || 'owner') === m.id))) return { ok: false, reason: 'forbidden', fix: { t: 'link', l } };
        S.links = S.links.filter((x) => x !== l);
        return { ok: true, op: { t: 'unlink', id: l.id } };
      }
      case 'kind': {
        const k = str(op.k, 40);
        const v = cleanKind(op.v);
        if (!k || !v) return { ok: false, reason: 'invalid' };
        const cur = S.kinds[k];
        const allowed = canEditAll(m) || (canWrite(m) && !cur && v.nature === 'pensee');
        if (!allowed) return { ok: false, reason: 'forbidden', fix: cur ? { t: 'kind', k, v: cur } : null };
        S.kinds[k] = v;
        return { ok: true, op: { t: 'kind', k, v } };
      }
      case 'act': {
        if (!canWrite(m)) return { ok: false, reason: 'forbidden' };
        const a = cleanAct(op.a);
        if (!a || S.activity.some((x) => x.id === a.id)) return { ok: false, reason: 'invalid' };
        a.by = m.id;
        // visibilité de l'entrée : celle des neurones qu'elle mentionne (le propriétaire peut la déclarer privée)
        const refs = (a.refs || []).map((r) => S.entities[r]).filter(Boolean);
        if (m.role !== 'owner') delete a.priv;
        if (refs.some((e) => e.private)) a.priv = true;
        const tags = new Set(a.tags || []);
        for (const e of refs) for (const t of e.tags || []) tags.add(t);
        if (tags.size) a.tags = [...tags].slice(0, 30);
        S.activity.unshift(a);
        if (S.activity.length > MAX_ACTIVITY) S.activity.length = MAX_ACTIVITY;
        return { ok: true, op: { t: 'act', a } };
      }
      default:
        return { ok: false, reason: 'unknown' };
    }
  }

  // ── écriture sur disque
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.saveNow(), 700);
  }
  saveNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.s) return;
    try {
      const text = JSON.stringify(this.s);
      writeJsonAtomic(this.file, text);
      this.bytes = Buffer.byteLength(text);
      this.backup();
      this.onSaved?.();
    } catch (e) {
      this.log(`cerveau.json: ${e.message}`);
    }
  }
  /** Des chiffres seulement (pour l'espace créateur) : jamais de contenu */
  counts() {
    const s = this.s;
    if (!s) return { n: 0, l: 0, priv: 0, bytes: 0 };
    let priv = 0;
    for (const e of Object.values(s.entities)) if (e.private) priv++;
    if (this.bytes === undefined) {
      try {
        this.bytes = fs.statSync(this.file).size;
      } catch {
        this.bytes = 0;
      }
    }
    return { n: Object.keys(s.entities).length, l: s.links.length, priv, bytes: this.bytes };
  }
  /** Une copie par jour, les 14 derniers jours */
  backup() {
    const day = new Date().toISOString().slice(0, 10);
    if (day === this.lastBackupDay) return;
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const target = path.join(this.backupDir, `cerveau-${day}.json`);
      fs.copyFileSync(this.file, target);
      this.lastBackupDay = day;
      const old = fs
        .readdirSync(this.backupDir)
        .filter((f) => /^cerveau-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
        .reverse()
        .slice(14);
      for (const f of old) fs.unlinkSync(path.join(this.backupDir, f));
    } catch (e) {
      this.log(`sauvegarde: ${e.message}`);
    }
  }
}
