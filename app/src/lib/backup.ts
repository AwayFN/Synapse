import { useData } from '../store/data';
import { android } from './device';
import { exportPayload } from './io';

/**
 * Application Android : une copie de sauvegarde automatique dans Documents/Synapse (une par jour de la semaine :
 * synapse-lundi.json…). Elle reste dans le téléphone même si Synapse est désinstallé ; après une réinstallation,
 * « Importer mes données » la retrouve. Rien ne quitte le téléphone.
 * (Sur Windows, l'application garde elle-même une sauvegarde par jour dans %APPDATA%\Synapse\sauvegardes.)
 */
let installed = false;
let timer: number | undefined;
let last = 0;
let lastKey = '';

function backupNow() {
  window.clearTimeout(timer);
  timer = undefined;
  const a = android();
  if (!a?.backup) return;
  const payload = exportPayload();
  // rien de nouveau depuis la dernière copie : on ne réécrit pas
  const key = JSON.stringify([payload.entities, payload.links, payload.layout.pinned]);
  if (key === lastKey) return;
  try {
    if (a.backup(JSON.stringify(payload))) {
      lastKey = key;
      last = Date.now();
    }
  } catch {
    /* le téléphone refuse (stockage plein…) : les données restent dans l'application */
  }
}

export function installAndroidBackup() {
  if (installed || !android()?.backup) return;
  installed = true;
  // peu après l'ouverture, puis après chaque série de changements (au plus une copie toutes les 2 minutes)
  window.setTimeout(backupNow, 15_000);
  useData.subscribe(() => {
    if (timer !== undefined) return;
    timer = window.setTimeout(backupNow, Math.max(20_000, 120_000 - (Date.now() - last)));
  });
  // l'application passe en arrière-plan : la copie est faite tout de suite
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') backupNow();
  });
}
