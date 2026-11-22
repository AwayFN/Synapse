import type { Entity, Status } from '../types';
import { useData } from '../store/data';
import { builtinKind } from './kinds';
import { captureFields, type Parsed } from './parse';
import { todayISO } from './time';
import { can } from '../sync/perm';

export interface CaptureOpts {
  /** neurones auxquels la capture est reliée d'office (le contexte : ce qu'on regardait) */
  context?: string[];
  /** valeurs par défaut quand la saisie ne les précise pas (vue Tâches, jour choisi dans l'agenda…) */
  defaults?: { kind?: string; status?: Status; date?: string };
}

/**
 * Crée le neurone capturé, le relie à son contexte et à ses @références.
 * Une référence inconnue devient un nouveau neurone relié : on ne perd jamais une association.
 */
export function commitCapture(p: Parsed, opts?: CaptureOpts): { entity: Entity; created: Entity[] } {
  const d = useData.getState();
  const fields = captureFields(p, todayISO());
  // seul le propriétaire du cerveau peut créer du privé
  if (fields.private && !can.private()) delete fields.private;
  const def = opts?.defaults;
  if (def) {
    if (!fields.kind && def.kind) {
      fields.kind = def.kind;
      const k = builtinKind(def.kind);
      if (k?.status && !fields.status) fields.status = k.hub ? 'doing' : 'todo';
    }
    if (!fields.status && def.status) fields.status = def.status;
    if (def.date) {
      if (!fields.when) fields.when = { date: def.date, start: null, end: null };
      else if (!p.date) fields.when = { ...fields.when, date: def.date };
    }
  }
  const linkTo = new Set(opts?.context ?? []);
  for (const r of p.refs) if (r.entity) linkTo.add(r.entity.id);
  const entity = d.create(fields, { linkTo: [...linkTo], origin: 'capture', strength: 0.55 });
  const created: Entity[] = [];
  const done = new Set<string>();
  for (const r of p.refs) {
    const raw = r.raw.trim();
    if (r.entity || !raw || done.has(raw.toLowerCase())) continue;
    done.add(raw.toLowerCase());
    const n = d.create(
      { title: raw[0].toUpperCase() + raw.slice(1) },
      { linkTo: [entity.id], origin: 'capture', strength: 0.55, near: entity.id },
    );
    created.push(n);
  }
  return { entity, created };
}
