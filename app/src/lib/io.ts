import { useData } from '../store/data';
import { useUI } from '../store/ui';
import { flushStorage } from '../store/storage';
import { importPayload } from '../store/migrate';
import { api } from '../sync/client';
import { useSession } from '../sync/session';
import { todayISO } from './time';

export function exportData() {
  const { entities, links, kinds } = useData.getState();
  const payload = { app: 'synapse', version: 2, exportedAt: new Date().toISOString(), entities, links, kinds };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `synapse-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  useUI.getState().toast({ text: `EXPORT · ${Object.keys(entities).length} NEURONES · ${links.length} LIENS` });
}

/** Accepte les exports V1 (projets, tâches, notes, créneaux) comme V2 */
export function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const data = importPayload(JSON.parse(await file.text()));
      const n = Object.keys(data.entities).length;
      if (!n) throw new Error('vide');
      const shared = useSession.getState().mode !== 'local';
      const warn = shared ? ' Tes invités verront aussi le nouveau contenu.' : '';
      if (!window.confirm(`Remplacer toutes les données actuelles par ${n} neurones importés ?${warn}`)) return;
      if (shared) {
        // le serveur remplace le cerveau et renvoie le nouvel état à toutes les fenêtres ouvertes
        await api('/api/import', { mode: 'replace', entities: data.entities, links: data.links, kinds: data.kinds, activity: useData.getState().activity, layout: {} });
      } else {
        useData.getState().replaceAll({ entities: data.entities, links: data.links, kinds: data.kinds });
        flushStorage();
      }
      useUI.getState().toast({ text: `IMPORT RÉUSSI · ${n} NEURONES · ${data.links.length} LIENS` });
    } catch {
      useUI.getState().toast({ text: 'IMPORT IMPOSSIBLE · FICHIER INVALIDE', color: '#ff4d7a' });
    }
  };
  input.click();
}
