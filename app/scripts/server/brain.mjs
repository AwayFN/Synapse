// Le cerveau : état de référence, règles d'accès, application des changements, sauvegardes.
// Quatre sortes d'éléments (comme la première version de Synapse) : projet, tâche, note, créneau ; des liens
// entre n'importe lesquels ; un journal d'activité ; la position de chaque neurone dans l'espace.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './util.mjs';
import { normalizeTag } from './access.mjs';

const TYPES = new Set(['project', 'task', 'note', 'slot']);
const TASK_STATUS = new Set(['todo', 'doing', 'done']);
const PROJECT_STATUS = new Set(['active', 'done']);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_ACTIVITY = 300;
const MAX_HISTORY = 2000;
/** palette néon de la première version */
const NEON = ['#ff2e88', '#00e5ff', '#a855f7', '#39ff88', '#ffb020', '#3d7bff', '#ff5a36', '#e879f9', '#2dd4bf', '#facc15', '#ff4d6d', '#7cf03c', '#60a5fa', '#f472b6', '#c084fc', '#fb923c'];

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const minutes = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1440 ? Math.round(v) : null);
const date = (v) => (typeof v === 'string' && DATE.test(v) ? v : null);
const ref = (v) => (typeof v === 'string' && ID.test(v) ? v : null);
const color = (v, id = '') => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : NEON[hash(id) % NEON.length]);

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function cleanTags(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(normalizeTag).filter(Boolean))].slice(0, 30);
}

/**
 * Les champs de chaque sorte d'élément. V6 : des tags sur tout (pas seulement les notes), et une note peut
 * appartenir à un projet (ou rester « indépendante », comme une tâche).
 */
const FIELDS = {
  project: ['description', 'status', 'deadline'],
  task: ['description', 'projectId', 'status', 'date', 'time', 'order', 'doneAt'],
  note: ['content', 'projectId'],
  slot: ['description', 'projectId', 'date', 'start', 'end'],
};
const COMMON = ['title', 'color', 'createdAt', 'updatedAt', 'seed', 'private', 'tags'];

/** Valeur propre d'un champ, ou undefined si ce champ n'existe pas pour cette sorte d'élément */
function cleanField(type, k, v, id = '') {
  if (!COMMON.includes(k) && !FIELDS[type]?.includes(k)) return undefined;
  switch (k) {
    case 'title':
      return str(v, 500);
    case 'color':
      return color(v, id);
    case 'createdAt':
    case 'updatedAt':
      return num(v, Date.now());
    case 'seed':
    case 'private':
      return !!v;
    case 'description':
      return str(v, 50_000);
    case 'content':
      return str(v, 200_000);
    case 'tags':
      return cleanTags(v);
    case 'status':
      return type === 'project' ? (PROJECT_STATUS.has(v) ? v : 'active') : TASK_STATUS.has(v) ? v : 'todo';
    case 'deadline':
      return date(v);
    case 'projectId':
      return ref(v);
    case 'date':
      return type === 'slot' ? date(v) || new Date().toISOString().slice(0, 10) : date(v);
    case 'time':
      return minutes(v);
    case 'start':
      return minutes(v) ?? 9 * 60;
    case 'end':
      return minutes(v) ?? 10 * 60;
    case 'order':
      return num(v, 0);
    case 'doneAt':
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    default:
      return undefined;
  }
}

export function cleanEntity(raw) {
  if (!raw || typeof raw !== 'object' || !ID.test(String(raw.id)) || !TYPES.has(raw.type)) return null;
  const id = String(raw.id);
  const e = { id, type: raw.type };
  for (const k of [...COMMON, ...FIELDS[raw.type]]) {
    const v = cleanField(raw.type, k, raw[k], id);
    if (v !== undefined) e[k] = v;
  }
  if (e.title === undefined) e.title = '';
  if (!e.seed) delete e.seed;
  if (!e.private) delete e.private;
  if (raw.type === 'note' && e.content === undefined) e.content = '';
  if (raw.type !== 'note' && e.description === undefined) e.description = '';
  if (typeof raw.createdBy === 'string' && ID.test(raw.createdBy)) e.createdBy = raw.createdBy;
  if (typeof raw.updatedBy === 'string' && ID.test(raw.updatedBy)) e.updatedBy = raw.updatedBy;
  return e;
}

