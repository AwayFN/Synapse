import { useData } from '../store/data';
import { setMemoryOnly } from '../store/storage';
import { api, setBrain, startSync } from './client';
import { installErrorReporter } from './errors';
import { android, appInfo } from './native';
import { useSession, type Account, type BrainCard, type Role, type Scope, type ServerInfo } from './session';
import { PROTO, apiUrl, requestInit, sessionToken, setApiBase, standalone } from './remote';
import { findCentral, healthy, lastCentral } from './central';
import { forgetEverything, hasSavedBrain, installBrainCache, loadBrain, loadSession, openSaved, saveSession, type SavedSession } from './offline';
import { loadPending, startPendingLoop } from './pending';

/**
 * Au démarrage : qui suis-je pour ce serveur, et quel cerveau ouvrir ?
 *   - pas de serveur Synapse (développement) → application locale, comme avant
 *   - serveur injoignable (Synapse central éteint, réseau coupé) → écran d'attente, nouvel essai automatique
 *   - lien d'installation, de nouveau mot de passe, d'invitation à Synapse ou à un cerveau → l'écran qui va avec
 *   - compte connecté → son cerveau, ou celui demandé (?cerveau=…) s'il y a accès
 *   - invité sans compte (cookie) → le cerveau qu'il a rejoint
 *   - sinon → créer son compte / se connecter (la toute première chose à faire)
 * Avec un serveur, rien n'est gardé dans le navigateur : le cerveau vit sur le serveur.
 *
 * L'application Android (V7) est différente : Synapse est dans le téléphone et marche sans serveur.
 *   - compte créé pendant que le Synapse central ne répondait pas → Synapse s'ouvre aussitôt, le compte sera
 *     enregistré dès qu'il répond (pending.ts) ;
 *   - le Synapse central répond → comme partout (et le cerveau est aussi gardé sur le téléphone) ;
 *   - il ne répond pas → le cerveau gardé sur le téléphone s'ouvre ; tout se synchronise dès qu'il revient ;
 *   - première ouverture sans réseau → on crée quand même son compte, et on commence.
 */
export { PROTO };
export interface InviteInfo {
  ok: boolean;
  reason?: 'unknown' | 'expired' | 'used' | 'revoked';
  ownerName: string;
  brainName?: string;
  brainId?: string;
  role?: Exclude<Role, 'owner'>;
  roleLabel?: string;
  scope?: Scope;
  name?: string;
  already?: 'owner' | 'member' | null;
  signup?: boolean;
  appName?: string;
  /** il revient avec son lien (même invité qu'avant) : sans compte, ou avec son compte */
  back?: 'guest' | 'account';
}

export interface SignupInfo {
  ok: boolean;
  reason: string;
  note: string;
  from: string;
  appName: string;
}

export interface Hello {
  app: string;
  proto: number;
  build: string;
  server: ServerInfo;
  local: boolean;
  account: Account | null;
  suspended?: boolean;
  brains: BrainCard[];
  brain: { id: string; name: string; ownerName: string } | null;
  auth: 'owner' | 'member' | 'none';
  role: Role | null;
  me: { id: string; name: string } | null;
  empty?: boolean;
}

export type Boot =
  | { kind: 'app' }
  | { kind: 'join'; token: string; info: InviteInfo; hello: Hello }
  | { kind: 'auth'; hello: Hello; code?: string; codeInfo?: SignupInfo; linkError?: boolean; offline?: boolean }
  | { kind: 'setup'; hello: Hello; token: string | null }
  | { kind: 'first'; hello: Hello }
  | { kind: 'claim'; hello: Hello }
  | { kind: 'unreachable'; reason: 'server' | 'version' | 'old-server' }
  | { kind: 'reset'; hello: Hello; token: string; info: { ok: boolean; name?: string; email?: string } }
  | { kind: 'maintenance'; hello: Hello }
  | { kind: 'suspended'; hello: Hello }
  | { kind: 'offline'; ownerName: string };

function localLayout(): Record<string, [number, number, number]> {
  try {
    return JSON.parse(localStorage.getItem('synapse-layout') || '{}');
  } catch {
    return {};
  }
}

/** null : pas de serveur Synapse ici · 'old' / 'new' : un serveur plus ancien / plus récent · sinon sa réponse */
async function hello(brain: string | null): Promise<Hello | null | 'old' | 'new'> {
  try {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(apiUrl(`/api/hello${brain ? `?b=${encodeURIComponent(brain)}` : ''}`), { ...requestInit(), cache: 'no-store', signal: ctrl.signal });
    window.clearTimeout(t);
    if (!r.ok || !String(r.headers.get('content-type')).includes('json')) return null;
    const h = (await r.json()) as Hello;
    if (h.app !== 'synapse') return null;
    return h.proto === PROTO ? h : h.proto < PROTO ? 'old' : 'new';
  } catch {
    return null;
  }
}

