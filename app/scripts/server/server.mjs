// Serveur Synapse (V4) : sert l'application, garde le cerveau de chacun, le partage, et donne au créateur
// une vue d'ensemble de son serveur (l'espace créateur).
//
// Qui est qui :
//   - sur le PC qui fait tourner Synapse, une requête de cet ordinateur (boucle locale, adressée à « localhost »,
//     sans intermédiaire) est le créateur : il n'a rien à saisir ;
//   - un compte = un cookie de session (HttpOnly), obtenu en se connectant (e-mail + mot de passe) ;
//   - un invité sans compte = un cookie propre à un cerveau, obtenu avec un lien d'invitation.
// Chaque compte a son cerveau ; il peut y inviter d'autres personnes (avec ou sans compte), avec un rôle et une zone.
// Toute requête qui modifie quelque chose exige l'en-tête « X-Synapse: 1 » (protection CSRF).
//
// Mode hébergé (SYNAPSE_HEBERGE=1, voir scripts/serveur-public.mjs) : pas de créateur « local » ; le compte
// créateur se crée une fois, avec le lien d'installation écrit dans le journal du serveur.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Access, cleanName, deName } from './access.mjs';
import { Accounts, checkPassword, cleanEmail, hashPassword, isStaff, passwordProblem, SERVER_ROLES } from './accounts.mjs';
import { Brain } from './brain.mjs';
import { Hub } from './hub.mjs';
import { cleanUrl, Settings } from './settings.mjs';
import { Share } from './share.mjs';
import { dayKey, maskIp, Telemetry } from './telemetry.mjs';
import {
  CSP,
  RateLimiter,
  SECURITY_HEADERS,
  clientAddress,
  dataDir,
  dirSize,
  isHttps,
  isLoopback,
  isProxied,
  json,
  parseCookies,
  randomToken,
  readJson,
  readJsonFile,
  safeEqual,
} from './util.mjs';

export const PROTO = 4;
const ACCOUNT_COOKIE = 'synapse_a';
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Avec un accès ouvert, le serveur reste allumé ; il s'arrête après 6 h sans aucune fenêtre ouverte */
const SHARE_IDLE_MS = Number(process.env.SYNAPSE_SHARE_IDLE_MS) || 6 * 3600_000;
const DAY = 86400_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