function cleanLink(raw) {
  if (!raw || typeof raw !== 'object' || !ID.test(String(raw.id)) || !ID.test(String(raw.a)) || !ID.test(String(raw.b)) || raw.a === raw.b) return null;
  const l = { id: String(raw.id), a: String(raw.a), b: String(raw.b), createdAt: num(raw.createdAt, Date.now()) };
  if (typeof raw.createdBy === 'string' && ID.test(raw.createdBy)) l.createdBy = raw.createdBy;
  return l;
}

function cleanAct(raw) {
  if (!raw || typeof raw !== 'object' || !ID.test(String(raw.id))) return null;
  const a = { id: String(raw.id), at: num(raw.at, Date.now()), text: str(raw.text, 300), color: typeof raw.color === 'string' && HEX.test(raw.color) ? raw.color : '#00e5ff' };
  if (typeof raw.entityId === 'string' && ID.test(raw.entityId)) a.entityId = raw.entityId;
  if (typeof raw.by === 'string' && ID.test(raw.by)) a.by = raw.by;
  if (raw.priv) a.priv = true;
  return a;
}

// ───────────────────────── reprise d'un cerveau de la V4 (neurones « libres » → projet, tâche, note, créneau)
const PROJECT_KINDS = new Set(['projet', 'objectif', 'project']);
const TASK_KINDS = new Set(['tache', 'task', 'action', 'todo', 'a faire']);
const TONE_COLOR = { pensee: '#a855f7', action: '#00e5ff', temps: '#ffb020', monde: '#2dd4bf', alert: '#ff4d6d', system: '#00e5ff' };
const plain = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

export function isV4(d) {
  return !!d && typeof d === 'object' && (d.v === 3 || Object.values(d.entities || {}).some((e) => e && typeof e === 'object' && !('type' in e) && 'kind' in e));
}

/** Convertit un cerveau V4 : rien n'est perdu (le genre devient un tag, le corps devient le texte) */
export function fromV4(d) {
  const entities = {};
  const used = {};
  const pick = (offset, id) => {
    // couleurs variées, comme la première version (la moins utilisée d'abord)
    let best = NEON[(hash(id) + offset) % NEON.length];
    let n = Infinity;
    for (let i = 0; i < NEON.length; i++) {
      const c = NEON[(i + offset) % NEON.length];
      if ((used[c] || 0) < n) {
        n = used[c] || 0;
        best = c;
      }
    }
    used[best] = (used[best] || 0) + 1;
    return best;
  };
  for (const raw of Object.values(d.entities || {})) {
    if (!raw || !ID.test(String(raw.id))) continue;
    const id = String(raw.id);
    const k = plain(raw.kind);
    const w = raw.when && typeof raw.when === 'object' ? raw.when : null;
    const base = {
      id,
      title: str(raw.title, 500),
      createdAt: num(raw.createdAt, Date.now()),
      updatedAt: num(raw.updatedAt, Date.now()),
      ...(raw.seed ? { seed: true } : {}),
      ...(raw.private ? { private: true } : {}),
      ...(typeof raw.createdBy === 'string' ? { createdBy: raw.createdBy } : {}),
    };
    let e;
    if (PROJECT_KINDS.has(k)) {
      e = { ...base, type: 'project', color: pick(0, id), description: str(raw.body, 50_000), status: raw.status === 'done' ? 'done' : 'active', deadline: date(raw.due) };
    } else if (w && date(w.date) && minutes(w.start) != null && (minutes(w.end) != null || !raw.status)) {
      const start = minutes(w.start);
      const end = minutes(w.end) ?? (start + 60) % 1440;
      e = { ...base, type: 'slot', color: pick(4, id), description: str(raw.body, 50_000), projectId: null, date: w.date, start, end };
    } else if (TASK_STATUS.has(raw.status) || TASK_KINDS.has(k)) {
      e = {
        ...base,
        type: 'task',
        color: pick(1, id),
        description: str(raw.body, 50_000),
        projectId: null,
        status: TASK_STATUS.has(raw.status) ? raw.status : 'todo',
        date: date(w?.date) || date(raw.due),
        time: minutes(w?.start),
        order: num(raw.order, 0),
        doneAt: typeof raw.doneAt === 'number' ? raw.doneAt : null,
      };
    } else {
      const tags = cleanTags([...(Array.isArray(raw.tags) ? raw.tags : []), ...(k && k !== 'note' && k !== 'pensee' ? [k] : [])]);
      e = { ...base, type: 'note', color: pick(2, id), content: str(raw.body, 200_000), tags, projectId: null };
    }
    entities[id] = e;
  }
  // une tâche ou un créneau relié à un projet lui appartient (lien « parent », comme dans la première version)
  const links = [];
  for (const raw of d.links || []) {
    const l = cleanLink(raw);
    if (!l || !entities[l.a] || !entities[l.b]) continue;
    const a = entities[l.a];
    const b = entities[l.b];
    const kid = (x) => x.type === 'task' || x.type === 'slot';
    const child = kid(a) && b.type === 'project' ? a : kid(b) && a.type === 'project' ? b : null;
    const parent = child === a ? b : a;
    if (child && !child.projectId) {
      child.projectId = parent.id;
      continue;
    }
    links.push(l);
  }
  const activity = (d.activity || [])
    .map((a) => (a && typeof a === 'object' ? { ...a, color: TONE_COLOR[a.tone] || '#00e5ff' } : null))
    .map(cleanAct)
    .filter(Boolean);
  return { seq: num(d.seq, 0), entities, links, activity, layout: d.layout || {} };
}