/** Le relais de ce PC (mode client) répond-il ? Alors c'est le Synapse central qui ne répond pas */
async function relayMode(): Promise<boolean> {
  try {
    const r = await fetch('/__relais', { cache: 'no-store' });
    return r.ok && ((await r.json()) as { mode?: string }).mode === 'client';
  } catch {
    return false;
  }
}

/** Les jetons d'un lien quittent la barre d'adresse (et l'historique) dès qu'ils sont lus */
function cleanUrl(keepBrain = true) {
  const want = new URLSearchParams(location.search).get('cerveau');
  history.replaceState(null, '', keepBrain && want ? `/?cerveau=${encodeURIComponent(want)}` : '/');
}

// ───────────────────────── application Android : Synapse dans le téléphone

/** Le serveur tel qu'on le décrit quand personne ne répond (écran de création de compte, sans réseau) */
export function offlineHello(): Hello {
  return {
    app: 'synapse',
    proto: PROTO,
    build: '',
    local: false,
    account: null,
    brains: [],
    brain: null,
    auth: 'none',
    role: null,
    me: null,
    server: {
      hosted: false,
      name: 'Synapse',
      registration: 'ouverte',
      setup: false,
      depot: appInfo().depot || null,
      creatorName: '',
      maintenance: null,
      announcement: null,
      terms: false,
      invite: null,
      publicUrl: null,
      internetUrl: null,
    },
  };
}

/** Ouvre le cerveau gardé sur le téléphone ; la synchronisation repart toute seule dès que le Synapse central répond */
function openOffline(saved: SavedSession, outdated: 'app' | 'serveur' | null = null): Boot {
  const id = saved.account.id;
  const want = new URLSearchParams(location.search).get('cerveau');
  const brain = loadBrain(want, id) || loadBrain(saved.brainId, id) || loadBrain(saved.account.brainId, id);
  if (!brain) return { kind: 'unreachable', reason: 'server' };
  setMemoryOnly(true);
  setBrain(brain.brain.id);
  openSaved(saved, brain);
  installBrainCache();
  useSession.setState({ outdated });
  // une autre version de Synapse de l'autre côté : pas de synchronisation tant que l'un des deux n'est pas à jour
  if (!outdated) void startSync();
  return { kind: 'app' };
}

/**
 * L'application Android : null = le Synapse central répond (la suite est la même que partout), sinon ce qu'il faut
 * ouvrir sans lui.
 */
async function bootApp(): Promise<Boot | null> {
  // un compte créé sans réseau : Synapse s'ouvre tout de suite, et le compte s'enregistre dès que possible
  if (loadPending()) {
    setMemoryOnly(false);
    useSession.setState({ mode: 'local' });
    startPendingLoop();
    return { kind: 'app' };
  }
  const token = sessionToken();
  const saved = token ? loadSession() : null;
  const canOffline = hasSavedBrain(saved);
  // le cas habituel : le Synapse central répond à sa dernière adresse (vite, pour ne pas faire attendre)
  const last = lastCentral();
  if (last) {
    const p = await healthy(last, canOffline ? 3500 : 6000);
    if (p === PROTO) {
      setApiBase(last);
      return null;
    }
    if (p) {
      if (canOffline) return openOffline(saved!, p > PROTO ? 'app' : 'serveur');
      return { kind: 'unreachable', reason: p > PROTO ? 'version' : 'old-server' };
    }
  }
  // il ne répond pas (PC éteint, pas de réseau) : le cerveau gardé sur le téléphone, tout de suite
  if (canOffline) {
    if (last) setApiBase(last);
    return openOffline(saved!);
  }
  // rien sur le téléphone : on cherche le Synapse central (il a peut-être changé d'adresse)
  const found = await findCentral({ timeoutMs: 4500 });
  if (found) {
    const p = await healthy(found);
    if (p === PROTO) {
      setApiBase(found);
      return null;
    }
    if (p) return { kind: 'unreachable', reason: p > PROTO ? 'version' : 'old-server' };
  }
  if (token) return { kind: 'unreachable', reason: 'server' };
  // personne ne répond : on crée quand même son compte, et on commence (il sera enregistré plus tard)
  return { kind: 'auth', hello: offlineHello(), offline: true };
}

