import { useData } from '../store/data';
import { setMemoryOnly } from '../store/storage';
import { api, setBrain, startSync } from './client';
import { installErrorReporter } from './errors';
import { useSession, type Account, type BrainCard, type Role, type Scope, type ServerInfo } from './session';

/**
 * Au démarrage : qui suis-je pour ce serveur, et quel cerveau ouvrir ?
 *   - pas de serveur Synapse (développement) → application locale, comme avant
 *   - lien d'installation, de nouveau mot de passe, d'invitation à Synapse ou à un cerveau → l'écran qui va avec
 *   - compte connecté (ou créateur sur son PC) → son cerveau, ou celui demandé (?cerveau=…) s'il y a accès
 *   - invité sans compte (cookie) → le cerveau qu'il a rejoint
 *   - sinon → se connecter / créer un compte
 * Avec un serveur, rien n'est gardé dans le navigateur : le cerveau vit sur le serveur.
 */
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
  | { kind: 'auth'; hello: Hello; code?: string; codeInfo?: SignupInfo }
  | { kind: 'setup'; hello: Hello; token: string | null }
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

async function hello(brain: string | null): Promise<Hello | null> {
  try {
    const r = await fetch(`/api/hello${brain ? `?b=${encodeURIComponent(brain)}` : ''}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok || !String(r.headers.get('content-type')).includes('json')) return null;
    const h = (await r.json()) as Hello;
    return h.app === 'synapse' && h.proto === 4 ? h : null;
  } catch {
    return null;
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
  const want = new URLSearchParams(location.search).get('cerveau');

  let h = await hello(want);
  if (!h) return { kind: 'app' };
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
    h = (await hello(null)) ?? h;
  }
  if (h.auth === 'none') return { kind: 'auth', hello: h };

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
      kinds: s.kinds,
      activity: s.activity,
      layout: h.local ? localLayout() : {},
    }).catch(() => {});
  }
  const ok = await startSync();
  if (!ok && h.auth === 'member') return { kind: 'offline', ownerName: brain.ownerName };
  return { kind: 'app' };
}