// ── droits : « peut modifier » (et le propriétaire) écrivent, « peut regarder » regarde
export const canWrite = (m) => m.role === 'owner' || m.role === 'edition';

export class Brain {
  constructor(dir, log = () => {}) {
    this.dir = dir;
    this.file = path.join(dir, 'cerveau.json');
    this.backupDir = path.join(dir, 'sauvegardes');
    this.log = log;
    let d = readJsonFile(this.file);
    if (d && d.entities && isV4(d)) {
      // on garde l'original, puis on convertit
      try {
        const keep = path.join(dir, 'cerveau-v4.json');
        if (!fs.existsSync(keep)) fs.copyFileSync(this.file, keep);
      } catch (e) {
        log(`copie V4 : ${e.message}`);
      }
      d = fromV4(d);
      this.migrated = true;
      log(`cerveau converti (V4 → V5) : ${Object.keys(d.entities).length} éléments`);
    }
    this.s = d && d.entities ? this.normalize(d) : null;
    this.history = [];
    this.timer = null;
    this.lastBackupDay = '';
    if (this.migrated) this.saveNow();
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
    // un projet disparu : ses tâches, créneaux et notes restent, sans projet
    for (const e of Object.values(entities)) if (e.projectId && entities[e.projectId]?.type !== 'project') e.projectId = null;
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
    const activity = (d.activity || []).map(cleanAct).filter(Boolean).slice(0, MAX_ACTIVITY);
    const layout = {};
    for (const [id, p] of Object.entries(d.layout || {})) {
      if (entities[id] && Array.isArray(p) && p.length === 3 && p.every((x) => Number.isFinite(x))) layout[id] = p;
    }
    return { v: 5, seq: num(d.seq, 0), entities, links, activity, layout };
  }

  // ── visibilité : un invité ne voit jamais ce que le propriétaire a marqué privé
  visible(m, e) {
    if (!e) return false;
    return m.role === 'owner' || !e.private;
  }
  actVisible(m, a) {
    if (m.role === 'owner') return true;
    if (a.priv) return false;
    return !a.entityId || this.visible(m, this.s.entities[a.entityId]) || !this.s.entities[a.entityId];
  }

  snapshot(m) {
    const s = this.s || { seq: 0, entities: {}, links: [], activity: [], layout: {} };
    const entities = {};
    for (const e of Object.values(s.entities)) {
      if (!this.visible(m, e)) continue;
      // le projet d'un élément visible peut être privé : l'invité ne le voit pas, ni le lien
      entities[e.id] = e.projectId && !this.visible(m, s.entities[e.projectId]) ? { ...e, projectId: null } : e;
    }
    const links = s.links.filter((l) => entities[l.a] && entities[l.b]);
    const activity = this.s ? s.activity.filter((a) => this.actVisible(m, a)).slice(0, 60) : [];
    const layout = {};
    for (const [id, p] of Object.entries(s.layout || {})) if (entities[id]) layout[id] = p;
    return { seq: s.seq, entities, links, activity, layout };
  }