/** Nature d'un neurone (pour les statistiques : seulement la grande famille, jamais le contenu) */
const NATURE_OF = {
  tache: 'action',
  projet: 'action',
  objectif: 'action',
  habitude: 'action',
  creneau: 'temps',
  'rendez-vous': 'temps',
  rdv: 'temps',
  evenement: 'temps',
  reunion: 'temps',
  rappel: 'temps',
  personne: 'monde',
  livre: 'monde',
  article: 'monde',
  film: 'monde',
  podcast: 'monde',
  lien: 'monde',
  ressource: 'monde',
  lieu: 'monde',
};
const kindKey = (k) =>
  String(k || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
const natureOf = (e, kinds) => {
  const k = kindKey(e?.kind);
  return kinds?.[k]?.nature || kinds?.[e?.kind]?.nature || NATURE_OF[k] || 'pensee';
};

const LIMITS = { '/api/import': 80_000_000, '/api/ops': 6_000_000, '/api/layout': 10_000_000 };

export function startServer({ port, host, dist, idleMs, firstMs, log, stamp = () => '', hosted: hostedOpt }) {
  const hosted = !!hostedOpt || process.env.SYNAPSE_HEBERGE === '1';
  const root = dataDir();
  const settings = new Settings(root, log);
  const accounts = new Accounts(root, log);
  const tele = new Telemetry(root, log);
  const started = Date.now();
  const alive = new Set();
  const servers = [];
  let hadClient = false;
  let lastActivity = Date.now();
  let stopping = false;
  const limit = {
    join: new RateLimiter(30, 60_000),
    ops: new RateLimiter(800, 10_000),
    login: new RateLimiter(20, 10 * 60_000),
    signup: new RateLimiter(15, 10 * 60_000),
    errors: new RateLimiter(30, 10 * 60_000),
    feedback: new RateLimiter(10, 10 * 60_000),
  };
  const publicUrl = () => cleanUrl(process.env.SYNAPSE_URL_PUBLIQUE || '') || settings.d.publicUrl || '';

  // ───────────────────────── V3 → V4 : le cerveau unique devient celui du compte créateur
  function migrateV3() {
    if (hosted || accounts.count() > 0) return;
    const legacy = readJsonFile(path.join(root, 'acces.json')) || {};
    const a = accounts.create({ name: legacy.ownerName || '', role: 'createur', via: 'local' });
    const dir = path.join(root, 'cerveaux', a.brainId);
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(root, 'ancien-v3');
    let moved = 0;
    for (const f of ['cerveau.json', 'acces.json', 'sauvegardes']) {
      const src = path.join(root, f);
      if (!fs.existsSync(src)) continue;
      try {
        fs.cpSync(src, path.join(dir, f), { recursive: true });
        fs.mkdirSync(old, { recursive: true });
        fs.renameSync(src, path.join(old, f));
        moved++;
      } catch (e) {
        log(`migration ${f}: ${e.message}`);
      }
    }
    settings.set({ legacyBrain: a.brainId, share: { lan: !!legacy.share?.lan, internet: !!legacy.share?.internet } });
    accounts.flush();
    settings.flush();
    log(moved ? `migration V3 → V4 : cerveau de ${a.name || 'créateur'} (${a.brainId})` : `nouveau serveur : compte créateur ${a.brainId}`);
  }
  migrateV3();

  /** Comptes supprimés : leur cerveau attend 30 jours dans la corbeille, puis disparaît */
  function purgeTrash() {
    const t = path.join(root, 'corbeille');
    let list = [];
    try {
      list = fs.readdirSync(t);
    } catch {
      return;
    }
    for (const name of list) {
      const m = name.match(/(\d{4}-\d{2}-\d{2})$/);
      if (m && Date.now() - new Date(`${m[1]}T00:00:00`).getTime() > 30 * DAY) {
        try {
          fs.rmSync(path.join(t, name), { recursive: true, force: true });
        } catch {}
      }
    }
  }
  purgeTrash();

  let setupToken = null;
  if (hosted && !accounts.creator()) {
    setupToken = process.env.SYNAPSE_SETUP_TOKEN || randomToken(18);
    const line = `INSTALLATION : ouvre ${publicUrl() || `http://localhost:${port}`}/#installation=${setupToken} pour créer le compte créateur`;
    log(line);
  }

  // ───────────────────────── cerveaux (chargés à la demande)
  const entries = new Map();
  function entry(brainId) {
    if (typeof brainId !== 'string' || !/^[A-Za-z0-9_-]{6,40}$/.test(brainId)) return null;
    const hit = entries.get(brainId);
    if (hit) {
      hit.used = Date.now();
      return hit;
    }
    const owner = accounts.byBrain(brainId);
    if (!owner) return null;
    const dir = path.join(root, 'cerveaux', brainId);
    fs.mkdirSync(dir, { recursive: true });
    const access = new Access(dir, log);
    const brain = new Brain(dir, log);
    if (owner.name && access.d.ownerName !== owner.name) access.setNames({ ownerName: owner.name });
    const hub = new Hub({ brain, access, log, id: brainId, onView: (v, s) => tele.view(v, s) });
    const e = { id: brainId, ownerId: owner.id, access, brain, hub, used: Date.now() };
    brain.onSaved = () => {
      const c = { ...brain.counts(), members: access.membersDetailed().length, invites: access.invitesPublic().length };
      const p = accounts.get(owner.id)?.stats;
      if (!p || p.n !== c.n || p.l !== c.l || p.priv !== c.priv || p.members !== c.members || p.invites !== c.invites || Math.abs(p.bytes - c.bytes) > 2048)
        accounts.setStats(owner.id, c);
    };
    entries.set(brainId, e);
    if (brain.exists && !owner.stats) brain.onSaved();
    return e;
  }
  function unloadIdle() {
    const now = Date.now();
    for (const [id, e] of entries) {
      if (e.hub.size || e.hub.closing.size || now - e.used < 20 * 60_000) continue;
      if (e.brain.timer) e.brain.saveNow();
      if (e.access.timer) e.access.flush();
      e.hub.dispose();
      entries.delete(id);
    }
  }
  const brainCard = (e, role) => ({ id: e.id, name: e.access.brainName, ownerName: e.access.ownerName, role, mine: role === 'owner' });

  // ───────────────────────── partage (PC du créateur seulement)
  function shareStatus(e) {
    const pcBrain = !!share && e.ownerId === accounts.creator()?.id;
    const st = pcBrain
      ? share.status()
      : { lan: { on: false, urls: [], error: null }, internet: { state: 'off', url: null, error: null, progress: 0, toolReady: false, fixed: false } };
    return {
      ...st,
      manageAccess: pcBrain,
      brainId: e.id,
      invites: e.access.invitesPublic().map((i) => ({ ...i, token: `${e.id}.${i.token}` })),
      members: e.access.membersDetailed(),
      ownerName: e.access.ownerName,
      ownerNameSet: !!e.access.d.ownerName,
      brainName: e.access.brainName,
      dataDir: pcBrain ? root : '',
      online: e.hub.presenceFor({ member: e.access.owner, visible: new Set() }).map((p) => p.id),
      publicUrl: publicUrl() || null,
    };
  }
  const notifyShare = () => {
    const c = accounts.creator();
    const e = c && entries.get(c.brainId);
    if (e) e.hub.toOwners('share', shareStatus(e));
  };
  const share = hosted
    ? null
    : new Share({
        port,
        dataDir: root,
        handler: (req, res) => handler(req, res),
        log,
        onChange: () => notifyShare(),
        tunnel: () => ({ token: settings.d.tunnelToken, url: publicUrl() }),
      });

  // ───────────────────────── qui fait la requête
  const hostnameOf = (req) => {
    const h = String(req.headers.host || '').toLowerCase();
    return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  };
  const isLocalOwner = (req) => !hosted && isLoopback(req.socket.remoteAddress) && LOCAL_NAMES.has(hostnameOf(req)) && !isProxied(req);

  function who(req) {
    const cookies = parseCookies(req.headers.cookie);
    const local = isLocalOwner(req);
    let account = null;
    let sessionHash = null;
    let suspended = false;
    if (local) account = accounts.creator();
    else if (cookies[ACCOUNT_COOKIE]) {
      const r = accounts.session(cookies[ACCOUNT_COOKIE]);
      if (r) {
        account = r.account;
        sessionHash = r.hash;
      }
    }
    if (account && account.status === 'suspendu' && !local) {
      suspended = true;
      account = null;
    }
    if (account) {
      accounts.touch(account);
      tele.active(account.id);
    }
    return { local, account, cookies, sessionHash, suspended, ip: clientAddress(req, hosted), via: share ? share.via(req) : 'internet' };
  }

  function memberOf(e, w) {
    if (w.account) {
      if (w.account.brainId === e.id) return e.access.owner;
      const m = e.access.memberByAccount(w.account.id);
      if (m) {
        e.access.touchMember(m.id);
        return m;
      }
    }
    const tok = w.cookies[`sg_${e.id}`] || (e.id === settings.d.legacyBrain ? w.cookies.synapse_s : undefined);
    if (tok) {
      const m = e.access.sessionMember(tok);
      if (m && !m.accountId) {
        e.access.touchMember(m.id);
        tele.guest(`${e.id}:${m.id}`);
        return m;
      }
    }
    return null;
  }

  /** Les cerveaux qu'un invité sans compte a rejoints (d'après ses cookies) */
  function guestBrains(w) {
    const out = [];
    const seen = new Set();
    const add = (bid, tok) => {
      if (seen.has(bid)) return;
      const e = entry(bid);
      const m = e?.access.sessionMember(tok);
      if (!e || !m || m.accountId) return;
      seen.add(bid);
      out.push(brainCard(e, m.role));
    };
    for (const [k, v] of Object.entries(w.cookies)) if (k.startsWith('sg_')) add(k.slice(3), v);
    if (w.cookies.synapse_s && settings.d.legacyBrain) add(settings.d.legacyBrain, w.cookies.synapse_s);
    return out;
  }
  function brainsOf(a) {
    const out = [];
    const own = entry(a.brainId);
    if (own) out.push(brainCard(own, 'owner'));
    for (const bid of [...a.shared]) {
      const e = entry(bid);
      const m = e?.access.memberByAccount(a.id);
      if (!e || !m) {
        accounts.removeShared(a.id, bid);
        continue;
      }
      out.push(brainCard(e, m.role));
    }
    return out;
  }
  function targetBrain(w, url) {
    const b = url.searchParams.get('b');
    if (b) return entry(b);
    if (w.account) return entry(w.account.brainId);
    const g = guestBrains(w)[0];
    return g ? entry(g.id) : null;
  }
  /** « idCerveau.jeton » (V4) ou ancien jeton seul (liens V3 : le cerveau du créateur) */
  function inviteTarget(raw) {
    const s = String(raw || '').slice(0, 160);
    const i = s.indexOf('.');
    if (i > 0) return { e: entry(s.slice(0, i)), token: s.slice(i + 1) };
    return { e: settings.d.legacyBrain ? entry(settings.d.legacyBrain) : null, token: s };
  }

  const cookieAttrs = (req, days) => `Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(days * 86400)}${isHttps(req) ? '; Secure' : ''}`;
  const sessionCookie = (req, token) => `${ACCOUNT_COOKIE}=${token}; ${cookieAttrs(req, 90)}`;
  const dropCookie = (name) => `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

  const accountSelf = (a, w) => ({
    id: a.id,
    name: a.name,
    email: a.email,
    role: a.role,
    hasPassword: !!a.pass,
    brainId: a.brainId,
    createdAt: a.createdAt,
    local: !!w.local,
    staff: isStaff(a),
  });

  function serverInfo(w) {
    const s = settings.d;
    const creator = accounts.creator();
    const used = w.account ? accounts.signupsCreatedBy(w.account.id, 30 * DAY).length : 0;
    return {
      hosted,
      name: s.appName || 'Synapse',
      registration: s.registration,
      setup: hosted && !creator,
      creatorName: creator?.name || '',
      maintenance: s.maintenance.on ? s.maintenance.message || '' : null,
      announcement: s.announcement.text ? { id: s.announcement.id, text: s.announcement.text, level: s.announcement.level } : null,
      terms: !!String(s.terms || '').trim(),
      invite:
        w.account && s.registration !== 'fermee' && (isStaff(w.account) || s.membersCanInvite)
          ? { left: isStaff(w.account) ? null : Math.max(0, s.memberInviteQuota - used) }
          : null,
      publicUrl: w.account ? publicUrl() || null : null,
      internetUrl: w.account && share && share.net.state === 'on' ? share.net.url : null,
    };
  }

  // ───────────────────────── vue d'ensemble pour l'espace créateur
  function onlineNow() {
    const on = new Set();
    let guests = 0;
    let windows = 0;
    for (const e of entries.values()) {
      for (const c of e.hub.clients.values()) {
        windows++;
        const id = c.accountId || c.member.accountId;
        if (id) on.add(id);
        else guests++;
      }
    }
    return { accounts: on, guests, windows };
  }
  function brainStats(a) {
    const live = entries.get(a.brainId);
    const e = live || (a.stats ? null : entry(a.brainId));
    if (e) return { ...e.brain.counts(), members: e.access.membersDetailed().length, invites: e.access.invitesPublic().length };
    return a.stats || { n: 0, l: 0, priv: 0, bytes: 0, members: 0, invites: 0 };
  }
  let sizeCache = { at: 0, bytes: 0 };
  const storage = () => {
    if (Date.now() - sizeCache.at > 60_000) sizeCache = { at: Date.now(), bytes: Math.max(0, dirSize(root) - dirSize(path.join(root, 'outils'))) };
    return sizeCache.bytes;
  };
  function broadcastAll(event, data, filter) {
    for (const e of entries.values()) e.hub.writeAll(event, data, filter);
  }
  function kickAccount(accountId, reason, except = null) {
    for (const e of entries.values()) e.hub.kickWhere((c) => (c.accountId === accountId || c.member.accountId === accountId) && c.id !== except, reason);
  }
  function staffPing() {
    const data = { feedback: tele.unreadFeedback(), errors: tele.errorsSince(DAY), accounts: accounts.count() };
    broadcastAll('staff', data, (c) => isStaff(accounts.get(c.accountId)));
  }

  function overview() {
    const list = accounts.list();
    const now = Date.now();
    const on = onlineNow();
    let neurons = 0;
    let links = 0;
    let nonEmpty = 0;
    let sharedBrains = 0;
    let members = 0;
    let invites = 0;
    for (const a of list) {
      const st = brainStats(a);
      neurons += st.n || 0;
      links += st.l || 0;
      if (st.n) nonEmpty++;
      if (st.members) sharedBrains++;
      members += st.members || 0;
      invites += st.invites || 0;
    }
    return {
      accounts: {
        total: list.length,
        createurs: list.filter((a) => a.role === 'createur').length,
        admins: list.filter((a) => a.role === 'admin').length,
        membres: list.filter((a) => a.role === 'membre').length,
        suspendus: list.filter((a) => a.status === 'suspendu').length,
        new7: list.filter((a) => now - a.createdAt < 7 * DAY).length,
        new30: list.filter((a) => now - a.createdAt < 30 * DAY).length,
      },
      active: { today: tele.uniqueActive(1), d7: tele.uniqueActive(7), d30: tele.uniqueActive(30) },
      online: { accounts: on.accounts.size, guests: on.guests, windows: on.windows },
      content: { brains: list.length, nonEmpty, neurons, links, shared: sharedBrains, members, invites },
      storage: storage(),
      feedback: { unread: tele.unreadFeedback(), total: tele.feedbackList().length },
      errors: { day: tele.errorsSince(DAY), total: tele.errorsList().length },
      signups: { registration: settings.d.registration, open: accounts.signupsList().filter((s) => s.state === 'ok').length },
      series: tele.series(30),
      views: tele.viewTotals(30),
      natures: tele.natureTotals(30),
      server: { hosted, uptime: now - started, build: stamp(), node: process.version },
    };
  }
  function usersList() {
    const on = onlineNow();
    return accounts
      .list()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((a) => {
        const st = brainStats(a);
        const sessions = accounts.sessionsOf(a.id);
        return {
          id: a.id,
          name: a.name,
          email: a.email,
          role: a.role,
          status: a.status,
          createdAt: a.createdAt,
          lastSeen: a.lastSeen,
          via: a.via,
          invitedBy: a.invitedBy ? accounts.get(a.invitedBy)?.name || null : null,
          hasPassword: !!a.pass,
          brain: { n: st.n || 0, l: st.l || 0, bytes: st.bytes || 0, members: st.members || 0 },
          joined: a.shared.length,
          sessions: sessions.length,
          device: sessions[0]?.ua || '',
          activeDays: tele.activeDaysOf(a.id, 30),
          online: on.accounts.has(a.id),
        };
      });
  }
  function serverDetails(w) {
    const mem = process.memoryUsage();
    return {
      hosted,
      proto: PROTO,
      build: stamp(),
      node: process.version,
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      started,
      uptime: Date.now() - started,
      memory: mem.rss,
      storage: storage(),
      dataDir: w.local ? root : null,
      brainsLoaded: entries.size,
      windows: onlineNow().windows,
      share: share ? share.status() : null,
      publicUrl: publicUrl() || null,
      envPublicUrl: !!process.env.SYNAPSE_URL_PUBLIQUE,
    };
  }

  /** Nom d'un compte changé : il suit partout (son cerveau, ceux qu'il a rejoints) */
  function renameEverywhere(a) {
    const own = entry(a.brainId);
    if (own) {
      own.access.setNames({ ownerName: a.name });
      own.hub.refreshMember('owner');
      own.hub.membersChanged();
      own.hub.brainChanged();
    }
    for (const bid of a.shared) {
      const e = entry(bid);
      const m = e?.access.memberByAccount(a.id);
      if (!m) continue;
      e.access.updateMember(m.id, { name: a.name });
      e.hub.refreshMember(m.id);
      e.hub.membersChanged();
    }
  }

  /** Suppression d'un compte : déconnexion partout, cerveau à la corbeille (30 jours), accès retirés */
  function deleteAccount(a, by) {
    kickAccount(a.id, 'deleted');
    const e = entries.get(a.brainId);
    if (e) {
      e.hub.closeAll('deleted');
      if (e.brain.timer) e.brain.saveNow();
      e.access.flush();
      e.hub.dispose();
      entries.delete(a.brainId);
    }
    for (const bid of a.shared) {
      const x = entry(bid);
      const m = x?.access.memberByAccount(a.id);
      if (!m) continue;
      x.access.revokeMember(m.id);
      x.hub.refreshMember(m.id);
      x.hub.membersChanged();
    }
    for (const other of accounts.list()) if (other.shared.includes(a.brainId)) accounts.removeShared(other.id, a.brainId);
    const dir = path.join(root, 'cerveaux', a.brainId);
    if (fs.existsSync(dir)) {
      try {
        fs.mkdirSync(path.join(root, 'corbeille'), { recursive: true });
        fs.renameSync(dir, path.join(root, 'corbeille', `${a.brainId}-${dayKey()}`));
      } catch (err) {
        log(`corbeille ${a.brainId}: ${err.message}`);
      }
    }
    accounts.remove(a.id);
    tele.event('compte', by ? `${by.name} a supprimé le compte de ${a.name}` : `${a.name} a supprimé son compte`, by);
  }

  const shutdown = (why) => {
    if (stopping) return;
    stopping = true;
    log(`stop (${why})`);
    try {
      for (const e of entries.values()) {
        e.brain.saveNow();
        e.access.flush();
      }
      accounts.flush();
      settings.flush();
      tele.flush();
    } catch {}
    for (const e of entries.values()) e.hub.closeAll();
    share?.stopAll();
    for (const c of alive) c.end();
    for (const s of servers) s.close();
    setTimeout(() => process.exit(0), 300);
  };

  // ───────────────────────── API
  async function api(req, res, pathname, url) {
    const post = req.method === 'POST';
    const send = (status, obj, extra) => json(req, res, status, obj, extra);
    if (post && req.headers['x-synapse'] !== '1') return send(403, { error: 'csrf' });
    const body = post ? await readJson(req, LIMITS[pathname] || 64_000) : {};
    const w = who(req);
    const staff = isStaff(w.account);
    const maint = settings.d.maintenance.on && !staff;
    const mustPost = () => (post ? false : (send(405, { error: 'method' }), true));

    // ── public
    if (pathname === '/api/health') return send(200, { ok: true, proto: PROTO });
    if (pathname === '/api/hello') {
      tele.bump('vis');
      const e = maint ? null : targetBrain(w, url);
      const m = e ? memberOf(e, w) : null;
      const isOwner = m?.role === 'owner';
      return send(200, {
        app: 'synapse',
        proto: PROTO,
        build: stamp(),
        server: serverInfo(w),
        local: w.local,
        account: w.account ? accountSelf(w.account, w) : null,
        suspended: w.suspended || undefined,
        brains: maint ? [] : w.account ? brainsOf(w.account) : guestBrains(w),
        brain: e && m ? { id: e.id, name: e.access.brainName, ownerName: e.access.ownerName } : null,
        auth: m ? (isOwner ? 'owner' : 'member') : 'none',
        role: m?.role ?? null,
        me: m ? { id: m.id, name: m.name } : null,
        empty: isOwner ? !e.brain.exists : undefined,
      });
    }
    if (pathname === '/api/terms') {
      const name = accounts.creator()?.name || 'le créateur de Synapse';
      return send(200, { text: String(settings.d.terms || '').replaceAll('{createur}', name), at: settings.d.termsAt });
    }
    if (pathname === '/api/errors') {
      if (mustPost()) return;
      if (limit.errors.hit(w.ip)) {
        tele.addError({ source: 'client', message: body.message, stack: body.stack, where: body.where, version: body.version || stamp(), ua: req.headers['user-agent'], who: w.account?.id || null });
        staffPing();
      }
      return send(200, { ok: true });
    }

    // ── invitations à un cerveau
    if (pathname === '/api/invite/info' || pathname === '/api/join') {
      if (mustPost()) return;
      if (!limit.join.hit(w.ip)) return send(429, { error: 'trop de tentatives' });
      const { e, token } = inviteTarget(body.token);
      if (pathname === '/api/invite/info') {
        if (!e) return send(200, { ok: false, reason: 'unknown', ownerName: '' });
        const info = e.access.inviteInfo(token);
        const already = w.account ? (w.account.brainId === e.id ? 'owner' : e.access.memberByAccount(w.account.id) ? 'member' : null) : null;
        const reg = settings.d.registration;
        return send(200, {
          ...info,
          brainId: e.id,
          already,
          signup: !!info.ok && reg !== 'fermee' && (reg === 'ouverte' || settings.d.brainInvitesAllowSignup),
          appName: settings.d.appName,
        });
      }
      if (!e) return send(400, { error: 'unknown' });
      if (maint) return send(503, { error: 'maintenance' });
      if (!e.brain.exists) return send(409, { error: 'closed' });
      if (body.asAccount) {
        if (!w.account) return send(401, { error: 'auth' });
        if (w.account.brainId === e.id) return send(200, { ok: true, brainId: e.id, already: true });
        const r = e.access.joinAccount(token, w.account);
        if (r.error) return send(400, { error: r.error });
        accounts.addShared(w.account.id, e.id);
        e.hub.membersChanged();
        e.hub.toOwners('share', shareStatus(e));
        if (!r.already) tele.event('cerveau', `${w.account.name} rejoint le cerveau ${deName(e.access.ownerName)} (${r.member.role})`, w.account);
        return send(200, { ok: true, brainId: e.id });
      }
      const r = e.access.join(token, body.name);
      if (r.error) return send(400, { error: r.error });
      e.hub.membersChanged();
      e.hub.toOwners('share', shareStatus(e));
      tele.event('cerveau', `${r.member.name} (sans compte) rejoint le cerveau ${deName(e.access.ownerName)} (${r.member.role})`, null, maskIp(w.ip));
      return send(200, { ok: true, brainId: e.id, me: { id: r.member.id, name: r.member.name }, role: r.member.role }, { 'Set-Cookie': `sg_${e.id}=${r.session}; ${cookieAttrs(req, 180)}` });
    }

    // ── comptes : inscription, connexion, installation, mot de passe oublié
    if (pathname === '/api/signup/info') {
      if (mustPost()) return;
      if (!limit.join.hit(w.ip)) return send(429, { error: 'trop de tentatives' });
      const inv = accounts.signupByToken(String(body.code || ''));
      const state = accounts.signupState(inv);
      return send(200, {
        ok: state === 'ok' && settings.d.registration !== 'fermee',
        reason: settings.d.registration === 'fermee' ? 'closed' : state,
        note: state === 'ok' ? inv.note : '',
        from: state === 'ok' ? accounts.get(inv.createdBy)?.name || '' : '',
        appName: settings.d.appName,
      });
    }
    if (pathname === '/api/auth/signup') {
      if (mustPost()) return;
      if (!limit.signup.hit(w.ip)) return send(429, { error: 'trop de tentatives' });
      if (!accounts.creator()) return send(409, { error: 'setup' });
      if (maint) return send(503, { error: 'maintenance' });
      const name = cleanName(body.name, '');
      const email = cleanEmail(body.email);
      const pp = passwordProblem(body.password);
      if (!name) return send(400, { error: 'name' });
      if (!email) return send(400, { error: 'email' });
      if (pp) return send(400, { error: 'password', message: pp });
      if (String(settings.d.terms || '').trim() && !body.terms) return send(400, { error: 'terms' });
      if (settings.d.maxAccounts > 0 && accounts.count() >= settings.d.maxAccounts) return send(403, { error: 'full' });
      const reg = settings.d.registration;
      if (reg === 'fermee') return send(403, { error: 'closed' });
      let via = 'ouverte';
      let invitedBy = null;
      let code = null;
      let brainJoin = null;
      if (body.code) {
        code = accounts.signupByToken(String(body.code));
        const st = accounts.signupState(code);
        if (st !== 'ok') return send(400, { error: 'code', reason: st });
        via = 'invitation';
        invitedBy = code.createdBy;
      }
      if (body.invite) {
        const t = inviteTarget(body.invite);
        if (!t.e || t.e.access.inviteState(t.e.access.inviteByToken(t.token)) !== 'ok') return send(400, { error: 'invite' });
        brainJoin = t;
      }
      if (reg === 'invitation' && !code && !(brainJoin && settings.d.brainInvitesAllowSignup)) return send(403, { error: 'invitation' });
      if (brainJoin && !code) {
        via = 'cerveau';
        invitedBy = brainJoin.e.ownerId;
      }
      if (accounts.byEmail(email)) return send(409, { error: 'exists' });
      const pass = await hashPassword(body.password);
      if (accounts.byEmail(email)) return send(409, { error: 'exists' });
      const a = accounts.create({ name, email, pass, role: 'membre', via, invitedBy });
      if (code) accounts.useSignup(code, a.id);
      if (brainJoin) {
        const r = brainJoin.e.access.joinAccount(brainJoin.token, a);
        if (!r.error) {
          accounts.addShared(a.id, brainJoin.e.id);
          brainJoin.e.hub.membersChanged();
          brainJoin.e.hub.toOwners('share', shareStatus(brainJoin.e));
        }
      }
      const token = accounts.newSession(a.id, { ua: req.headers['user-agent'], via: w.via });
      tele.bump('su');
      tele.active(a.id);
      const how = via === 'invitation' ? 'avec une invitation' : via === 'cerveau' ? 'invité dans un cerveau' : 'inscription libre';
      tele.event('inscription', `${a.name} a créé son compte (${how})`, a, maskIp(w.ip));
      staffPing();
      return send(200, { ok: true, brainId: brainJoin?.e.id || a.brainId }, { 'Set-Cookie': sessionCookie(req, token) });
    }
    if (pathname === '/api/auth/login') {
      if (mustPost()) return;
      if (!limit.login.hit(w.ip)) return send(429, { error: 'trop de tentatives' });
      const a = accounts.byEmail(body.email);
      const mins = a ? accounts.locked(a.id) : 0;
      if (mins) return send(429, { error: 'locked', minutes: mins });
      const ok = await checkPassword(String(body.password ?? ''), a?.pass);
      if (!a || !ok) {
        if (a) accounts.failed(a.id);
        tele.event('echec', `connexion refusée${a ? ` (${a.name})` : ' (adresse inconnue)'}`, a || null, maskIp(w.ip));
        return send(401, { error: 'invalid' });
      }
      if (a.status === 'suspendu') return send(403, { error: 'suspended' });
      if (settings.d.maintenance.on && !isStaff(a)) return send(503, { error: 'maintenance' });
      accounts.clearFails(a.id);
      const token = accounts.newSession(a.id, { ua: req.headers['user-agent'], via: w.via });
      tele.bump('log');
      tele.active(a.id);
      tele.event('connexion', `connexion de ${a.name}`, a, maskIp(w.ip));
      return send(200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token) });
    }
    if (pathname === '/api/auth/logout') {
      if (mustPost()) return;
      if (w.cookies[ACCOUNT_COOKIE]) accounts.endSession(w.cookies[ACCOUNT_COOKIE]);
      return send(200, { ok: true }, { 'Set-Cookie': dropCookie(ACCOUNT_COOKIE) });
    }
    if (pathname === '/api/auth/setup') {
      if (mustPost()) return;
      if (!limit.login.hit(w.ip)) return send(429, { error: 'trop de tentatives' });
      if (!hosted || accounts.creator() || !setupToken || !safeEqual(String(body.token || ''), setupToken)) return send(403, { error: 'setup' });
      const name = cleanName(body.name, '');
      const email = cleanEmail(body.email);
      const pp = passwordProblem(body.password);
      if (!name) return send(400, { error: 'name' });
      if (!email) return send(400, { error: 'email' });
      if (pp) return send(400, { error: 'password', message: pp });
      const pass = await hashPassword(body.password);
      if (accounts.creator()) return send(403, { error: 'setup' });
      const a = accounts.create({ name, email, pass, role: 'createur', via: 'installation' });
      setupToken = null;
      accounts.flush();
      tele.event('serveur', `compte créateur créé : ${a.name}`, a, maskIp(w.ip));
      const token = accounts.newSession(a.id, { ua: req.headers['user-agent'], via: w.via });
      return send(200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token) });
    }
    if (pathname === '/api/auth/reset/info' || pathname === '/api/auth/reset') {
      if (mustPost()) return;
      if (!limit.login.hit(w.ip)) return send(429, { error: 'trop de tentatives' });
      const r = accounts.reset(body.token);
      if (pathname === '/api/auth/reset/info') return send(200, r ? { ok: true, name: r.account.name, email: r.account.email } : { ok: false });
      if (!r) return send(400, { error: 'invalid' });
      const pp = passwordProblem(body.password);
      if (pp) return send(400, { error: 'password', message: pp });
      r.account.pass = await hashPassword(body.password);
      accounts.consumeReset(r.hash);
      accounts.endAll(r.account.id);
      accounts.clearFails(r.account.id);
      kickAccount(r.account.id, 'logout');
      tele.event('compte', `mot de passe réinitialisé : ${r.account.name}`, r.account, maskIp(w.ip));
      const token = accounts.newSession(r.account.id, { ua: req.headers['user-agent'], via: w.via });
      return send(200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token) });
    }

    // ── connexion d'un autre appareil (téléphone) par le QR code créé sur un appareil déjà connecté
    if (pathname === '/api/auth/device') {
      if (mustPost()) return;
      if (!limit.login.hit(w.ip)) return send(429, { error: 'trop de tentatives' });
      const r = accounts.loginLink(body.token);
      if (!r) return send(400, { error: 'invalid' });
      if (r.account.status === 'suspendu') return send(403, { error: 'suspended' });
      if (settings.d.maintenance.on && !isStaff(r.account)) return send(503, { error: 'maintenance' });
      accounts.consumeLoginLink(r.hash);
      const token = accounts.newSession(r.account.id, { ua: req.headers['user-agent'], via: w.via });
      tele.bump('log');
      tele.active(r.account.id);
      tele.event('connexion', `connexion de ${r.account.name || 'créateur'} sur un autre appareil (QR code)`, r.account, maskIp(w.ip));
      return send(200, { ok: true }, { 'Set-Cookie': sessionCookie(req, token) });
    }

    // ── retours (idées, problèmes) : comptes et invités
    if (pathname === '/api/feedback') {
      if (mustPost()) return;
      if (!limit.feedback.hit(w.account?.id || w.ip)) return send(429, { error: 'trop de retours' });
      let from = null;
      if (w.account) from = { id: w.account.id, name: w.account.name || 'créateur', role: w.account.role, account: true };
      else {
        const e = targetBrain(w, url);
        const m = e && memberOf(e, w);
        if (m) from = { id: m.id, name: m.name, role: 'invité', account: false };
      }
      if (!from) return send(401, { error: 'auth' });
      const text = String(body.text || '').trim();
      if (text.length < 3) return send(400, { error: 'text' });
      tele.addFeedback({ kind: body.kind, text, from, view: body.view, version: stamp(), ua: req.headers['user-agent'] });
      staffPing();
      return send(200, { ok: true });
    }

    // ── mon compte
    if (pathname.startsWith('/api/account/') || pathname === '/api/signup/invite') {
      if (mustPost()) return;
      const a = w.account;
      if (!a) return send(401, { error: 'auth' });
      switch (pathname) {
        case '/api/account/update': {
          const changes = [];
          if (body.name !== undefined) {
            const n = cleanName(body.name, '');
            if (!n && !w.local) return send(400, { error: 'name' });
            if (n !== a.name) {
              a.name = n;
              changes.push('nom');
            }
          }
          if (body.email !== undefined) {
            const em = body.email === '' ? '' : cleanEmail(body.email);
            if (body.email !== '' && !em) return send(400, { error: 'email' });
            if (!em && a.pass) return send(400, { error: 'email' });
            const other = em ? accounts.byEmail(em) : null;
            if (other && other.id !== a.id) return send(409, { error: 'exists' });
            if (em !== a.email) {
              a.email = em;
              changes.push('e-mail');
            }
          }
          if (body.password !== undefined) {
            const pp = passwordProblem(body.password);
            if (pp) return send(400, { error: 'password', message: pp });
            if (!a.email) return send(400, { error: 'email-first' });
            if (a.pass && !w.local && !(await checkPassword(String(body.current ?? ''), a.pass))) return send(401, { error: 'current' });
            a.pass = await hashPassword(body.password);
            accounts.endAll(a.id, w.sessionHash);
            changes.push('mot de passe');
          }
          accounts.save();
          if (changes.includes('nom')) renameEverywhere(a);
          if (changes.length) tele.event('compte', `${a.name || 'créateur'} a modifié son compte (${changes.join(', ')})`, a);
          return send(200, { ok: true, account: accountSelf(a, w) });
        }
        case '/api/account/device-link': {
          const token = accounts.createLoginLink(a.id);
          tele.event('compte', `${a.name || 'créateur'} a affiché un QR code pour se connecter sur un autre appareil`, a);
          return send(200, { token, expiresIn: 600 });
        }
        case '/api/account/logout-all': {
          const n = accounts.endAll(a.id, w.sessionHash);
          kickAccount(a.id, 'logout', typeof body.clientId === 'string' ? body.clientId : null);
          return send(200, { ok: true, sessions: n });
        }
        case '/api/account/leave': {
          const e = entry(String(body.b || ''));
          const m = e?.access.memberByAccount(a.id);
          if (e && m) {
            e.access.revokeMember(m.id);
            e.hub.refreshMember(m.id, 'left');
            e.hub.membersChanged();
            e.hub.toOwners('share', shareStatus(e));
            tele.event('cerveau', `${a.name} a quitté le cerveau ${deName(e.access.ownerName)}`, a);
          }
          accounts.removeShared(a.id, String(body.b || ''));
          return send(200, { ok: true });
        }
        case '/api/account/delete': {
          if (a.role === 'createur' && accounts.activeCreators().length <= 1) return send(409, { error: 'last-creator' });
          if (a.pass && !w.local && !(await checkPassword(String(body.password ?? ''), a.pass))) return send(401, { error: 'current' });
          if (body.confirm !== 'SUPPRIMER') return send(400, { error: 'confirm' });
          deleteAccount(a, null);
          staffPing();
          return send(200, { ok: true }, { 'Set-Cookie': dropCookie(ACCOUNT_COOKIE) });
        }
        case '/api/signup/invite': {
          const s = settings.d;
          if (s.registration === 'fermee') return send(409, { error: 'closed' });
          if (!staff && !s.membersCanInvite) return send(403, { error: 'invite' });
          const used = accounts.signupsCreatedBy(a.id, 30 * DAY).length;
          if (!staff && used >= s.memberInviteQuota) return send(429, { error: 'quota', quota: s.memberInviteQuota });
          const inv = accounts.createSignup({ note: body.note, maxUses: 1, ttlHours: 24 * 7, createdBy: a.id });
          tele.event('inscription', `${a.name || 'créateur'} a créé une invitation à Synapse${inv.note ? ` (pour ${inv.note})` : ''}`, a);
          return send(200, { token: inv.token, left: staff ? null : Math.max(0, s.memberInviteQuota - used - 1) });
        }
      }
      return send(404, { error: 'not found' });
    }

    // ── espace créateur
    if (pathname.startsWith('/api/admin/')) {
      if (!staff) return send(403, { error: 'staff' });
      return adminApi(req, res, pathname, w, body, url, send);
    }

    // ── tout le reste concerne un cerveau
    if (w.suspended) return send(401, { error: 'suspended' });
    const e = targetBrain(w, url);
    const m = e ? memberOf(e, w) : null;
    if (!e || !m) return send(401, { error: 'auth' });
    if (maint) return send(503, { error: 'maintenance' });
    const isOwner = m.role === 'owner';
    const extra = { via: w.via, accountId: w.account?.id || null };

    switch (pathname) {
      case '/api/events': {
        if (!e.brain.exists) return send(409, { error: 'empty' });
        hadClient = true;
        const c = e.hub.connect(req, res, m, url.searchParams.get('c'), extra);
        req.on('close', () => {
          lastActivity = Date.now();
        });
        if (isOwner) e.hub.write(c, 'share', shareStatus(e));
        if (staff) e.hub.write(c, 'staff', { feedback: tele.unreadFeedback(), errors: tele.errorsSince(DAY), accounts: accounts.count() });
        return;
      }
      case '/api/poll': {
        if (!e.brain.exists) return send(409, { error: 'empty' });
        hadClient = true;
        const cid = url.searchParams.get('c');
        let c = e.hub.find(cid);
        if (url.searchParams.get('init') === '1') {
          c = e.hub.connectPoll(m, cid, extra);
          if (isOwner) e.hub.write(c, 'share', shareStatus(e));
          if (staff) e.hub.write(c, 'staff', { feedback: tele.unreadFeedback(), errors: tele.errorsSince(DAY), accounts: accounts.count() });
        } else if (!c || (!c.closed && c.member.id !== m.id)) return send(409, { error: 'reconnect' });
        req.on('close', () => {
          lastActivity = Date.now();
        });
        return e.hub.poll(req, res, c);
      }
      case '/api/ops': {
        if (mustPost()) return;
        if (!e.brain.exists) return send(409, { error: 'empty' });
        if (!limit.ops.hit(`${e.id}:${m.id}`)) return send(429, { error: 'trop de changements' });
        const r = e.brain.apply(m, body.ops, { maxEntities: settings.d.maxNeurons });
        if (r.accepted.length) {
          e.hub.broadcast({ seq: r.seq, by: m.id, ops: r.accepted }, typeof body.clientId === 'string' ? body.clientId : null);
          tele.bump('ops', r.accepted.length);
          for (const op of r.accepted) if (op.t === 'put') tele.capture(natureOf(op.e, e.brain.s.kinds));
        }
        return send(200, { seq: r.seq, rejected: r.rejected, fixes: r.fixes });
      }
      case '/api/presence': {
        if (mustPost()) return;
        e.hub.setPresence(String(body.clientId || ''), m, body);
        return send(200, {});
      }
      case '/api/leave': {
        if (mustPost()) return;
        if (m.accountId) {
          e.access.revokeMember(m.id);
          accounts.removeShared(m.accountId, e.id);
          e.hub.refreshMember(m.id, 'left');
          e.hub.membersChanged();
          return send(200, { ok: true });
        }
        const tok = w.cookies[`sg_${e.id}`];
        if (tok && !isOwner) e.access.endSession(tok);
        return send(200, { ok: true }, { 'Set-Cookie': dropCookie(`sg_${e.id}`) });
      }
    }

    if (!isOwner) return send(403, { error: 'owner' });

    switch (pathname) {
      case '/api/import': {
        if (mustPost()) return;
        if (body.mode === 'initial' && e.brain.exists) return send(409, { error: 'exists', seq: e.brain.seq });
        const n = Object.keys(body.entities || {}).length;
        if (settings.d.maxNeurons > 0 && n > settings.d.maxNeurons) return send(413, { error: 'limit', max: settings.d.maxNeurons });
        const seq = e.brain.importState(body);
        e.hub.resetAll();
        log(`import (${body.mode}) ${Object.keys(e.brain.s.entities).length} neurones · ${e.id}`);
        return send(200, { seq });
      }
      case '/api/layout': {
        if (mustPost()) return;
        e.brain.setLayout(body.positions);
        return send(200, {});
      }
      case '/api/share':
        return send(200, shareStatus(e));
      case '/api/share/settings': {
        if (mustPost()) return;
        if (body.brainName !== undefined) e.access.setNames({ brainName: body.brainName });
        if (body.ownerName !== undefined && w.account) {
          const n = cleanName(body.ownerName, '');
          if (n !== w.account.name && (n || w.local)) {
            w.account.name = n;
            accounts.save();
            renameEverywhere(w.account);
          }
        }
        e.hub.brainChanged();
        return send(200, shareStatus(e));
      }
      case '/api/invites': {
        if (mustPost()) return;
        const inv = e.access.createInvite(body);
        return send(200, { invite: { id: inv.id, token: `${e.id}.${inv.token}` }, ...shareStatus(e) });
      }
      case '/api/invites/revoke': {
        if (mustPost()) return;
        e.access.revokeInvite(String(body.id));
        return send(200, shareStatus(e));
      }
      case '/api/members/update': {
        if (mustPost()) return;
        e.access.updateMember(String(body.id), { role: body.role, scope: body.scope });
        e.hub.refreshMember(String(body.id));
        e.hub.membersChanged();
        return send(200, shareStatus(e));
      }
      case '/api/members/revoke': {
        if (mustPost()) return;
        const target = e.access.d.members[String(body.id)];
        e.access.revokeMember(String(body.id));
        if (target?.accountId) accounts.removeShared(target.accountId, e.id);
        e.hub.refreshMember(String(body.id));
        e.hub.membersChanged();
        return send(200, shareStatus(e));
      }
    }

    // ── accès au serveur (Wi-Fi, Internet) : seulement devant le PC du créateur
    if (!w.local || !share || w.account?.role !== 'createur') return send(403, { error: 'local' });
    switch (pathname) {
      case '/api/share/lan': {
        if (mustPost()) return;
        if (body.on) await share.startLan();
        else {
          share.stopLan();
          for (const x of entries.values()) x.hub.kickWhere((c) => c.via === 'lan', 'closed');
        }
        settings.set({ share: { lan: !!body.on && share.lan.on } });
        tele.event('partage', body.on ? (share.lan.on ? 'accès Wi-Fi ouvert' : 'accès Wi-Fi impossible') : 'accès Wi-Fi fermé', w.account);
        return send(200, shareStatus(e));
      }
      case '/api/share/internet': {
        if (mustPost()) return;
        if (body.on) await share.startInternet(!!body.consent);
        else {
          share.stopInternet();
          for (const x of entries.values()) x.hub.kickWhere((c) => c.via === 'internet', 'closed');
        }
        settings.set({ share: { internet: !!body.on && share.net.state === 'on' } });
        tele.event('partage', body.on ? (share.net.state === 'on' ? `accès Internet ouvert (${share.net.url})` : 'accès Internet impossible') : 'accès Internet fermé', w.account);
        return send(200, shareStatus(e));
      }
      case '/api/share/stop': {
        if (mustPost()) return;
        share.stopAll();
        settings.set({ share: { lan: false, internet: false } });
        // tout le monde dehors, sauf les fenêtres du créateur sur ce PC
        for (const x of entries.values()) x.hub.kickWhere((c) => !(c.via === 'local' && c.accountId === w.account.id), 'closed');
        tele.event('partage', 'tous les accès fermés', w.account);
        return send(200, shareStatus(e));
      }
      case '/api/data-folder': {
        if (mustPost()) return;
        if (process.platform === 'win32') spawn('explorer.exe', [root], { detached: true, stdio: 'ignore' }).unref();
        return send(200, { path: root });
      }
    }
    return send(404, { error: 'not found' });
  }

  // ───────────────────────── API de l'espace créateur (comptes créateur et admin)
  async function adminApi(req, res, pathname, w, body, url, send) {
    const me = w.account;
    const post = req.method === 'POST';
    const isCreator = me.role === 'createur';
    const needCreator = () => (isCreator ? false : (send(403, { error: 'createur' }), true));
    const target = () => accounts.get(String(body.id || ''));
    /** Un admin gère les membres ; seul un créateur gère les admins et les créateurs */
    const canManage = (t) => isCreator || t.role === 'membre';

    if (!post) {
      switch (pathname) {
        case '/api/admin/overview':
          return send(200, overview());
        case '/api/admin/users':
          return send(200, { users: usersList() });
        case '/api/admin/signups':
          return send(200, { signups: accounts.signupsList() });
        case '/api/admin/feedback':
          return send(200, { items: tele.feedbackList() });
        case '/api/admin/errors':
          return send(200, { items: tele.errorsList() });
        case '/api/admin/journal':
          return send(200, { items: tele.journal(url.searchParams.get('type') || '', 500) });
        case '/api/admin/settings':
          return send(200, settings.public());
        case '/api/admin/server':
          return send(200, serverDetails(w));
      }
      return send(404, { error: 'not found' });
    }

    switch (pathname) {
      case '/api/admin/users/update': {
        const t = target();
        if (!t) return send(404, { error: 'missing' });
        if (!canManage(t) || (body.role && body.role !== 'membre' && !isCreator)) return send(403, { error: 'createur' });
        const what = [];
        if (body.role !== undefined && body.role !== t.role) {
          if (!SERVER_ROLES.includes(body.role)) return send(400, { error: 'role' });
          if (t.role === 'createur' && accounts.activeCreators().length <= 1) return send(409, { error: 'last-creator' });
          t.role = body.role;
          what.push(`rôle ${body.role}`);
        }
        if (body.status !== undefined && body.status !== t.status) {
          if (!['actif', 'suspendu'].includes(body.status)) return send(400, { error: 'status' });
          if (t.id === me.id) return send(409, { error: 'self' });
          if (t.role === 'createur' && body.status === 'suspendu' && accounts.activeCreators().length <= 1) return send(409, { error: 'last-creator' });
          t.status = body.status;
          what.push(body.status === 'suspendu' ? 'suspendu' : 'réactivé');
          if (body.status === 'suspendu') {
            accounts.endAll(t.id);
            kickAccount(t.id, 'suspended');
          }
        }
        accounts.save();
        if (what.length) tele.event('admin', `${me.name || 'créateur'} → ${t.name} : ${what.join(', ')}`, me);
        return send(200, { users: usersList() });
      }
      case '/api/admin/users/delete': {
        const t = target();
        if (!t) return send(404, { error: 'missing' });
        if (t.id === me.id) return send(409, { error: 'self' });
        if (!canManage(t)) return send(403, { error: 'createur' });
        if (t.role === 'createur' && accounts.activeCreators().length <= 1) return send(409, { error: 'last-creator' });
        deleteAccount(t, me);
        return send(200, { users: usersList() });
      }
      case '/api/admin/users/reset': {
        const t = target();
        if (!t) return send(404, { error: 'missing' });
        if (!canManage(t)) return send(403, { error: 'createur' });
        if (!t.email) return send(409, { error: 'email' });
        const token = accounts.createReset(t.id, me.id);
        tele.event('admin', `${me.name || 'créateur'} a créé un lien de nouveau mot de passe pour ${t.name}`, me);
        return send(200, { token });
      }
      case '/api/admin/users/logout': {
        const t = target();
        if (!t) return send(404, { error: 'missing' });
        if (!canManage(t)) return send(403, { error: 'createur' });
        const n = accounts.endAll(t.id);
        kickAccount(t.id, 'logout');
        tele.event('admin', `${me.name || 'créateur'} a déconnecté ${t.name} partout (${n} session${n > 1 ? 's' : ''})`, me);
        return send(200, { users: usersList() });
      }
      case '/api/admin/signups': {
        const inv = accounts.createSignup({ note: body.note, maxUses: body.maxUses, ttlHours: body.ttlHours, createdBy: me.id });
        tele.event('inscription', `${me.name || 'créateur'} a créé une invitation à Synapse${inv.note ? ` (${inv.note})` : ''}`, me);
        return send(200, { invite: { id: inv.id, token: inv.token }, signups: accounts.signupsList() });
      }
      case '/api/admin/signups/revoke': {
        accounts.revokeSignup(String(body.id || ''));
        return send(200, { signups: accounts.signupsList() });
      }
      case '/api/admin/feedback/update': {
        tele.updateFeedback(String(body.id || ''), body.status);
        staffPing();
        return send(200, { items: tele.feedbackList() });
      }
      case '/api/admin/feedback/delete': {
        tele.deleteFeedback(String(body.id || ''));
        staffPing();
        return send(200, { items: tele.feedbackList() });
      }
      case '/api/admin/errors/clear': {
        tele.clearErrors();
        staffPing();
        return send(200, { items: [] });
      }
      case '/api/admin/announce': {
        const text = String(body.text || '')
          .trim()
          .slice(0, 280);
        const a = { id: text ? randomToken(4) : '', text, level: body.level === 'important' ? 'important' : 'info', at: Date.now() };
        settings.set({ announcement: a });
        broadcastAll('announce', text ? { id: a.id, text: a.text, level: a.level } : null);
        tele.event('admin', text ? `${me.name || 'créateur'} a publié une annonce` : `${me.name || 'créateur'} a retiré l'annonce`, me);
        return send(200, settings.public());
      }
      case '/api/admin/maintenance': {
        if (needCreator()) return;
        settings.set({ maintenance: { on: !!body.on, message: body.message } });
        if (body.on) for (const e of entries.values()) e.hub.kickWhere((c) => !isStaff(accounts.get(c.accountId)), 'maintenance');
        tele.event('admin', body.on ? `${me.name || 'créateur'} a activé la maintenance` : `${me.name || 'créateur'} a terminé la maintenance`, me);
        return send(200, settings.public());
      }
      case '/api/admin/settings': {
        if (needCreator()) return;
        const { announcement: _a, maintenance: _m, share: _s, legacyBrain: _l, ...patch } = body || {};
        const changed = settings.set(patch);
        if (changed.length) tele.event('admin', `${me.name || 'créateur'} a modifié les réglages (${changed.join(', ')})`, me);
        return send(200, settings.public());
      }
    }
    return send(404, { error: 'not found' });
  }

  // ───────────────────────── fichiers de l'application
  const sendFile = (req, res, file, st) => {
    const immutable = file.startsWith(path.join(dist, 'assets') + path.sep);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...SECURITY_HEADERS,
      ...(type.startsWith('text/html') ? { 'Content-Security-Policy': CSP } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  };

  /** Noms d'hôte acceptés (anti « DNS rebinding ») */
  function hostAllowed(hostname) {
    if (LOCAL_NAMES.has(hostname)) return true;
    if (share && share.allowedHost(hostname)) return true;
    const pu = publicUrl();
    if (pu && new URL(pu).hostname === hostname) return true;
    if ((process.env.SYNAPSE_EXTRA_HOSTS || '').split(',').filter(Boolean).includes(hostname)) return true;
    // hébergé sans adresse déclarée : rien de « local » à protéger, on accepte
    return hosted && !pu;
  }

  function handler(req, res) {
    lastActivity = Date.now();
    let url;
    let pathname;
    try {
      url = new URL(req.url, 'http://localhost');
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    // vérification de santé de l'hébergeur : quelle que soit l'adresse utilisée
    if (pathname === '/api/health') return json(req, res, 200, { ok: true, proto: PROTO });
    if (!hostAllowed(hostnameOf(req))) {
      res.writeHead(403);
      return res.end();
    }

    if (pathname.startsWith('/__')) {
      // outils internes du lanceur : réservés à cet ordinateur
      if (!isLocalOwner(req)) {
        res.writeHead(404);
        return res.end();
      }
      if (pathname === '/__synapse') {
        let clients = alive.size;
        let guests = 0;
        for (const e of entries.values()) {
          clients += e.hub.size;
          guests += e.hub.guests();
        }
        return json(req, res, 200, {
          app: 'synapse',
          proto: PROTO,
          pid: process.pid,
          root: dist,
          clients,
          guests,
          sharing: share?.active || false,
          since: started,
          build: stamp(),
        });
      }
      if (pathname === '/__alive') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 2000\n\n');
        alive.add(res);
        hadClient = true;
        req.on('close', () => {
          alive.delete(res);
          lastActivity = Date.now();
        });
        return;
      }
      if (pathname === '/__quit') {
        if (req.method !== 'POST' || req.headers['x-synapse'] !== 'quit') {
          res.writeHead(403);
          return res.end();
        }
        res.writeHead(200);
        res.end('bye');
        return shutdown('quit');
      }
      res.writeHead(404);
      return res.end();
    }

    if (pathname.startsWith('/api/')) {
      api(req, res, pathname, url).catch((e) => {
        log(`api ${pathname}: ${e.message}`);
        if (!e.status || e.status >= 500) tele.addError({ source: 'serveur', message: `${pathname} : ${e.message}`, stack: e.stack, version: stamp() });
        if (!res.headersSent) json(req, res, e.status || 500, { error: e.status ? e.message : 'server' });
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }

    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(dist, rel);
    const hidden = rel.split(/[\\/]/).some((seg) => seg.startsWith('.'));
    if (rel.includes('\0') || hidden || !file.startsWith(dist + path.sep)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    fs.stat(file, (err, st) => {
      if (!err && st.isFile()) return sendFile(req, res, file, st);
      if (!path.extname(rel)) {
        const index = path.join(dist, 'index.html');
        return fs.stat(index, (e2, st2) => {
          if (e2) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Synapse : dist/index.html introuvable');
          }
          sendFile(req, res, index, st2);
        });
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
    });
  }

  const listen = (h) =>
    new Promise((resolve, reject) => {
      const s = http.createServer(handler);
      s.once('error', reject);
      s.listen(port, h, () => {
        s.removeListener('error', reject);
        s.on('error', (e) => log(`server error ${h}: ${e.message}`));
        servers.push(s);
        resolve();
      });
    });

  process.on('uncaughtException', (e) => {
    log(`crash: ${e.stack || e}`);
    try {
      tele.addError({ source: 'serveur', message: `plantage : ${e.message}`, stack: e.stack, version: stamp() });
      for (const x of entries.values()) {
        x.brain.saveNow();
        x.access.flush();
      }
      accounts.flush();
      settings.flush();
      tele.flush();
    } catch {}
    process.exit(1);
  });
  if (hosted) {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  const extra = (process.env.SYNAPSE_LISTEN_EXTRA || '').split(',').filter(Boolean);
  const first = hosted ? host || process.env.SYNAPSE_HOST || '0.0.0.0' : '127.0.0.1';

  listen(first)
    .catch((e) => {
      log(`cannot listen on ${first}:${port}: ${e.code}`);
      process.exit(e.code === 'EADDRINUSE' ? 3 : 2);
    })
    .then(() => (hosted ? null : listen('::1').catch((e) => log(`::1 not available (${e.code})`))))
    .then(() => Promise.all(extra.map((h) => listen(h).catch((e) => log(`extra ${h}: ${e.code}`)))))
    .then(async () => {
      log(`start - ${dist} - port ${port} - données ${root} - ${hosted ? 'hébergé' : 'PC'} - node ${process.version}`);
      // les accès reprennent tels qu'ils étaient (l'adresse Internet gratuite, elle, change)
      if (share) {
        if (settings.d.share.lan) await share.startLan();
        if (settings.d.share.internet && share.toolReady()) share.startInternet(false);
      }
      const tick = Math.min(5000, Math.max(250, (idleMs || 60_000) / 4));
      let lastPing = Date.now();
      let lastUnload = Date.now();
      setInterval(() => {
        const now = Date.now();
        const on = onlineNow();
        tele.peak(on.accounts.size + on.guests);
        if (now - lastPing > 20_000) {
          lastPing = now;
          for (const c of alive) c.write(': ping\n\n');
          for (const e of entries.values()) e.hub.ping();
        }
        if (now - lastUnload > 60_000) {
          lastUnload = now;
          unloadIdle();
        }
        if (hosted) return;
        if (alive.size + on.windows > 0) return;
        const idle = now - lastActivity;
        if (share.active) {
          if (idle > SHARE_IDLE_MS) shutdown('partage inactif');
        } else if (idle > (hadClient ? idleMs : firstMs)) {
          shutdown(hadClient ? 'all windows closed' : 'no window connected');
        }
      }, tick);
    });
}
