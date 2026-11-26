import { create } from 'zustand';
import type { Entity, Link } from '../types';
import { useData } from '../store/data';
import { flushStorage } from '../store/storage';
import { layout } from '../scene/layout';
import { api, ApiError, clientId } from './client';
import { forgetPublished, reachCentral } from './central';
import { PROTO, apiBase, setSessionToken, standalone } from './remote';
import type { Op } from './ops';

/**
 * Un compte créé sur le téléphone (ou un PC « client ») pendant que le Synapse central ne répondait pas (PC du créateur
 * éteint, pas de réseau) : on utilise Synapse tout de suite, sur l'appareil, et le compte est enregistré sur le Synapse central
 * dès qu'il répond, avec tout ce qui a été fait entre-temps (qui devient son cerveau). Ensuite, c'est un compte
 * comme les autres : on le retrouve sur son PC en s'y connectant.
 *
 * Deux temps : « à créer » (on garde le prénom, l'e-mail et le mot de passe le temps de l'inscription), puis
 * « créé » (le mot de passe est oublié aussitôt ; il reste à envoyer le cerveau, si ça n'a pas pu se faire d'un coup).
 */
const KEY = 'synapse-compte-en-attente';

export type PendingError = 'exists' | 'closed' | 'invitation' | 'full' | 'terms' | 'email' | 'password' | 'name' | 'maintenance' | 'version' | 'other';

export interface Pending {
  name: string;
  email: string;
  /** seulement tant que le compte n'est pas créé sur le serveur */
  password?: string;
  createdAt: number;
  /** les conditions du serveur sont acceptées */
  terms?: boolean;
  /** le compte existe sur le serveur (jeton de session gardé) ; reste à y envoyer le cerveau */
  registered?: boolean;
  /** il s'est connecté à un compte qui existait déjà : on y ajoute ce qui a été fait ici (sans remplacer) */
  merge?: boolean;
}

export function loadPending(): Pending | null {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) || 'null') as Pending | null;
    return p && typeof p.email === 'string' && typeof p.name === 'string' ? p : null;
  } catch {
    return null;
  }
}

function savePending(p: Pending | null) {
  try {
    if (p) localStorage.setItem(KEY, JSON.stringify(p));
    else localStorage.removeItem(KEY);
  } catch {
    /* stockage plein : le compte reste en mémoire jusqu'à la fermeture */
  }
  usePending.setState({ pending: p });
}

interface PendingState {
  pending: Pending | null;
  /** waiting : le Synapse central ne répond pas · trying : inscription en cours · error : il a répondu non */
  state: 'waiting' | 'trying' | 'error';
  error: PendingError | null;
  message: string;
  /** prochain essai automatique (horodatage) */
  next: number;
  /** l'adresse du Synapse central trouvée (pour afficher les conditions, par exemple) */
  central: string | null;
}

export const usePending = create<PendingState>(() => ({ pending: loadPending(), state: 'waiting', error: null, message: '', next: 0, central: null }));

/** Le compte en attente, créé ici (aucun réseau nécessaire) : Synapse s'ouvre aussitôt avec le cerveau de découverte */
export function createPending(input: { name: string; email: string; password: string; terms?: boolean }) {
  savePending({ name: input.name.trim(), email: input.email.trim().toLowerCase(), password: input.password, terms: !!input.terms, createdAt: Date.now() });
}

const errorOf = (e: unknown): { code: string; message?: string } => {
  if (e instanceof ApiError) {
    const d = (e.data as { error?: string; message?: string } | null) ?? {};
    return { code: d.error || `http-${e.status}`, message: d.message };
  }
  return { code: 'network' };
};

/** Ce qui a été fait ici, à ajouter à un cerveau qui existe déjà (les exemples de découverte restent ici) */
function mergeOps(): Op[] {
  const { entities, links } = useData.getState();
  const keep: Record<string, Entity> = {};
  for (const e of Object.values(entities)) if (!e.seed) keep[e.id] = e;
  const ops: Op[] = [];
  for (const e of Object.values(keep)) {
    const x = e as Entity & { projectId?: string | null };
    ops.push({ t: 'put', e: x.projectId && !keep[x.projectId] ? ({ ...x, projectId: null } as Entity) : e });
  }
  for (const l of links as Link[]) if (keep[l.a] && keep[l.b]) ops.push({ t: 'link', l });
  return ops;
}

/** Le cerveau d'ici part sur le serveur : il devient celui du compte (ou s'ajoute au cerveau existant) */
async function sendBrain(p: Pending) {
  const s = useData.getState();
  if (p.merge) {
    const ops = mergeOps();
    try {
      for (let i = 0; i < ops.length; i += 300) await api('/api/ops', { clientId, ops: ops.slice(i, i + 300) }, 30000);
      return;
    } catch (e) {
      // son cerveau n'a encore jamais été ouvert (vide) : ce qui a été fait ici devient son cerveau
      if (!(e instanceof ApiError && e.status === 409)) throw e;
    }
  }
  try {
    await api('/api/import', { mode: 'initial', entities: s.entities, links: s.links, activity: s.activity, layout: layout.positions() }, 60000);
  } catch (e) {
    // le cerveau existe déjà sur le serveur (envoi précédent arrivé, mais la réponse perdue) : c'est fait
    if (!(e instanceof ApiError && e.status === 409)) throw e;
  }
}

