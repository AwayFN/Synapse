// Diffusion en direct, pour un cerveau : chaque fenêtre ouverte reçoit les changements qu'elle a le droit
// de voir, et la présence des autres participants. Deux façons d'être branché, même contenu, même ordre :
//   - un flux continu (Server-Sent Events) : sur cet ordinateur, en Wi-Fi, chez un hébergeur ;
//   - des requêtes « en attente » (long polling), quand un intermédiaire retient le flux continu : c'est le
//     cas des adresses gratuites trycloudflare.com, qui ne laissent pas passer les Server-Sent Events.
import { initialsOf, json, randomToken } from './util.mjs';

const VIEWS = new Set(['network', 'agenda', 'tasks', 'notes']);
/** Une requête en attente revient vide au bout de ce délai (bien en dessous des 100 s de Cloudflare) */
const POLL_HOLD_MS = 25_000;
/** Sans nouvelle requête depuis ce délai, la fenêtre est considérée comme fermée */
const POLL_GONE_MS = 70_000;
const QUEUE_MAX = 4000;
const rightsKey = (m) => m.role;

export class Hub {
  constructor({ brain, access, log, id = '', onView }) {
    this.brain = brain;
    this.access = access;
    this.log = log;
    this.id = id;
    this.onView = onView || (() => {});
    /** clientId → { id, kind:'sse'|'poll', res|queue, member, visible:Set, presence, via, accountId } */
    this.clients = new Map();
    /** fenêtres « en attente » renvoyées (au revoir pas encore lu) */
    this.closing = new Map();
    this.presenceTimer = null;
    this.sweeper = setInterval(() => this.sweep(), 10_000);
    this.sweeper.unref?.();
  }

  get size() {
    return this.clients.size;
  }
  guests() {
    return [...this.clients.values()].filter((c) => c.member.id !== 'owner').length;
  }
  find(clientId) {
    return this.clients.get(clientId) || this.closing.get(clientId) || null;
  }

