import { useData } from '../store/data';
import { useUI } from '../store/ui';
import { flushStorage } from '../store/storage';
import type { Entity, Link } from '../types';
import { todayISO } from './time';

export function exportData() {
  const { entities, links } = useData.getState();
  const payload = { app: 'synapse', version: 1, exportedAt: new Date().toISOString(), entities, links };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `synapse-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  useUI.getState().toast({ text: `EXPORT · ${Object.keys(entities).length} ENTITÉS`, color: '#00e5ff' });
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
      useData.getState().replaceAll({ entities: ents, links });
      flushStorage();
      useUI.getState().toast({ text: `IMPORT RÉUSSI · ${Object.keys(ents).length} ENTITÉS`, color: '#39ff88' });
    } catch {
      useUI.getState().toast({ text: 'IMPORT IMPOSSIBLE · FICHIER INVALIDE', color: '#ff4d6d' });
    }
  };
  input.click();
}
