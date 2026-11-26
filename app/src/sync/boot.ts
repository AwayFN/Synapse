import { useData } from '../store/data';
import { setMemoryOnly } from '../store/storage';
import { api, setBrain, startSync } from './client';
import { installErrorReporter } from './errors';
import { android } from './native';
import { useSession, type Account, type BrainCard, type Role, type Scope, type ServerInfo } from './session';

/**
 * Au démarrage : qui suis-je pour ce serveur, et quel cerveau ouvrir ?
 *   - pas de serveur Synapse (développement) → application locale, comme avant
 *   - serveur injoignable (Synapse central éteint, réseau coupé) → écran d'attente, nouvel essai automatique
 *   - lien d'installation, de nouveau mot de passe, d'invitation à Synapse ou à un cerveau → l'écran qui va avec
 *   - compte connecté → son cerveau, ou celui demandé (?cerveau=…) s'il y a accès
 *   - invité sans compte (cookie) → le cerveau qu'il a rejoint
 *   - sinon → créer son compte / se connecter (la toute première chose à faire)
 * Avec un serveur, rien n'est gardé dans le navigateur : le cerveau vit sur le serveur.
 */
export const PROTO = 6;
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
  | { kind: 'auth'; hello: Hello; code?: string; codeInfo?: SignupInfo; linkError?: boolean }
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
    const r = await fetch(`/api/hello${brain ? `?b=${encodeURIComponent(brain)}` : ''}`, { credentials: 'same-origin', cache: 'no-store', signal: ctrl.signal });
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

export async function bootstrap(): Promise<Boot> {
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
      const r = await fetch('/api/auth/device', {
        method: 'POST',
        headers: { 'X-Synapse': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: device }),
        credentials: 'same-origin',
      });
      linkError = !r.ok;
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
    return { kind: 'unreachable', reason: 'server' };
  }
  let h: Hello = first;
  installErrorReporter(h.build);
  // avec un serveur, le cerveau vit sur le serveur : rien n'est écrit dans ce navigateur
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
  if (h.auth === 'owner' && h.empty) {
    // premier départ de ce cerveau : ce qui est dans le navigateur devient le cerveau de référence (sur le
    // PC du créateur : son cerveau d'avant ; pour un nouveau compte : le cerveau de découverte)
    const s = useData.getState();
    await api('/api/import', {
      mode: 'initial',
      entities: s.entities,
      links: s.links,
      activity: s.activity,
      layout: h.local ? localLayout() : {},
    }).catch(() => {});
  }
  const ok = await startSync();
  if (!ok && h.auth === 'member') return { kind: 'offline', ownerName: brain.ownerName };
  return { kind: 'app' };
}