  write(c, event, data, id) {
    if (c.closed) return;
    if (c.kind === 'poll') {
      if (c.queue.length >= QUEUE_MAX) {
        // trop de retard (fenêtre en veille) : elle repartira d'un état complet
        c.queue = [];
        c.overflow = true;
      }
      if (!c.overflow) c.queue.push({ e: event, d: data, i: id ?? null });
      this.flushPoll(c);
      return;
    }
    try {
      c.res.write(`${id != null ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* connexion déjà fermée */
    }
  }

  /** Répond à la requête en attente s'il y a quelque chose à livrer */
  flushPoll(c, force = false) {
    const w = c.waiting;
    if (!w) return;
    if (!force && !c.queue.length && !c.overflow && !c.closed) return;
    c.waiting = null;
    clearTimeout(c.holdTimer);
    const events = c.queue;
    c.queue = [];
    const overflow = !!c.overflow;
    c.overflow = false;
    try {
      json(w.req, w.res, 200, { events, overflow });
    } catch {}
    if (c.closed) this.closing.delete(c.id);
  }

  attach(kind, member, clientId, extra) {
    const id = typeof clientId === 'string' && /^[A-Za-z0-9_-]{6,40}$/.test(clientId) ? clientId : randomToken(8);
    const prev = this.clients.get(id);
    if (prev) this.detach(prev);
    this.closing.delete(id);
    const c = {
      id,
      kind,
      member,
      visible: new Set(),
      presence: { view: 'network', focus: null, editing: null, at: Date.now(), since: 0 },
      queue: [],
      waiting: null,
      lastPoll: Date.now(),
      ...extra,
    };
    this.clients.set(id, c);
    this.sendReset(c);
    this.presenceChanged();
    return c;
  }

  /** Débranche sans prévenir (remplacée par une nouvelle connexion de la même fenêtre) */
  detach(c) {
    this.clients.delete(c.id);
    if (c.kind === 'sse') {
      try {
        c.res.end();
      } catch {}
    } else if (c.waiting) {
      c.closed = true;
      this.flushPoll(c, true);
    }
  }

  connect(req, res, member, clientId, extra = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 4000\n\n');
    const c = this.attach('sse', member, clientId, { ...extra, res });
    req.on('close', () => {
      if (this.clients.get(c.id) === c) {
        this.clients.delete(c.id);
        this.presenceChanged();
      }
    });
    return c;
  }

  connectPoll(member, clientId, extra = {}) {
    return this.attach('poll', member, clientId, extra);
  }

  /** Une requête « en attente » : livre tout de suite ce qui attend, sinon patiente jusqu'à 25 s */
  poll(req, res, c) {
    c.lastPoll = Date.now();
    if (c.waiting) this.flushPoll(c, true);
    c.waiting = { req, res };
    if (c.queue.length || c.overflow || c.closed) return this.flushPoll(c);
    c.holdTimer = setTimeout(() => this.flushPoll(c, true), POLL_HOLD_MS);
    req.on('close', () => {
      if (c.waiting && c.waiting.res === res) {
        c.waiting = null;
        clearTimeout(c.holdTimer);
      }
    });
  }

  /** Ferme une fenêtre en lui disant pourquoi */
  end(c, bye) {
    if (bye) this.write(c, 'bye', bye);
    this.clients.delete(c.id);
    if (c.kind === 'sse') {
      try {
        c.res.end();
      } catch {}
      return;
    }
    c.closed = true;
    c.closedAt = Date.now();
    if (c.waiting) this.flushPoll(c);
    else this.closing.set(c.id, c);
  }

  sweep() {
    const now = Date.now();
    let changed = false;
    for (const c of [...this.clients.values()]) {
      if (c.kind === 'poll' && !c.waiting && now - c.lastPoll > POLL_GONE_MS) {
        this.clients.delete(c.id);
        changed = true;
      }
    }
    for (const c of [...this.closing.values()]) if (now - c.closedAt > 60_000) this.closing.delete(c.id);
    if (changed) this.presenceChanged();
  }

  /** État complet, filtré pour ce participant (au branchement, ou après un changement de droits) */
  sendReset(c) {
    const snap = this.brain.snapshot(c.member);
    c.visible = new Set(Object.keys(snap.entities));
    // les droits avec lesquels cet état a été calculé (l'objet membre est modifié sur place ailleurs)
    c.rights = rightsKey(c.member);
    this.write(
      c,
      'reset',
      {
        ...snap,
        clientId: c.id,
        brainId: this.id,
        me: { id: c.member.id, name: c.member.name, initials: initialsOf(c.member.name) },
        role: c.member.role,
        members: this.access.membersPublic(),
        brain: { id: this.id, name: this.access.brainName, ownerName: this.access.ownerName },
        presence: this.presenceFor(c),
      },
      snap.seq,
    );
  }

  /** Un élément tel qu'un invité le voit : le projet privé auquel il appartient reste caché */
  forMember(m, e) {
    if (m.role === 'owner' || !e.projectId) return e;
    const p = this.brain.s.entities[e.projectId];
    return p && this.brain.visible(m, p) ? e : { ...e, projectId: null };
  }

  /** Ce qu'un participant doit recevoir d'un lot de changements (avec les transitions de visibilité) */
  filterFor(c, ops) {
    const m = c.member;
    const S = this.brain.s;
    if (m.role === 'owner') return ops;
    const out = [];
    const reveal = (id) => {
      const e = S.entities[id];
      out.push({ t: 'put', e: this.forMember(m, e) });
      c.visible.add(id);
      for (const l of S.links) {
        const other = l.a === id ? l.b : l.b === id ? l.a : null;
        if (other && c.visible.has(other)) out.push({ t: 'link', l });
      }
    };
    for (const op of ops) {
      if (op.t === 'put' || op.t === 'patch') {
        const id = op.t === 'put' ? op.e.id : op.id;
        const e = S.entities[id];
        const now = !!e && this.brain.visible(m, e);
        const was = c.visible.has(id);
        if (now && !was) reveal(id);
        else if (now && was) {
          if (op.t === 'put') out.push({ t: 'put', e: this.forMember(m, e) });
          else {
            const { private: _p, ...f } = op.f;
            if (f.projectId && !this.brain.visible(m, S.entities[f.projectId])) f.projectId = null;
            out.push({ t: 'patch', id, f });
          }
        } else if (!now && was) {
          out.push({ t: 'del', id });
          c.visible.delete(id);
        }
      } else if (op.t === 'del') {
        if (c.visible.has(op.id)) {
          out.push(op);
          c.visible.delete(op.id);
        }
      } else if (op.t === 'link') {
        if (c.visible.has(op.l.a) && c.visible.has(op.l.b)) out.push(op);
      } else if (op.t === 'unlink') {
        // le lien a pu disparaître du serveur : on transmet si le participant le connaissait
        const l = S.links.find((x) => x.id === op.id);
        if (!l || (c.visible.has(l.a) && c.visible.has(l.b))) out.push(op);
      } else if (op.t === 'act') {
        if (this.brain.actVisible(m, op.a)) out.push(op);
      }
    }
    return out;
  }

  broadcast(batch, fromClientId) {
    for (const c of this.clients.values()) {
      const ops = this.filterFor(c, batch.ops);
      if (!ops.length) continue;
      this.write(c, 'batch', { seq: batch.seq, by: batch.by, clientId: fromClientId || null, ops }, batch.seq);
    }
  }
  /** Le même évènement pour toutes les fenêtres (annonce du créateur, par exemple) */
  writeAll(event, data, filter = () => true) {
    for (const c of this.clients.values()) if (filter(c)) this.write(c, event, data);
  }

  // ── présence
  setPresence(clientId, member, p) {
    const c = this.clients.get(clientId);
    if (!c || c.member.id !== member.id) return false;
    const vis = (id) => (typeof id === 'string' && this.brain.s && this.brain.visible(member, this.brain.s.entities[id]) ? id : null);
    const now = Date.now();
    // temps passé dans la vue précédente (statistiques d'usage, sans le contenu)
    this.onView(c.presence.view, Math.min(60, (now - c.presence.at) / 1000));
    let editing = member.role === 'owner' || member.role === 'edition' ? vis(p.editing) : null;
    // une seule personne écrit à la fois dans un élément : si quelqu'un d'autre le tient déjà, la demande attend
    const holder = editing ? this.lockHolder(editing) : null;
    if (holder && holder.memberId !== member.id) editing = null;
    c.presence = {
      view: VIEWS.has(p.view) ? p.view : 'network',
      focus: vis(p.focus),
      editing,
      at: now,
      since: editing ? (c.presence.editing === editing ? c.presence.since : now) : 0,
    };
    this.presenceChanged();
    return true;
  }

  /** Qui écrit en ce moment dans cet élément (le premier arrivé), ou null */
  lockHolder(entityId) {
    let best = null;
    for (const c of this.clients.values()) {
      if (c.presence.editing !== entityId) continue;
      if (!best || c.presence.since < best.presence.since) best = c;
    }
    return best ? { memberId: best.member.id, name: best.member.name, clientId: best.id } : null;
  }

  presenceFor(viewer) {
    const byMember = new Map();
    for (const c of this.clients.values()) {
      const cur = byMember.get(c.member.id);
      if (!cur || c.presence.at > cur.presence.at) byMember.set(c.member.id, c);
    }
    const out = [];
    for (const c of byMember.values()) {
      const S = this.brain.s;
      const see = (id) => (id && S && viewer.visible.has(id) ? id : viewer.member.role === 'owner' ? id : null);
      out.push({
        id: c.member.id,
        name: c.member.name,
        initials: initialsOf(c.member.name),
        role: c.member.role,
        view: c.presence.view,
        focus: see(c.presence.focus),
        editing: see(c.presence.editing),
        at: c.presence.at,
      });
    }
    return out;
  }

  presenceChanged() {
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      for (const c of this.clients.values()) this.write(c, 'presence', { online: this.presenceFor(c) });
    }, 150);
  }

  // ── gestion des accès en direct
  membersChanged() {
    const members = this.access.membersPublic();
    for (const c of this.clients.values()) this.write(c, 'members', { members });
  }
  brainChanged() {
    const brain = { id: this.id, name: this.access.brainName, ownerName: this.access.ownerName };
    for (const c of this.clients.values()) this.write(c, 'brain', brain);
  }
  refreshMember(memberId, reason = 'revoked') {
    const m = this.access.member(memberId);
    for (const c of [...this.clients.values()]) {
      if (c.member.id !== memberId) continue;
      if (!m) this.end(c, { reason });
      else if (memberId === 'owner' || c.rights === rightsKey(m)) {
        // simple changement de nom : rien à renvoyer
        c.member = m;
      } else {
        // nouveaux droits : le participant repart de l'état complet qu'il a désormais le droit de voir
        c.member = m;
        this.sendReset(c);
      }
    }
    this.presenceChanged();
  }
  /** Coupe les fenêtres qui répondent au critère */
  kickWhere(pred, reason) {
    let n = 0;
    for (const c of [...this.clients.values()]) {
      if (!pred(c)) continue;
      this.end(c, { reason });
      n++;
    }
    if (n) this.presenceChanged();
    return n;
  }
  kickGuests(reason) {
    return this.kickWhere((c) => c.member.id !== 'owner', reason);
  }
  /** Coupe les fenêtres arrivées par un accès qui vient d'être fermé (réseau local ou Internet) */
  kickVia(via, reason) {
    return this.kickWhere((c) => c.via === via && c.member.id !== 'owner', reason);
  }
  resetAll() {
    for (const c of this.clients.values()) this.sendReset(c);
  }
  toOwners(event, data) {
    for (const c of this.clients.values()) if (c.member.id === 'owner') this.write(c, event, data);
  }
  /**
   * Signe de vie toutes les 15 s, en vrai évènement : la fenêtre sait ainsi que la connexion tient. Sans nouvelles
   * pendant 45 s (passage du Wi-Fi au câble ou à la 4G, mise en veille), elle se rebranche toute seule.
   */
  ping() {
    const msg = `event: ping\ndata: {"t":${Date.now()}}\n\n`;
    for (const c of this.clients.values()) {
      if (c.kind !== 'sse') continue;
      try {
        c.res.write(msg);
      } catch {}
    }
  }
  closeAll(reason) {
    for (const c of [...this.clients.values()]) this.end(c, reason ? { reason } : null);
    for (const c of [...this.closing.values()]) if (c.waiting) this.flushPoll(c, true);
    this.clients.clear();
  }
  dispose() {
    clearInterval(this.sweeper);
    clearTimeout(this.presenceTimer);
  }
}
