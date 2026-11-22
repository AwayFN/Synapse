// Comptes Synapse : qui peut se connecter, et avec quel rôle sur le serveur.
//   créateur : tous les droits (c'est toi) · admin : t'aide à gérer · membre : utilise Synapse
// Chaque compte a son propre cerveau ; il peut en ouvrir l'accès à d'autres et rejoindre les leurs.
// Les mots de passe ne sont jamais enregistrés : seulement une empreinte scrypt, avec un sel par compte.
import crypto from 'node:crypto';
import path from 'node:path';
import { cleanName } from './access.mjs';
import { randomToken, readJsonFile, safeEqual, sha256, writeJsonAtomic } from './util.mjs';

export const SERVER_ROLES = ['createur', 'admin', 'membre'];
export const isStaff = (a) => !!a && a.status !== 'suspendu' && (a.role === 'createur' || a.role === 'admin');
const SESSION_DAYS = 90;
const RESET_HOURS = 48;
const LOCK_AFTER = 8;
const LOCK_MS = 15 * 60_000;
const KDF = { N: 16384, r: 8, p: 1, len: 32 };

export function cleanEmail(e) {
  const s = String(e ?? '')
    .trim()
    .toLowerCase()
    .slice(0, 120);
  return /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(s) ? s : '';
}

export function passwordProblem(pw) {
  const s = String(pw ?? '');
  if (s.length < 8) return 'Le mot de passe doit faire au moins 8 caractères.';
  if (s.length > 200) return 'Le mot de passe est trop long.';
  return null;
}

const kdf = (password, salt, p = KDF) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(String(password).normalize('NFKC'), String(salt), p.len, { N: p.N, r: p.r, p: p.p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key.toString('base64url')),
    ),
  );

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  return { algo: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, len: KDF.len, salt, hash: await kdf(password, salt) };
}

/** Comparaison en temps constant ; sans compte, le calcul a lieu quand même (aucun indice sur l'existence du compte) */
export async function checkPassword(password, rec) {
  if (!rec || !rec.salt || !rec.hash) {
    await kdf(password, 'synapse-factice');
    return false;
  }
  const h = await kdf(password, rec.salt, { N: rec.N || KDF.N, r: rec.r || KDF.r, p: rec.p || KDF.p, len: rec.len || KDF.len });
  return safeEqual(h, rec.hash);
}

const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});

