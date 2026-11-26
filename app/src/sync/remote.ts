import { android } from './native';

/**
 * Où est le serveur Synapse, et comment s'y présenter.
 *
 *  - Partout, sauf dans l'application Android : le serveur est celui qui a servi la page (même adresse), et le
 *    compte est un cookie de session (HttpOnly). Rien ne change.
 *  - Dans l'application Android (V7) : Synapse est DANS le téléphone (ses pages viennent de l'application, il marche
 *    sans serveur ni réseau). Il se synchronise avec le Synapse central, à son adresse Internet (qui peut changer),
 *    en se présentant avec son jeton de session (en-tête Authorization), gardé sur le téléphone.
 */
const TOKEN_KEY = 'synapse-jeton';
/** Version de l'échange avec le serveur Synapse (la même des deux côtés, sinon l'un des deux doit être mis à jour) */
export const PROTO = 7;

/** Synapse tourne dans l'application Android V7 (ses pages viennent du téléphone, pas d'un serveur) */
export function standalone(): boolean {
  try {
    return !!android()?.standalone?.();
  } catch {
    return false;
  }
}

/**
 * PC « client » (V7.1) : un relais sur ce PC sert l'application (elle vient du dossier Synapse) et transmet l'API au
 * Synapse central. Même adresse que la page et cookie de session, comme un navigateur ; mais, comme sur le téléphone,
 * Synapse y marche sans connexion. Repéré au démarrage (boot.ts).
 */
let relay = false;
export const setRelayClient = (on: boolean) => {
  relay = on;
};
export const relayClient = () => relay;

/**
 * Synapse marche ici même sans connexion (téléphone, ou PC « client ») : le cerveau est gardé sur l'appareil et se
 * synchronise avec le Synapse central dès qu'il répond. (Le PC du créateur, lui, EST le Synapse central.)
 */
export const localFirst = () => relay || standalone();

/** « téléphone » ou « PC » : pour dire où sont gardées les données */
export const deviceWord = () => (standalone() ? 'téléphone' : 'PC');

let base = '';
/** L'adresse du serveur pour l'API : '' = celle de la page */
export const apiBase = () => base;
export function setApiBase(url: string | null) {
  base = (url || '').replace(/\/+$/, '');
}
export const apiUrl = (path: string) => base + path;

let token: string | null | undefined;
export function sessionToken(): string | null {
  if (token === undefined) {
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      token = null;
    }
  }
  return token ?? null;
}
export function setSessionToken(t: string | null) {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* stockage indisponible : la session ne durera que le temps de cette ouverture */
  }
}

/** En-têtes et mode d'une requête vers le serveur (cookie de la page, ou jeton de l'application) */
export function requestInit(extra: Record<string, string> = {}): { headers: Record<string, string>; credentials: RequestCredentials; mode?: RequestMode } {
  if (!standalone()) return { headers: extra, credentials: 'same-origin' };
  const t = sessionToken();
  return {
    // le serveur rend le jeton de session à la connexion (il est gardé ici, pas dans un cookie)
    headers: { ...extra, 'X-Synapse-Jeton': '1', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
    credentials: 'omit',
    mode: 'cors',
  };
}

/** Une réponse du serveur contient un nouveau jeton de session (connexion, création de compte) : on le garde */
export function keepToken(data: unknown) {
  if (!standalone() || !data || typeof data !== 'object') return;
  const s = (data as { session?: unknown }).session;
  if (typeof s === 'string' && /^[A-Za-z0-9_-]{20,100}$/.test(s)) setSessionToken(s);
}