let started = false;
let timer: number | undefined;
let delay = 8000;

/** Tout est sur le serveur : on oublie le compte en attente et le cerveau d'ici, puis Synapse se rouvre, synchronisé */
function finish() {
  savePending(null);
  try {
    localStorage.removeItem('synapse-data');
  } catch {
    /* pas grave */
  }
  location.replace('/');
}

async function attempt() {
  timer = undefined;
  const p = loadPending();
  if (!p) return;
  usePending.setState({ state: 'trying' });
  // le Synapse central répond-il ? (téléphone : on le cherche ; PC « client » : par le relais de ce PC)
  const proto = await reachCentral();
  if (!proto) {
    usePending.setState({ state: 'waiting', central: null, next: Date.now() + delay });
    schedule();
    return;
  }
  usePending.setState({ central: standalone() ? apiBase() : 'relais' });
  // une autre version de Synapse (le serveur ou l'application doit être mis à jour)
  if (proto !== PROTO) {
    usePending.setState({ state: 'error', error: 'version', message: proto > PROTO ? 'app' : 'serveur' });
    schedule(60_000);
    return;
  }
  try {
    if (!p.registered) {
      if (!p.password) {
        usePending.setState({ state: 'error', error: 'password', message: '' });
        return;
      }
      await api('/api/auth/signup', { name: p.name, email: p.email, password: p.password, terms: !!p.terms });
      // le compte existe : le mot de passe n'est plus gardé nulle part sur l'appareil
      const { password: _forget, ...rest } = p;
      void _forget;
      savePending({ ...rest, registered: true });
    }
    flushStorage();
    await sendBrain(loadPending() ?? p);
    finish();
  } catch (e) {
    const { code, message } = errorOf(e);
    const known: PendingError[] = ['exists', 'closed', 'invitation', 'full', 'terms', 'email', 'password', 'name', 'maintenance'];
    if (code === 'network' || code.startsWith('http-5') || code === 'trop de tentatives') {
      // réponse perdue, serveur occupé : on réessaie un peu plus tard
      usePending.setState({ state: 'waiting', next: Date.now() + delay });
      schedule();
      return;
    }
    const err: PendingError = known.includes(code as PendingError) ? (code as PendingError) : 'other';
    usePending.setState({ state: 'error', error: err, message: message || '' });
    // « maintenance » se règle tout seul : on réessaie quand même, plus tard
    if (err === 'maintenance') schedule(60_000);
  }
}

function schedule(ms = delay) {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void attempt(), ms);
  delay = Math.min(60_000, Math.round(delay * 1.5));
}

/** Essais automatiques : au démarrage, puis régulièrement, et dès que le réseau revient */
export function startPendingLoop() {
  if (started) return;
  started = true;
  void attempt();
  window.addEventListener('online', () => retryPending());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && usePending.getState().state === 'waiting') retryPending();
  });
  const w = window as unknown as { __synapseNetwork?: (on: boolean) => void; __synapseResume?: () => void };
  w.__synapseNetwork = (on: boolean) => {
    if (on) retryPending();
  };
  w.__synapseResume = () => {
    if (usePending.getState().state === 'waiting') retryPending();
  };
}

/** « Réessayer maintenant » */
export function retryPending() {
  if (usePending.getState().state === 'trying') return;
  delay = 8000;
  forgetPublished();
  window.clearTimeout(timer);
  void attempt();
}

/** Corriger le compte en attente (autre e-mail, conditions acceptées…), puis réessayer */
export function updatePending(patch: Partial<Pending>) {
  const p = loadPending();
  if (!p) return;
  savePending({ ...p, ...patch });
  usePending.setState({ state: 'waiting', error: null, message: '' });
  retryPending();
}

/**
 * Un compte existe déjà avec cet e-mail : la personne s'y connecte (son mot de passe), et ce qu'elle a fait sur le
 * téléphone s'ajoute à son cerveau.
 */
export async function loginInstead(email: string, password: string): Promise<string | null> {
  const p = loadPending();
  if (!p) return null;
  try {
    await api('/api/auth/login', { email, password });
    savePending({ name: p.name, email: email.trim().toLowerCase(), createdAt: p.createdAt, registered: true, merge: true });
    usePending.setState({ state: 'trying', error: null });
    await sendBrain(loadPending()!);
    finish();
    return null;
  } catch (e) {
    const { code } = errorOf(e);
    if (code === 'invalid') return 'Adresse e-mail ou mot de passe incorrect.';
    if (code === 'locked') return 'Trop d’essais : patiente un quart d’heure.';
    if (code === 'network') return 'Le Synapse central ne répond plus. Réessaie dans un instant.';
    return 'Ça n’a pas marché. Réessaie.';
  }
}

/** Abandonner ce compte en attente (et ce qui a été fait ici) : retour à l'écran de création de compte */
export function dropPending() {
  setSessionToken(null);
  savePending(null);
  try {
    localStorage.removeItem('synapse-data');
  } catch {
    /* pas grave */
  }
  location.replace('/');
}
