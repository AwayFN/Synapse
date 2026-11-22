// Qui a le droit d'entrer : propriétaire, membres invités, invitations, sessions.
import path from 'node:path';
import { initialsOf, randomToken, readJsonFile, safeEqual, sha256, writeJsonAtomic } from './util.mjs';

/** Deux façons d'inviter : « peut regarder » (lecture) ou « peut modifier » (édition) */
export const ROLES = ['lecture', 'edition'];
const ROLE_LABEL = { lecture: 'peut regarder', edition: 'peut modifier', owner: 'propriétaire' };
/** anciennes invitations « contribution » : elles deviennent « peut modifier » */
const cleanRole = (r) => (r === 'lecture' ? 'lecture' : 'edition');
const SESSION_DAYS = 180;

/** « de Léa », « d’Arthur » */
export function deName(name) {
  return /^[aeiouyhàâäéèêëîïôöùûüœ]/i.test(name) ? `d’${name}` : `de ${name}`;
}

export function cleanName(name, fallback = 'Invité') {
  const s = String(name ?? '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .trim()
    .slice(0, 40);
  return s || fallback;
}

/** Même normalisation que les tags de l'application (minuscules, sans accents) */
export function normalizeTag(t) {
  return String(t ?? '')
    .replace(/^#+/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_\-/]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function cleanScope(scope) {
  if (!scope || scope.all !== false) return { all: true, tags: [] };
  const tags = Array.isArray(scope.tags) ? [...new Set(scope.tags.map(normalizeTag).filter(Boolean))].slice(0, 20) : [];
  return tags.length ? { all: false, tags } : { all: true, tags: [] };
}

export class Access {
  constructor(dir, log = () => {}) {
    this.file = path.join(dir, 'acces.json');
    this.log = log;
    const d = readJsonFile(this.file) || {};
    this.d = {
      ownerName: typeof d.ownerName === 'string' ? d.ownerName : '',
      brainName: typeof d.brainName === 'string' ? d.brainName : '',
      members: d.members && typeof d.members === 'object' ? d.members : {},
      invites: d.invites && typeof d.invites === 'object' ? d.invites : {},
      sessions: d.sessions && typeof d.sessions === 'object' ? d.sessions : {},
      share: { lan: !!d.share?.lan, internet: !!d.share?.internet },
    };
    // plus de zones ni de rôle « contribution » : chacun voit tout le cerveau, et le modifie ou le regarde
    for (const x of [...Object.values(this.d.members), ...Object.values(this.d.invites)]) {
      if (!x || typeof x !== 'object') continue;
      x.role = cleanRole(x.role);
      x.scope = { all: true, tags: [] };
    }
    this.timer = null;
    this.pruneSessions();
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
      this.log(`acces.json: ${e.message}`);
    }
  }

  // ── identité
  get ownerName() {
    return this.d.ownerName || 'Propriétaire';
  }
  get brainName() {
    return this.d.brainName || `Cerveau ${deName(this.ownerName)}`;
  }
  setNames({ ownerName, brainName }) {
    if (ownerName !== undefined) this.d.ownerName = cleanName(ownerName, '');
    if (brainName !== undefined) this.d.brainName = cleanName(brainName, '').slice(0, 60);
    this.save();
  }
  get owner() {
    return { id: 'owner', name: this.ownerName, role: 'owner', scope: { all: true, tags: [] } };
  }

  // ── membres
  member(id) {
    if (id === 'owner') return this.owner;
    const m = this.d.members[id];
    return m && !m.revokedAt ? m : null;
  }
  memberPublic(m) {
    return { id: m.id, name: m.name, initials: initialsOf(m.name), role: m.role, scope: m.scope, revoked: !!m.revokedAt, account: !!m.accountId };
  }
  /** Le membre lié à un compte Synapse (s'il a rejoint ce cerveau avec son compte) */
  memberByAccount(accountId) {
    if (!accountId) return null;
    return Object.values(this.d.members).find((m) => m.accountId === accountId && !m.revokedAt) || null;
  }
  /** Tout le monde, anciens membres compris (pour savoir « qui a écrit quoi ») */
  membersPublic() {
    return [this.memberPublic(this.owner), ...Object.values(this.d.members).map((m) => this.memberPublic(m))];
  }
  membersDetailed() {
    return Object.values(this.d.members)
      .filter((m) => !m.revokedAt)
      .map((m) => ({
        ...this.memberPublic(m),
        createdAt: m.createdAt,
        lastSeen: m.lastSeen || null,
        inviteId: m.inviteId || null,
        accountId: m.accountId || null,
        // son lien personnel : il le rouvre pour revenir (autre appareil, nouvelle adresse Internet)
        linkToken: this.backLinkOf(m),
      }));
  }
  updateMember(id, patch) {
    const m = this.member(id);
    if (!m || id === 'owner') return null;
    if (patch.role !== undefined && ROLES.includes(patch.role)) m.role = patch.role;
    if (patch.name !== undefined) m.name = cleanName(patch.name, m.name);
    this.save();
    return m;
  }
  revokeMember(id) {
    const m = this.d.members[id];
    if (!m) return false;
    m.revokedAt = Date.now();
    for (const [k, s] of Object.entries(this.d.sessions)) if (s.memberId === id) delete this.d.sessions[k];
    this.save();
    return true;
  }
  touchMember(id) {
    const m = this.d.members[id];
    if (!m) return;
    const now = Date.now();
    if (!m.lastSeen || now - m.lastSeen > 60_000) {
      m.lastSeen = now;
      this.save();
    }
  }

  // ── invitations
  createInvite({ name, role, scope, ttlHours, multi }) {
    const id = randomToken(6);
    const inv = {
      id,
      token: randomToken(24),
      name: cleanName(name, ''),
      role: ROLES.includes(role) ? role : 'edition',
      scope: cleanScope(scope && { all: true }),
      multi: !!multi,
      uses: 0,
      createdAt: Date.now(),
      expiresAt: Number(ttlHours) > 0 ? Date.now() + Number(ttlHours) * 3600_000 : null,
      revokedAt: null,
    };
    this.d.invites[id] = inv;
    this.save();
    return inv;
  }
  inviteByToken(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    for (const inv of Object.values(this.d.invites)) if (safeEqual(inv.token, token)) return inv;
    return null;
  }
  inviteState(inv) {
    if (!inv) return 'unknown';
    if (inv.revokedAt) return 'revoked';
    if (inv.expiresAt && Date.now() > inv.expiresAt) return 'expired';
    if (!inv.multi && inv.uses >= 1) return 'used';
    return 'ok';
  }
  /**
   * Une invitation pour une seule personne, déjà utilisée : la personne qui l'a utilisée peut revenir avec
   * le même lien (autre appareil, nouvelle adresse Internet après un redémarrage), tant que son accès n'est
   * pas retiré. Seul ce lien, que le propriétaire lui a envoyé, permet de revenir à sa place.
   */
  backMember(inv) {
    if (!inv || inv.multi || inv.revokedAt || inv.uses < 1) return null;
    return Object.values(this.d.members).find((m) => m.inviteId === inv.id && !m.revokedAt) || null;
  }
  backLinkOf(m) {
    const inv = m?.inviteId ? this.d.invites[m.inviteId] : null;
    return inv && this.backMember(inv)?.id === m.id ? inv.token : null;
  }
  inviteInfo(token) {
    const inv = this.inviteByToken(token);
    const state = this.inviteState(inv);
    const back = state === 'ok' ? null : this.backMember(inv);
    if (state !== 'ok' && !back) return { ok: false, reason: state, ownerName: this.ownerName };
    const src = back || inv;
    return {
      ok: true,
      ownerName: this.ownerName,
      brainName: this.brainName,
      role: src.role,
      roleLabel: ROLE_LABEL[src.role],
      scope: src.scope,
      name: back ? back.name : inv.name,
      ...(back ? { back: back.accountId ? 'account' : 'guest' } : {}),
    };
  }
  invitesPublic() {
    return Object.values(this.d.invites)
      .filter((i) => this.inviteState(i) === 'ok')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((i) => ({ id: i.id, token: i.token, name: i.name, role: i.role, scope: i.scope, multi: i.multi, uses: i.uses, createdAt: i.createdAt, expiresAt: i.expiresAt }));
  }
  revokeInvite(id) {
    const inv = this.d.invites[id];
    if (!inv) return false;
    inv.revokedAt = Date.now();
    this.save();
    return true;
  }

  /** Utilise une invitation : crée le membre et sa session (le jeton de session n'est stocké que haché) */
  join(token, name) {
    const inv = this.inviteByToken(token);
    const state = this.inviteState(inv);
    const back = state === 'ok' ? null : this.backMember(inv);
    if (back) {
      // il revient : même membre (son nom, son rôle, ce qu'il a écrit), nouvelle session pour cet appareil
      if (back.accountId) return { error: 'account' };
      const session = randomToken(32);
      this.d.sessions[sha256(session)] = { memberId: back.id, createdAt: Date.now() };
      back.lastSeen = Date.now();
      this.save();
      this.log(`back ${back.id} (${back.role})`);
      return { member: back, session, back: true };
    }
    if (state !== 'ok') return { error: state };
    inv.uses++;
    const id = randomToken(8);
    const m = {
      id,
      name: cleanName(name, inv.name || 'Invité'),
      role: inv.role,
      scope: inv.scope,
      inviteId: inv.id,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      revokedAt: null,
    };
    this.d.members[id] = m;
    const session = randomToken(32);
    this.d.sessions[sha256(session)] = { memberId: id, createdAt: Date.now() };
    this.save();
    this.log(`join ${id} (${m.role})`);
    return { member: m, session };
  }

  /** Rejoindre avec son compte Synapse : pas de session propre, le compte suffit (et le suit partout) */
  joinAccount(token, account) {
    const existing = this.memberByAccount(account.id);
    if (existing) return { member: existing, already: true };
    const inv = this.inviteByToken(token);
    const state = this.inviteState(inv);
    if (state !== 'ok') return { error: state };
    inv.uses++;
    const id = randomToken(8);
    const m = {
      id,
      name: cleanName(account.name, inv.name || 'Invité'),
      role: inv.role,
      scope: inv.scope,
      inviteId: inv.id,
      accountId: account.id,
      createdAt: Date.now(),
      lastSeen: Date.now(),
      revokedAt: null,
    };
    this.d.members[id] = m;
    this.save();
    this.log(`join ${id} (${m.role}, compte)`);
    return { member: m };
  }

  sessionMember(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const s = this.d.sessions[sha256(token)];
    if (!s) return null;
    if (Date.now() - s.createdAt > SESSION_DAYS * 86400_000) return null;
    return this.member(s.memberId);
  }
  endSession(token) {
    delete this.d.sessions[sha256(token)];
    this.save();
  }
  pruneSessions() {
    const now = Date.now();
    for (const [k, s] of Object.entries(this.d.sessions)) {
      if (now - s.createdAt > SESSION_DAYS * 86400_000 || !this.d.members[s.memberId] || this.d.members[s.memberId].revokedAt) {
        delete this.d.sessions[k];
      }
    }
  }

  // ── partage voulu (repris au prochain démarrage)
  get share() {
    return this.d.share;
  }
  setShare(patch) {
    Object.assign(this.d.share, patch);
    this.save();
  }
}
