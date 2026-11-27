/**
 * Où tourne Synapse : l'application Windows (fenêtre Synapse, objet « SynapseDesktop »), l'application Android (objet
 * « SynapseAndroid »), ou un navigateur pendant le développement. Synapse est 100 % local : aucune de ces passerelles ne
 * parle à Internet. Elles servent seulement à garder les données sur l'appareil et à enregistrer un fichier (export).
 */

/** L'application Android (android/…/MainActivity.java) */
interface AndroidBridge {
  version?: () => string;
  /** enregistre un fichier texte dans « Téléchargements » ; renvoie true si c'est fait */
  saveFile?: (name: string, text: string) => boolean;
  /** V8 : la sauvegarde automatique du jour, dans Documents/Synapse (elle reste même si l'application est désinstallée) */
  backup?: (text: string) => boolean;
}

/** Le stockage de l'application Windows : un fichier dans %APPDATA%\Synapse (lu une fois au démarrage) */
export interface DesktopStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  /** écrit tout de suite sur le disque (fermeture de la fenêtre) */
  flush: () => void;
}

/** L'application Windows (desktop/preload.cjs) */
interface DesktopBridge {
  version: string;
  /** le dossier des données (%APPDATA%\Synapse) */
  dataDir: string;
  storage: DesktopStorage;
  /** « Enregistrer sous… » : renvoie true si le fichier est enregistré */
  saveFile: (name: string, text: string) => Promise<boolean>;
  /** au premier lancement : le réseau de la version précédente a été repris (nombre d'éléments) */
  migrated: { count: number } | null;
}

export function android(): AndroidBridge | null {
  return (window as unknown as { SynapseAndroid?: AndroidBridge }).SynapseAndroid ?? null;
}

export function desktop(): DesktopBridge | null {
  return (window as unknown as { SynapseDesktop?: DesktopBridge }).SynapseDesktop ?? null;
}

/** Synapse tourne dans l'application Android */
export const isAndroidApp = () => !!android() || /SynapseAndroid\//.test(navigator.userAgent);
/** Synapse tourne dans l'application Windows */
export const isDesktopApp = () => !!desktop();

/** « téléphone » ou « PC » : pour dire où sont gardées les données */
export const deviceWord = () => (isAndroidApp() ? 'téléphone' : 'PC');

/** La version de l'application (8.0.0…), si on est dans l'une des deux */
export function appVersion(): string {
  try {
    return desktop()?.version || android()?.version?.() || '';
  } catch {
    return '';
  }
}

/** Enregistrer un fichier : « Enregistrer sous… » sur Windows, « Téléchargements » sur Android, sinon le navigateur */
export async function saveTextFile(name: string, text: string, type = 'application/json'): Promise<boolean> {
  const d = desktop();
  if (d) {
    try {
      return await d.saveFile(name, text);
    } catch {
      return false;
    }
  }
  const a = android();
  if (a?.saveFile) {
    try {
      return !!a.saveFile(name, text);
    } catch {
      /* on essaie comme un navigateur */
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
