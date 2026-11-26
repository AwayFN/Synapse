import type { Activity, Entity, Link } from '../types';
import { normalizeEntities, setDataReadOnly, useData } from '../store/data';
import { layout } from '../scene/layout';
import { useUI } from '../store/ui';
import { applySnapshot } from './ops';
import { initialsOf, useSession, type Account, type BrainCard, type Member, type Role, type ServerInfo } from './session';
import { standalone } from './remote';

/**
 * Synapse sur le téléphone (application Android V7) et sur un PC « client » (V7.1), même sans réseau.
 *
 * Le cerveau ouvert est gardé sur le téléphone (copie complète, mise à jour à chaque modification) avec ce qu'il faut
 * pour le rouvrir : le compte, ses cerveaux, le serveur. Sans réseau, ou quand le Synapse central ne répond pas (PC
 * du créateur éteint), l'application s'ouvre quand même sur cette copie : on lit, on écrit, on crée, on relie. Les
 * modifications attendent sur le téléphone (client.ts) et partent dès que le Synapse central répond ; ce qui a changé
 * ailleurs pendant ce temps arrive en même temps.
 */
const SESSION_KEY = 'synapse-session';
const BRAIN_PREFIX = 'synapse-cerveau-';
/** les autres données de ce compte gardées sur le téléphone (tout part à « Se déconnecter ») */
const OTHER_KEYS = ['synapse-data', 'synapse-compte-en-attente', 'synapse-layout'];
const OTHER_PREFIXES = ['synapse-attente-', BRAIN_PREFIX];

export interface SavedSession {
  v: 1;
  at: number;
  account: Account;
  brains: BrainCard[];
  server: ServerInfo;
  /** le dernier cerveau ouvert */
  brainId: string;
}

export interface SavedBrain {
  v: 1;
  at: number;
  accountId: string;
  brain: { id: string; name: string; ownerName: string };
  role: Role;
  me: { id: string; name: string; initials: string };
  members: Record<string, Member>;
  entities: Record<string, Entity>;
  links: Link[];
  activity: Activity[];
  layout: Record<string, [number, number, number]>;
}

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

let fullSaid = false;
function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    if (!fullSaid) {
      fullSaid = true;
      useUI.getState().toast({ text: `STOCKAGE ${standalone() ? 'DU TÉLÉPHONE' : 'DE CE PC'} PLEIN · LA COPIE HORS LIGNE N’EST PLUS À JOUR`, color: '#ff4d6d' }, 8000);
    }
    return false;
  }
}

// ───────────────────────── le compte (pour rouvrir sans réseau)
export function loadSession(): SavedSession | null {
  const s = readJson<SavedSession>(SESSION_KEY);
  return s && s.v === 1 && s.account?.id && s.server && Array.isArray(s.brains) ? s : null;
}

export function saveSession(patch: Partial<Omit<SavedSession, 'v' | 'at'>>) {
  const st = useSession.getState();
  const prev = loadSession();
  const account = patch.account ?? st.account ?? prev?.account;
  const server = patch.server ?? st.server ?? prev?.server;
  if (!account || !server) return;
  writeJson(SESSION_KEY, {
    v: 1,
    at: Date.now(),
    account,
    server,
    brains: patch.brains ?? (st.brains.length ? st.brains : prev?.brains ?? []),
    brainId: patch.brainId ?? st.brainId ?? prev?.brainId ?? account.brainId,
  } satisfies SavedSession);
}

// ───────────────────────── le cerveau ouvert
export function loadBrain(brainId: string | null | undefined, accountId: string): SavedBrain | null {
  if (!brainId) return null;
  const b = readJson<SavedBrain>(BRAIN_PREFIX + brainId);
  if (!b || b.v !== 1 || b.accountId !== accountId || !b.entities || !Array.isArray(b.links)) return null;
  return b;
}

/** La copie est-elle fiable ? (après l'état complet reçu du serveur, ou une copie rouverte) */
let ready = false;
let timer: number | undefined;
let installed = false;

