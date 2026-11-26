import { api, ApiError } from './client';
import { linkBases, useSession, type ShareStatus } from './session';
import { canShareText, openExternal, shareText } from './native';
import { standalone } from './remote';

/**
 * « Comment les autres me rejoignent » : une adresse joignable pour les liens (invitations, QR code).
 * Sur le PC qui fait tourner Synapse, il n'y en a pas tant qu'aucun accès n'est ouvert : on l'ouvre à la
 * demande (Internet, ou même Wi-Fi), au lieu de renvoyer la personne vers un autre écran.
 */
export type Base = { label: string; url: string };
export type Reach = { ok: true; base: Base } | { ok: false; need: 'consent' } | { ok: false; error: string };
export type ReachKind = 'internet' | 'lan' | 'any';

const isLan = (b: Base) => b.label === 'Même Wi-Fi';

/** L'outil d'accès Internet (cloudflared) est-il déjà là ? Sinon il faut l'accord pour le télécharger, une fois */
export function toolReady(): boolean {
  return !!useSession.getState().share?.internet.toolReady;
}

/** Une adresse existe déjà pour ce genre de lien (rien à ouvrir) */
export function reachNow(kind: ReachKind): Base | null {
  const bases = linkBases();
  if (!useSession.getState().local || kind === 'any') return bases[0] ?? null;
  return bases.find((b) => (kind === 'lan' ? isLan(b) : !isLan(b))) ?? null;
}

export async function ensureReach(kind: ReachKind, consent = false): Promise<Reach> {
  const now = reachNow(kind);
  if (now) return { ok: true, base: now };
  if (!useSession.getState().local) return { ok: false, error: 'Aucune adresse disponible pour l’instant.' };
  try {
    if (kind === 'lan') {
      const s = await api<ShareStatus>('/api/share/lan', { on: true });
      useSession.setState({ share: s });
      const b = reachNow('lan');
      return b ? { ok: true, base: b } : { ok: false, error: s.lan.error || 'Impossible d’ouvrir l’accès Wi-Fi.' };
    }
    if (!toolReady() && !consent) return { ok: false, need: 'consent' };
    const s = await api<ShareStatus>('/api/share/internet', { on: true, consent });
    useSession.setState({ share: s });
    if (s.internet.state === 'needs-consent') return { ok: false, need: 'consent' };
    const b = reachNow('internet');
    if (b) return { ok: true, base: b };
    return { ok: false, error: s.internet.error || 'L’accès Internet n’a pas pu s’ouvrir. Vérifie la connexion, puis réessaie.' };
  } catch (e) {
    const code = e instanceof ApiError ? (e.data as { error?: string })?.error : 'network';
    return {
      ok: false,
      error:
        code === 'local' || code === 'owner'
          ? 'Seul le créateur, sur l’ordinateur qui fait tourner Synapse, peut ouvrir l’accès.'
          : 'Le serveur Synapse ne répond pas. Réessaie dans un instant.',
    };
  }
}

/** Un lien collé (ou tout un message qui le contient) : l'adresse, prête à ouvrir */
export function linkFrom(text: string): { url: URL; problem?: string } | null {
  const m = text.match(/https?:\/\/[^\s<>"'«»]+/i);
  if (!m) return null;
  let url: URL;
  try {
    url = new URL(m[0].replace(/[.,;:!?)\]]+$/, ''));
  } catch {
    return null;
  }
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.origin !== location.origin) {
    return {
      url,
      problem: 'Ce lien commence par « localhost » : il ne marche que sur l’ordinateur qui l’a créé. Demande à ton ami le lien qui commence par https://',
    };
  }
  return { url };
}

/** Ouvre le Synapse d'un ami dans une autre fenêtre (le tien reste ouvert) */
export function openLink(url: URL) {
  // application Android : un autre serveur Synapse s'ouvre dans le navigateur du téléphone
  if (standalone()) return openExternal(url.toString());
  if (url.origin === location.origin) {
    location.assign(url.toString());
    return;
  }
  const a = document.createElement('a');
  a.href = url.toString();
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Envoyer par le menu de partage du téléphone (WhatsApp, SMS…), quand il existe (application Android : toujours) */
export const canNativeShare = canShareText;

export const nativeShare = shareText;

/**
 * Un lien d'invitation à un cerveau (« …/#invite=… ») : son jeton. Le jeton vit sur le serveur, pas dans l'adresse :
 * dans l'application Android, il marche même si l'adresse du Synapse central a changé depuis l'envoi du lien.
 */
export function inviteTokenOf(url: URL): string | null {
  const m = url.hash.match(/(?:^#|&)invite=([A-Za-z0-9_.-]{8,160})/);
  return m ? m[1] : null;
}