export async function bootstrap(): Promise<Boot> {
  const app = standalone();
  if (app) {
    const early = await bootApp();
    if (early) return early;
  }
  const frag = new URLSearchParams(location.hash.replace(/^#/, ''));
  const invite = frag.get('invite');
  const code = frag.get('inscription');
  const reset = frag.get('reinit');
  const setup = frag.get('installation');
  const device = frag.get('connexion');
  const want = new URLSearchParams(location.search).get('cerveau');

  // QR code affiché sur un autre appareil : on entre directement dans le compte (lien à usage unique)
  let linkError = false;
  if (device) {
    try {
      await api('/api/auth/device', { token: device });
    } catch {
      linkError = true;
    }
    history.replaceState(null, '', '/');
  }

  const first = await hello(want);
  // un serveur plus ancien (le PC n'a pas encore relancé Synapse) ou plus récent (la page doit se recharger)
  if (first === 'old') return { kind: 'unreachable', reason: 'old-server' };
  if (first === 'new') return { kind: 'unreachable', reason: 'version' };
  if (!first) {
    // en développement (pas de serveur Synapse) : l'application fonctionne seule, dans ce navigateur.
    // Servie par Synapse, jamais : sans serveur, rien ne serait enregistré au bon endroit
    if (import.meta.env.DEV && !android() && !(await relayMode())) return { kind: 'app' };
    try {
      android()?.unreachable?.();
    } catch {
      /* pas dans l'application */
    }
    // application Android : il répondait il y a un instant ; avec son cerveau gardé ici, on l'ouvre quand même
    if (app) {
      const saved = sessionToken() ? loadSession() : null;
      if (hasSavedBrain(saved)) return openOffline(saved!);
    }
    return { kind: 'unreachable', reason: 'server' };
  }
  let h: Hello = first;
  installErrorReporter(h.build);
  // avec un serveur, le cerveau vit sur le serveur : rien n'est écrit dans ce navigateur
  // (l'application Android en garde sa propre copie, offline.ts)
  setMemoryOnly(true);
  useSession.setState({
    server: h.server,
    local: h.local,
    account: h.account,
    brains: h.brains,
    announcement: h.server.announcement,
    ownerName: h.brain?.ownerName ?? '',
    brainName: h.brain?.name ?? '',
  });

  if (h.server.setup) {
    if (setup) history.replaceState(null, '', '/');
    return { kind: 'setup', hello: h, token: setup };
  }
  // nouvelle installation : la personne devant ce PC crée d'abord son compte (un compte normal, pas admin)
  if (h.server.firstRun && !invite) return { kind: 'first', hello: h };
  // l'ancien compte de ce PC n'a pas de mot de passe : il en choisit un, une fois
  if (h.server.claim && !invite) return { kind: 'claim', hello: h };
  if (h.suspended) return { kind: 'suspended', hello: h };
  if (h.server.maintenance !== null && !h.account?.staff) return { kind: 'maintenance', hello: h };

  if (reset) {
    cleanUrl(false);
    const info = await api<{ ok: boolean; name?: string; email?: string }>('/api/auth/reset/info', { token: reset }).catch(() => ({ ok: false }));
    return { kind: 'reset', hello: h, token: reset, info };
  }
  if (invite) {
    const info = await api<InviteInfo>('/api/invite/info', { token: invite }).catch((): InviteInfo => ({ ok: false, reason: 'unknown', ownerName: '' }));
    // déjà dedans (propriétaire ou membre) : on y va directement
    if (info.ok && info.already && info.brainId) {
      location.replace(info.already === 'owner' ? '/' : `/?cerveau=${encodeURIComponent(info.brainId)}`);
      return new Promise(() => {});
    }
    return { kind: 'join', token: invite, info, hello: h };
  }
  if (code && !h.account) {
    const codeInfo = await api<SignupInfo>('/api/signup/info', { code }).catch(() => undefined);
    return { kind: 'auth', hello: h, code, codeInfo };
  }
  if (code) cleanUrl();

  // un compte connecté qui demande un cerveau où il n'a pas (ou plus) accès : retour au sien
  if (want && h.auth === 'none' && h.account) {
    history.replaceState(null, '', '/');
    const again = await hello(null);
    if (again && again !== 'old' && again !== 'new') h = again;
  }
  if (h.auth === 'none') return { kind: 'auth', hello: h, linkError };

  const brain = h.brain!;
  setBrain(brain.id);
  useSession.setState({
    brainId: brain.id,
    role: h.role ?? 'lecture',
    me: { id: h.me!.id, name: h.me!.name, initials: '' },
    ownerName: brain.ownerName,
    brainName: brain.name,
  });
  if (app && h.account) {
    // un autre compte qu'avant sur ce téléphone : rien de l'ancien ne reste
    const before = loadSession();
    if (before && before.account.id !== h.account.id) forgetEverything();
    saveSession({ account: h.account, brains: h.brains, server: h.server, brainId: brain.id });
    installBrainCache();
  }
  if (h.auth === 'owner' && h.empty) {
    // premier départ de ce cerveau : ce qui est dans le navigateur devient le cerveau de référence (sur le
    // PC du créateur : son cerveau d'avant ; pour un nouveau compte : le cerveau de découverte)
    const s = useData.getState();
    const sent = await api('/api/import', {
      mode: 'initial',
      entities: s.entities,
      links: s.links,
      activity: s.activity,
      layout: h.local ? localLayout() : {},
    }).then(
      () => true,
      () => false,
    );
    // application Android : le cerveau du téléphone est maintenant celui du compte (plus de copie à part)
    if (sent && app) {
      try {
        localStorage.removeItem('synapse-data');
      } catch {
        /* pas grave */
      }
    }
  }
  const ok = await startSync();
  if (!ok && h.auth === 'member' && !app) return { kind: 'offline', ownerName: brain.ownerName };
  return { kind: 'app' };
}