export class Accounts {
  constructor(dir, log = () => {}) {
    this.file = path.join(dir, 'comptes.json');
    this.log = log;
    const d = readJsonFile(this.file) || {};
    this.d = { accounts: obj(d.accounts), sessions: obj(d.sessions), signups: obj(d.signups), resets: obj(d.resets) };
    for (const a of Object.values(this.d.accounts)) if (!Array.isArray(a.shared)) a.shared = [];
    /** accountId → { n, until } : tentatives de connexion ratées (en mémoire) */
    this.fails = new Map();
    this.timer = null;
    this.prune();
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 300);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      writeJsonAtomic(this.file, JSON.stringify(this.d, null, 1));
    } catch (e) {
      this.log(`comptes.json: ${e.message}`);
    }
  }

  // ── comptes
  get(id) {
    return (typeof id === 'string' && this.d.accounts[id]) || null;
  }
  list() {
    return Object.values(this.d.accounts);
  }
  count() {
    return this.list().length;
  }
  byEmail(email) {
    const e = cleanEmail(email);
    return e ? this.list().find((a) => a.email === e) || null : null;
  }
  byBrain(brainId) {
    return this.list().find((a) => a.brainId === brainId) || null;
  }
  /** Le premier créateur : celui du PC qui fait tourner Synapse */
  creator() {
    return (
      this.list()
        .filter((a) => a.role === 'createur')
        .sort((x, y) => x.createdAt - y.createdAt)[0] || null
    );
  }
  activeCreators() {
    return this.list().filter((a) => a.role === 'createur' && a.status !== 'suspendu');
  }

  create({ name, email = '', pass = null, role = 'membre', via = 'ouverte', invitedBy = null }) {
    const a = {
      id: randomToken(9),
      name: cleanName(name, ''),
      email: cleanEmail(email),
      pass,
      role: SERVER_ROLES.includes(role) ? role : 'membre',
      status: 'actif',
      brainId: randomToken(9),
      shared: [],
      via,
      invitedBy,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      stats: null,
    };
    this.d.accounts[a.id] = a;
    this.save();
    return a;
  }
  remove(id) {
    delete this.d.accounts[id];
    for (const [k, s] of Object.entries(this.d.sessions)) if (s.accountId === id) delete this.d.sessions[k];
    for (const [k, r] of Object.entries(this.d.resets)) if (r.accountId === id) delete this.d.resets[k];
    for (const a of this.list()) if (a.invitedBy === id) a.invitedBy = null;
    this.fails.delete(id);
    this.save();
  }
  touch(a) {
    const now = Date.now();
    if (!a.lastSeen || now - a.lastSeen > 60_000) {
      a.lastSeen = now;
      this.save();
    }
  }
  addShared(id, brainId) {
    const a = this.get(id);
    if (a && !a.shared.includes(brainId)) {
      a.shared.push(brainId);
      this.save();
    }
  }
  removeShared(id, brainId) {
    const a = this.get(id);
    if (a && a.shared.includes(brainId)) {
      a.shared = a.shared.filter((b) => b !== brainId);
      this.save();
    }
  }
  /** Chiffres du cerveau d'un compte, gardés pour l'espace créateur (jamais le contenu) */
  setStats(id, stats) {
    const a = this.get(id);
    if (!a) return;
    a.stats = { ...stats, at: Date.now() };
    this.save();
  }

  // ── sessions (le jeton n'est gardé que haché)
  newSession(accountId, meta = {}) {
    const token = randomToken(32);
    this.d.sessions[sha256(token)] = {
      accountId,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      ua: String(meta.ua || '').slice(0, 160),
      via: String(meta.via || ''),
    };
    this.save();
    return token;
  }
  session(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const hash = sha256(token);
    const s = this.d.sessions[hash];
    if (!s) return null;
    const now = Date.now();
    const account = this.get(s.accountId);
    if (!account || now - s.createdAt > SESSION_DAYS * 86400_000) {
      delete this.d.sessions[hash];
      this.save();
      return null;
    }
    if (!s.lastSeen || now - s.lastSeen > 60_000) {
      s.lastSeen = now;
      this.save();
    }
    return { hash, s, account };
  }
  endSession(token) {
    if (typeof token !== 'string') return;
    delete this.d.sessions[sha256(token)];
    this.save();
  }
  endAll(accountId, keepHash = null) {
    let n = 0;
    for (const [k, s] of Object.entries(this.d.sessions)) {
      if (s.accountId === accountId && k !== keepHash) {
        delete this.d.sessions[k];
        n++;
      }
    }
    this.save();
    return n;
  }
  sessionsOf(accountId) {
    return Object.values(this.d.sessions)
      .filter((s) => s.accountId === accountId)
      .map((s) => ({ createdAt: s.createdAt, lastSeen: s.lastSeen, ua: s.ua, via: s.via }))
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  // ── invitations à créer un compte
  createSignup({ note, maxUses, ttlHours, createdBy }) {
    const inv = {
      id: randomToken(6),
      token: randomToken(18),
      note: cleanName(note, '').slice(0, 60),
      createdBy,
      maxUses: Math.max(0, Math.min(1000, Math.floor(Number(maxUses) || 0))),
      uses: 0,
      users: [],
      createdAt: Date.now(),
      expiresAt: Number(ttlHours) > 0 ? Date.now() + Number(ttlHours) * 3600_000 : null,
      revokedAt: null,
    };
    this.d.signups[inv.id] = inv;
    this.save();
    return inv;
  }
  signupByToken(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    for (const inv of Object.values(this.d.signups)) if (safeEqual(inv.token, token)) return inv;
    return null;
  }
  signupState(inv) {
    if (!inv) return 'unknown';
    if (inv.revokedAt) return 'revoked';
    if (inv.expiresAt && Date.now() > inv.expiresAt) return 'expired';
    if (inv.maxUses > 0 && inv.uses >= inv.maxUses) return 'used';
    return 'ok';
  }
  useSignup(inv, accountId) {
    inv.uses++;
    inv.users = [...(inv.users || []), accountId].slice(-200);
    this.save();
  }
  signupsCreatedBy(accountId, sinceMs) {
    return Object.values(this.d.signups).filter((s) => s.createdBy === accountId && s.createdAt > Date.now() - sinceMs);
  }
  signupsList() {
    return Object.values(this.d.signups)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => ({
        id: s.id,
        token: s.token,
        note: s.note,
        createdBy: s.createdBy,
        createdByName: this.get(s.createdBy)?.name || '—',
        maxUses: s.maxUses,
        uses: s.uses,
        usedBy: (s.users || []).map((id) => this.get(id)?.name).filter(Boolean),
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        state: this.signupState(s),
      }));
  }
  revokeSignup(id) {
    const s = this.d.signups[id];
    if (!s) return false;
    s.revokedAt = Date.now();
    this.save();
    return true;
  }

  // ── mot de passe oublié : lien à usage unique, créé par un admin (pas d'e-mail à envoyer)
  createReset(accountId, createdBy) {
    for (const [k, r] of Object.entries(this.d.resets)) if (r.accountId === accountId) delete this.d.resets[k];
    const token = randomToken(24);
    this.d.resets[sha256(token)] = { accountId, createdBy, createdAt: Date.now(), expiresAt: Date.now() + RESET_HOURS * 3600_000 };
    this.save();
    return token;
  }
  reset(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const hash = sha256(token);
    const r = this.d.resets[hash];
    if (!r) return null;
    const account = this.get(r.accountId);
    if (!account || Date.now() > r.expiresAt) {
      delete this.d.resets[hash];
      this.save();
      return null;
    }
    return { hash, r, account };
  }
  consumeReset(hash) {
    delete this.d.resets[hash];
    this.save();
  }

  // ── tentatives de connexion : après 8 échecs, le compte est bloqué 15 minutes
  locked(id) {
    const f = this.fails.get(id);
    return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60_000) : 0;
  }
  failed(id) {
    const f = this.fails.get(id) || { n: 0, until: 0 };
    f.n++;
    if (f.n >= LOCK_AFTER) {
      f.until = Date.now() + LOCK_MS;
      f.n = 0;
    }
    this.fails.set(id, f);
  }
  clearFails(id) {
    this.fails.delete(id);
  }

  prune() {
    const now = Date.now();
    for (const [k, s] of Object.entries(this.d.sessions)) {
      if (now - s.createdAt > SESSION_DAYS * 86400_000 || !this.d.accounts[s.accountId]) delete this.d.sessions[k];
    }
    for (const [k, r] of Object.entries(this.d.resets)) if (now > r.expiresAt || !this.d.accounts[r.accountId]) delete this.d.resets[k];
    for (const [k, s] of Object.entries(this.d.signups)) {
      const end = s.revokedAt || s.expiresAt || 0;
      if (end && now - end > 90 * 86400_000) delete this.d.signups[k];
    }
  }
}
