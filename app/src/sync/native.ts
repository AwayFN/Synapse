/**
 * L'application Android de Synapse (V7) contient Synapse lui-même : il marche sur le téléphone, sans serveur, et se
 * synchronise avec le Synapse central quand il répond. Elle lui ajoute quelques services (objet « SynapseAndroid ») :
 * enregistrer un fichier (export), ouvrir un lien dans le navigateur du téléphone, copier, envoyer par le menu de
 * partage du téléphone (WhatsApp, SMS…).
 * Elle prévient aussi quand le réseau du téléphone change (Wi-Fi ↔ 4G/5G) ou qu'elle revient au premier plan : la
 * synchronisation repart aussitôt.
 * (L'application V6, elle, ouvrait le Synapse central dans une vue web : sans « standalone ».)
 */
interface AndroidBridge {
  version?: () => string;
  /** V7 : Synapse est dans l'application (ses pages viennent du téléphone) */
  standalone?: () => boolean;
  /** V7 : la version, et où trouver le Synapse central (dépôt GitHub, adresse fixe), en JSON */
  info?: () => string;
  /** V6 : le serveur ne répond plus depuis un moment : l'application vérifie s'il a changé d'adresse */
  unreachable?: () => void;
  /** enregistre un fichier texte dans « Téléchargements » ; renvoie true si c'est fait */
  saveFile?: (name: string, text: string) => boolean;
  /** ouvre une adresse dans le navigateur du téléphone */
  openExternal?: (url: string) => void;
  /** V6 : revenir à l'écran « choisir le serveur » */
  changeServer?: () => void;
  /** V7 : copier un texte (presse-papiers du téléphone) */
  copy?: (text: string) => boolean;
  /** V7 : envoyer un texte par le menu de partage du téléphone (WhatsApp, SMS, e-mail…) */
  share?: (text: string) => boolean;
}

export function android(): AndroidBridge | null {
  const w = window as unknown as { SynapseAndroid?: AndroidBridge };
  return w.SynapseAndroid ?? null;
}

/** Synapse tourne dans l'application Android */
export const isAndroidApp = () => !!android() || /SynapseAndroid\//.test(navigator.userAgent);

/** Ce que l'application Android sait d'elle-même : sa version, le dépôt GitHub, l'adresse fixe du Synapse central */
export interface AppInfo {
  version: string;
  depot: string;
  branche: string;
  fichier: string;
  adresseFixe: string;
}
export function appInfo(): AppInfo {
  const out: AppInfo = { version: '', depot: '', branche: 'synapse-adresse', fichier: 'adresse.json', adresseFixe: '' };
  try {
    const j = JSON.parse(android()?.info?.() || '{}') as Partial<AppInfo>;
    for (const k of Object.keys(out) as (keyof AppInfo)[]) if (typeof j[k] === 'string' && j[k]) out[k] = j[k] as string;
  } catch {
    /* pas dans l'application */
  }
  if (!out.version) out.version = android()?.version?.() || '';
  return out;
}

/** Copier un texte : par l'application Android si on y est (fiable), sinon par le navigateur */
export async function copyText(text: string): Promise<boolean> {
  const a = android();
  if (a?.copy) {
    try {
      if (a.copy(text)) return true;
    } catch {
      /* on essaie le navigateur */
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** Le menu de partage du téléphone existe : l'application Android, ou un navigateur de téléphone */
export function canShareText(): boolean {
  if (android()?.share) return true;
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

/** Envoyer un texte par le menu de partage du téléphone (WhatsApp, SMS, e-mail…) */
export async function shareText(text: string): Promise<void> {
  const a = android();
  if (a?.share) {
    try {
      if (a.share(text)) return;
    } catch {
      /* on essaie le navigateur */
    }
  }
  try {
    await navigator.share({ title: 'Synapse', text });
  } catch {
    /* fermé par la personne */
  }
}

/** Enregistrer un fichier : par l'application Android si on y est, sinon par le navigateur */
export function saveTextFile(name: string, text: string, type = 'application/json'): boolean {
  const a = android();
  if (a?.saveFile) {
    try {
      return !!a.saveFile(name, text);
    } catch {
      /* on essaie le navigateur */
    }
  }
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

/** Ouvrir une adresse extérieure (GitHub…) : dans le navigateur du téléphone, ou un nouvel onglet */
export function openExternal(url: string) {
  const a = android();
  if (a?.openExternal) {
    a.openExternal(url);
    return;
  }
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** L'adresse de téléchargement de l'application Android (dernière version publiée sur GitHub) */
export const androidDownloadUrl = (depot: string) => `https://github.com/${depot}/releases/latest/download/Synapse.apk`;
export const releasesUrl = (depot: string) => `https://github.com/${depot}/releases/latest`;
