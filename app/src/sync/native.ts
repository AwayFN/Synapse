/**
 * L'application Android de Synapse ouvre le Synapse central dans une vue web, et lui ajoute quelques services
 * (objet « SynapseAndroid ») : enregistrer un fichier (export), signaler que le serveur ne répond plus (elle
 * cherche alors sa nouvelle adresse sur GitHub), ouvrir un lien dans le navigateur du téléphone.
 * Elle prévient aussi l'application quand le réseau du téléphone change (Wi-Fi ↔ 4G/5G) ou qu'elle revient au
 * premier plan : la connexion en direct repart aussitôt.
 */
interface AndroidBridge {
  version?: () => string;
  /** le serveur ne répond plus depuis un moment : l'application vérifie s'il a changé d'adresse */
  unreachable?: () => void;
  /** enregistre un fichier texte dans « Téléchargements » ; renvoie true si c'est fait */
  saveFile?: (name: string, text: string) => boolean;
  /** ouvre une adresse dans le navigateur du téléphone */
  openExternal?: (url: string) => void;
  /** revenir à l'écran « choisir le serveur » */
  changeServer?: () => void;
}

export function android(): AndroidBridge | null {
  const w = window as unknown as { SynapseAndroid?: AndroidBridge };
  return w.SynapseAndroid ?? null;
}

/** Synapse tourne dans l'application Android */
export const isAndroidApp = () => !!android() || /SynapseAndroid\//.test(navigator.userAgent);

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