  importState(data) {
    const prevSeq = this.s ? this.s.seq : 0;
    this.s = this.normalize({ ...(isV4(data) ? fromV4(data) : data), seq: prevSeq + 1 });
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

  /**
   * Applique une série de changements d'un participant, dans l'ordre. Renvoie ce qui a été accepté, ce qui a
   * été refusé, et les corrections à renvoyer à l'auteur pour qu'il rejoigne l'état de référence.
   * opts.lockedBy(id) : la personne qui écrit en ce moment dans cet élément (une seule à la fois), sinon null.
   */
  apply(m, ops, opts = {}) {
    const accepted = [];
    const rejected = [];
    const fixes = [];
    if (!this.s || !Array.isArray(ops)) return { accepted, rejected, fixes, seq: this.seq };
    this.limit = opts.maxEntities > 0 ? opts.maxEntities : 0;
    this.lockedBy = typeof opts.lockedBy === 'function' ? opts.lockedBy : () => null;
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

  /** Remet chez l'auteur l'état de référence d'un élément (ou le retire s'il ne doit pas le voir) */
  restoreFix(m, id) {
    const e = this.s.entities[id];
    if (!e || !this.visible(m, e)) return { t: 'del', id };
    const fix = [{ t: 'put', e }];
    for (const l of this.s.links) if ((l.a === id || l.b === id) && this.visible(m, this.s.entities[l.a === id ? l.b : l.a])) fix.push({ t: 'link', l });
    return fix;
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
        // limite d'éléments par cerveau, fixée par l'admin du serveur
        if (this.limit && Object.keys(S.entities).length >= this.limit) return { ok: false, reason: 'limit', fix: { t: 'del', id: e.id } };
        if (e.private && m.role !== 'owner') delete e.private;
        if (e.projectId && S.entities[e.projectId]?.type !== 'project') e.projectId = null;
        e.createdBy = m.id;
        e.updatedBy = m.id;
        S.entities[e.id] = e;
        return { ok: true, op: { t: 'put', e } };
      }
      case 'patch': {
        const cur = S.entities[op.id];
        if (!cur || !this.visible(m, cur)) return { ok: false, reason: 'missing', fix: { t: 'del', id: String(op.id) } };
        if (!canWrite(m)) return { ok: false, reason: 'forbidden', fix: this.restoreFix(m, cur.id) };
        // quelqu'un d'autre écrit dans cet élément : une seule personne à la fois
        const holder = this.lockedBy(cur.id);
        if (holder && holder.memberId !== m.id) return { ok: false, reason: 'locked', fix: this.restoreFix(m, cur.id) };
        const f = {};
        for (const [k, v] of Object.entries(op.f || {})) {
          if (k === 'private' && m.role !== 'owner') continue;
          if (k === 'createdAt' || k === 'seed' || k === 'type' || k === 'id') continue;
          const c = cleanField(cur.type, k, v, cur.id);
          if (c !== undefined) f[k] = c;
        }
        if (f.projectId && S.entities[f.projectId]?.type !== 'project') f.projectId = null;
        const next = { ...cur, ...f, updatedBy: m.id };
        if (!next.private) delete next.private;
        S.entities[cur.id] = next;
        return { ok: true, op: { t: 'patch', id: cur.id, f: { ...f, updatedBy: m.id } } };
      }
      case 'del': {
        const cur = S.entities[op.id];
        if (!cur || !this.visible(m, cur)) return { ok: false, reason: 'missing' };
        if (!canWrite(m)) return { ok: false, reason: 'forbidden', fix: this.restoreFix(m, cur.id) };
        const holder = this.lockedBy(cur.id);
        if (holder && holder.memberId !== m.id) return { ok: false, reason: 'locked', fix: this.restoreFix(m, cur.id) };
        delete S.entities[cur.id];
        S.links = S.links.filter((l) => l.a !== cur.id && l.b !== cur.id);
        // ses tâches, créneaux et notes restent, sans projet
        for (const e of Object.values(S.entities)) if (e.projectId === cur.id) S.entities[e.id] = { ...e, projectId: null };
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
      case 'unlink': {
        const l = S.links.find((x) => x.id === op.id);
        if (!l) return { ok: false, reason: 'missing' };
        if (!this.visible(m, S.entities[l.a]) || !this.visible(m, S.entities[l.b])) return { ok: false, reason: 'missing' };
        if (!canWrite(m)) return { ok: false, reason: 'forbidden', fix: { t: 'link', l } };
        S.links = S.links.filter((x) => x !== l);
        return { ok: true, op: { t: 'unlink', id: l.id } };
      }
      case 'act': {
        if (!canWrite(m)) return { ok: false, reason: 'forbidden' };
        const a = cleanAct(op.a);
        if (!a || S.activity.some((x) => x.id === a.id)) return { ok: false, reason: 'invalid' };
        a.by = m.id;
        if (m.role !== 'owner') delete a.priv;
        if (a.entityId && S.entities[a.entityId]?.private) a.priv = true;
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
  /** Des chiffres seulement (pour l'espace admin) : jamais de contenu */
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