function snapshot(): SavedBrain | null {
  const st = useSession.getState();
  if (!st.account || !st.brainId) return null;
  const d = useData.getState();
  return {
    v: 1,
    at: Date.now(),
    accountId: st.account.id,
    brain: { id: st.brainId, name: st.brainName, ownerName: st.ownerName },
    role: st.role,
    me: st.me,
    members: st.members,
    entities: d.entities,
    links: d.links,
    activity: d.activity,
    layout: layout.positions(),
  };
}

export function saveBrainNow() {
  window.clearTimeout(timer);
  timer = undefined;
  if (!ready) return;
  const b = snapshot();
  if (b) writeJson(BRAIN_PREFIX + b.brain.id, b);
}

function scheduleSave(ms = 1200) {
  if (!ready || timer !== undefined) return;
  timer = window.setTimeout(saveBrainNow, ms);
}

/** L'état du cerveau est complet (reçu du serveur) : la copie sur le téléphone peut suivre */
export function brainReady() {
  ready = true;
  scheduleSave(300);
  saveSession({});
}

/** Garde la copie à jour : chaque modification (d'ici ou d'ailleurs), et à la mise en arrière-plan */
export function installBrainCache() {
  if (installed) return;
  installed = true;
  useData.subscribe(() => scheduleSave());
  useSession.subscribe((s, p) => {
    if (s.members !== p.members || s.brainName !== p.brainName || s.role !== p.role) scheduleSave();
    if (s.brains !== p.brains || s.account !== p.account || s.server !== p.server) saveSession({});
  });
  // les positions 3D bougent sans modifier les données : de temps en temps
  window.setInterval(() => scheduleSave(), 30_000);
  const now = () => saveBrainNow();
  window.addEventListener('pagehide', now);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') now();
  });
}

/** Rouvre le cerveau gardé sur le téléphone (sans réseau) */
export function openSaved(session: SavedSession, brain: SavedBrain) {
  layout.useSavedPositions(brain.layout || {}, brain.role === 'owner' ? 'merge' : 'replace');
  applySnapshot({ entities: normalizeEntities(brain.entities), links: brain.links, activity: brain.activity || [] });
  setDataReadOnly(brain.role === 'lecture', () => useUI.getState().toast({ text: 'TU PEUX SEULEMENT REGARDER CE CERVEAU', color: '#00e5ff' }));
  useSession.setState({
    account: session.account,
    brains: session.brains,
    server: session.server,
    announcement: session.server.announcement,
    local: false,
    brainId: brain.brain.id,
    role: brain.role,
    me: { ...brain.me, initials: brain.me.initials || initialsOf(brain.me.name) },
    members: brain.members || {},
    ownerName: brain.brain.ownerName,
    brainName: brain.brain.name,
    mode: 'offline',
  });
  ready = true;
}

/** « Se déconnecter » : rien de ce compte ne reste sur le téléphone */
export function forgetEverything() {
  window.clearTimeout(timer);
  timer = undefined;
  ready = false;
  try {
    for (const k of Object.keys(localStorage)) {
      if (k === SESSION_KEY || OTHER_KEYS.includes(k) || OTHER_PREFIXES.some((p) => k.startsWith(p))) localStorage.removeItem(k);
    }
  } catch {
    /* pas grave */
  }
}

/** Accès retiré à un cerveau partagé : sa copie quitte le téléphone */
export function forgetBrain(brainId: string | null) {
  if (!brainId) return;
  if (useSession.getState().brainId === brainId) ready = false;
  window.clearTimeout(timer);
  timer = undefined;
  try {
    localStorage.removeItem(BRAIN_PREFIX + brainId);
    localStorage.removeItem('synapse-attente-' + brainId);
  } catch {
    /* pas grave */
  }
}

/** Le cerveau gardé d'un compte (pour savoir s'il peut s'ouvrir sans réseau) */
export function hasSavedBrain(session: SavedSession | null): boolean {
  return !!session && !!(loadBrain(session.brainId, session.account.id) || loadBrain(session.account.brainId, session.account.id));
}
