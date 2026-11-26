import { appInfo } from './native';
import { setApiBase, standalone } from './remote';

/**
 * Trouver le Synapse central (application Android). Son adresse Internet peut changer (adresse gratuite, nouvelle à
 * chaque redémarrage de Synapse sur le PC du créateur) : il la publie sur GitHub (branche synapse-adresse, fichier
 * adresse.json). On essaie, dans l'ordre :
 *   1. l'adresse choisie à la main (avancé : son propre serveur) ;
 *   2. la dernière adresse qui a marché ;
 *   3. l'adresse publiée sur GitHub (au plus une fois par minute) ;
 *   4. l'adresse fixe (si le Synapse central en a une).
 * Une adresse n'est retenue que si un serveur Synapse y répond (/api/health).
 */
const LAST_KEY = 'synapse-central';
const MANUAL_KEY = 'synapse-central-manuel';

export function cleanAddress(raw: string | null | undefined): string | null {
  const s = String(raw ?? '')
    .trim()
    .replace(/\/+$/, '');
  return /^https?:\/\/[^\s/?#]+$/i.test(s) ? s : null;
}

function read(key: string): string | null {
  try {
    return cleanAddress(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function write(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* pas grave */
  }
}

export const lastCentral = () => read(MANUAL_KEY) || read(LAST_KEY);
export const manualCentral = () => read(MANUAL_KEY);
export const rememberCentral = (url: string) => write(LAST_KEY, cleanAddress(url));
/** Une adresse choisie à la main (vide : revenir au Synapse central publié) */
export function setManualCentral(url: string | null) {
  write(MANUAL_KEY, cleanAddress(url));
}

async function getJson(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<unknown> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { cache: 'no-store', credentials: 'omit', mode: 'cors', headers, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    window.clearTimeout(t);
  }
}

/** Un serveur Synapse répond-il à cette adresse ? Renvoie sa version (proto), ou 0 */
export async function healthy(url: string, timeoutMs = 6000): Promise<number> {
  const j = (await getJson(`${url}/api/health`, timeoutMs)) as { ok?: boolean; proto?: number } | null;
  return j && j.ok === true ? Number(j.proto) || 1 : 0;
}

let published: { at: number; url: string | null } = { at: 0, url: null };
/** L'adresse publiée sur GitHub par le Synapse central (API GitHub, sinon la copie « raw ») */
async function publishedAddress(): Promise<string | null> {
  if (Date.now() - published.at < 60_000) return published.url;
  const { depot, branche, fichier } = appInfo();
  let url: string | null = null;
  if (depot) {
    const sources: [string, Record<string, string>][] = [
      [`https://api.github.com/repos/${depot}/contents/${fichier}?ref=${encodeURIComponent(branche)}`, { Accept: 'application/vnd.github.raw+json' }],
      [`https://raw.githubusercontent.com/${depot}/${branche}/${fichier}?t=${Date.now()}`, {}],
    ];
    for (const [u, h] of sources) {
      const j = (await getJson(u, 8000, h)) as { app?: string; adresse?: string } | null;
      if (j && j.app === 'synapse' && cleanAddress(j.adresse)) {
        url = cleanAddress(j.adresse);
        break;
      }
    }
  }
  published = { at: Date.now(), url };
  return url;
}

let searching: Promise<string | null> | null = null;
/**
 * La première adresse où un Synapse répond, ou null (serveur éteint, pas de réseau).
 * quick : seulement les adresses déjà connues (sans passer par GitHub).
 */
export function findCentral(opts: { quick?: boolean; timeoutMs?: number } = {}): Promise<string | null> {
  if (searching && !opts.quick) return searching;
  const run = (async () => {
    const tried = new Set<string>();
    const attempt = async (url: string | null) => {
      if (!url || tried.has(url)) return null;
      tried.add(url);
      if (await healthy(url, opts.timeoutMs ?? 6000)) {
        if (url !== manualCentral()) rememberCentral(url);
        return url;
      }
      return null;
    };
    const manual = manualCentral();
    // une adresse choisie à la main : c'est celle-là, et aucune autre
    if (manual) return attempt(manual);
    const last = await attempt(read(LAST_KEY));
    if (last || opts.quick) return last;
    const pub = await attempt(await publishedAddress());
    if (pub) return pub;
    return attempt(cleanAddress(appInfo().adresseFixe));
  })();
  if (!opts.quick) {
    searching = run;
    void run.finally(() => {
      if (searching === run) searching = null;
    });
  }
  return run;
}

/** Oublier l'adresse publiée lue il y a moins d'une minute (nouvel essai demandé) */
export function forgetPublished() {
  published = { at: 0, url: null };
}

/** L'état du relais de ce PC (PC « client ») : a-t-il trouvé le Synapse central ? null : pas de relais ici */
export interface RelayStatus {
  mode?: string;
  ok?: boolean;
  upstream?: string | null;
  depot?: string | null;
  checkedAt?: number;
  error?: string;
}
export async function relayStatus(timeoutMs = 2500): Promise<RelayStatus | null> {
  const j = (await getJson('/__relais', timeoutMs)) as RelayStatus | null;
  return j && j.mode === 'client' ? j : null;
}

/**
 * Le Synapse central répond-il ? Sa version (proto), ou 0.
 *   - téléphone : on le cherche (dernière adresse, GitHub…), et l'API part à l'adresse trouvée ;
 *   - PC « client » : par le relais de ce PC (il cherche lui-même la bonne adresse).
 */
export async function reachCentral(): Promise<number> {
  if (standalone()) {
    const url = await findCentral();
    if (!url) return 0;
    setApiBase(url);
    return healthy(url);
  }
  return healthy('');
}

/** PC « client » : demander au relais de chercher le Synapse central tout de suite (« Réessayer maintenant ») */
export async function relayRetry(): Promise<void> {
  try {
    await fetch('/__relais/retry', { method: 'POST', headers: { 'X-Synapse': 'relais' }, cache: 'no-store' });
  } catch {
    /* le relais ne répond pas : rien à faire */
  }
}
