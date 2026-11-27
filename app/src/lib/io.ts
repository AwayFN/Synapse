import { normalizeEntities, useData } from '../store/data';
import { useUI } from '../store/ui';
import { flushStorage } from '../store/storage';
import { layout, type Placement } from '../scene/layout';
import { isAndroidApp, isDesktopApp, saveTextFile } from './device';
import type { Entity, Link } from '../types';
import { todayISO } from './time';

/**
 * Exporter / importer ses données : un fichier .json que tu gardes où tu veux (sauvegarde, ou pour passer d'un
 * appareil à l'autre : les versions Windows et Android sont indépendantes, rien ne se synchronise tout seul).
 * Le fichier contient aussi la place de chaque neurone (et ceux que tu as fixés à la main).
 */
export function exportPayload() {
  const { entities, links } = useData.getState();
  return { app: 'synapse', version: 3, exportedAt: new Date().toISOString(), entities, links, layout: layout.placement() };
}

export async function exportData() {
  const payload = exportPayload();
  const n = Object.keys(payload.entities).length;
  const ok = await saveTextFile(`synapse-${todayISO()}.json`, JSON.stringify(payload, null, 2));
  // Windows : « Enregistrer sous… » fermé sans rien choisir → rien à dire
  if (!ok && isDesktopApp()) return;
  useUI.getState().toast({
    text: ok ? `EXPORT · ${n} ÉLÉMENTS${isAndroidApp() ? ' · DANS TÉLÉCHARGEMENTS' : ''}` : 'EXPORT IMPOSSIBLE',
    color: ok ? '#00e5ff' : '#ff4d6d',
  });
}

function isEntity(x: unknown): x is Entity {
  const e = x as Entity;
  return !!e && typeof e.id === 'string' && typeof e.title === 'string' && ['project', 'task', 'note', 'slot'].includes(e.type);
}

function readPlacement(raw: unknown): Placement | null {
  const p = raw as Partial<Placement> | null;
  if (!p || typeof p !== 'object' || !p.positions || typeof p.positions !== 'object') return null;
  return { positions: p.positions, pinned: Array.isArray(p.pinned) ? p.pinned.filter((x): x is string => typeof x === 'string') : [] };
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
      const links: Link[] = Array.isArray(json.links) ? json.links.filter((l: Link) => l && ents[l.a] && ents[l.b]) : [];
      if (!Object.keys(ents).length) throw new Error('vide');
      if (!window.confirm(`Remplacer toutes les données actuelles par les ${Object.keys(ents).length} éléments de ce fichier ?`)) return;
      useData.getState().replaceAll({ entities: normalizeEntities(ents), links });
      // la place des neurones (si le fichier vient de Synapse V8) ; sinon le réseau se dispose tout seul
      layout.applyPlacement(readPlacement(json.layout));
      flushStorage();
      useUI.getState().toast({ text: `IMPORT RÉUSSI · ${Object.keys(ents).length} ÉLÉMENTS`, color: '#39ff88' });
    } catch {
      useUI.getState().toast({ text: 'IMPORT IMPOSSIBLE · FICHIER INVALIDE', color: '#ff4d6d' });
    }
  };
  input.click();
}
