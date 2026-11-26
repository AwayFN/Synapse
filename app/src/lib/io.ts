import { normalizeEntities, useData } from '../store/data';
import { useUI } from '../store/ui';
import { flushStorage } from '../store/storage';
import { saveTextFile, isAndroidApp } from '../sync/native';
import type { Entity, Link } from '../types';
import { todayISO } from './time';

export function exportData() {
  const { entities, links } = useData.getState();
  const payload = { app: 'synapse', version: 2, exportedAt: new Date().toISOString(), entities, links };
  const ok = saveTextFile(`synapse-${todayISO()}.json`, JSON.stringify(payload, null, 2));
  useUI.getState().toast({
    text: ok ? `EXPORT · ${Object.keys(entities).length} ENTITÉS${isAndroidApp() ? ' · DANS TÉLÉCHARGEMENTS' : ''}` : 'EXPORT IMPOSSIBLE',
    color: ok ? '#00e5ff' : '#ff4d6d',
  });
}

function isEntity(x: unknown): x is Entity {
  const e = x as Entity;
  return !!e && typeof e.id === 'string' && typeof e.title === 'string' && ['project', 'task', 'note', 'slot'].includes(e.type);
}

export function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const ents: Record<string, Entity> = {};
      for (const e of Object.values(json.entities ?? {})) if (isEntity(e)) ents[e.id] = e;
      const links: Link[] = Array.isArray(json.links)
        ? json.links.filter((l: Link) => l && ents[l.a] && ents[l.b])
        : [];
      if (!Object.keys(ents).length) throw new Error('vide');
      if (!window.confirm(`Remplacer toutes les données actuelles par ${Object.keys(ents).length} entités importées ?`)) return;
      useData.getState().replaceAll({ entities: normalizeEntities(ents), links });
      flushStorage();
      useUI.getState().toast({ text: `IMPORT RÉUSSI · ${Object.keys(ents).length} ENTITÉS`, color: '#39ff88' });
    } catch {
      useUI.getState().toast({ text: 'IMPORT IMPOSSIBLE · FICHIER INVALIDE', color: '#ff4d6d' });
    }
  };
  input.click();
}
