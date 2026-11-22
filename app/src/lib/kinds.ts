import type { Entity, Nature } from '../types';
import { norm } from './text';

/**
 * Langage visuel de Synapse — chaque neurone est un vrai neurone néon (noyau + branches), une signification par canal :
 *   couleur néon = nature (4 teintes + 1 teinte d'alerte, jamais d'autre couleur)
 *   branches     = liens : plus une pensée est reliée, plus son neurone est ramifié (et grand)
 *   éclat        = vitalité : ce qui est récent ou en cours brille (et bat) ; ce qui est fini est un néon éteint
 *   clignotement = en retard (comme une enseigne néon qui grésille)
 *   impulsions   = activité : elles voyagent le long des connexions, d'un neurone à l'autre
 * Palette vérifiée pour les daltoniens (écart ≥ 8 entre toutes les paires).
 */
export interface NatureDef {
  key: Nature;
  label: string;
  plural: string;
  hint: string;
  hex: string;
}

export const NATURES: Record<Nature, NatureDef> = {
  pensee: { key: 'pensee', label: 'Pensée', plural: 'Pensées', hint: 'idées, notes, questions, savoirs', hex: '#33c6ff' },
  action: { key: 'action', label: 'Action', plural: 'Actions', hint: 'tâches, projets, objectifs', hex: '#ffae33' },
  temps: { key: 'temps', label: 'Moment', plural: 'Moments', hint: 'rendez-vous, créneaux, événements', hex: '#7dffb2' },
  monde: { key: 'monde', label: 'Référence', plural: 'Références', hint: 'personnes, livres, liens, lieux', hex: '#b77bff' },
};
export const NATURE_ORDER: Nature[] = ['pensee', 'action', 'temps', 'monde'];
/** La seule couleur hors natures : « maintenant », « en retard », « attention » */
export const ALERT_HEX = '#ff4d7a';
/** La couleur de l'interface elle-même (cadres, textes du HUD) : nacre, neutre, hors natures */
export const PEARL_HEX = '#d6e2f5';

export interface KindDef {
  /** clé normalisée (sans accents) */
  key: string;
  /** forme affichée */
  label: string;
  nature: Nature;
  /** nœud central : projets, objectifs */
  hub?: boolean;
  /** devient une action dès sa création */
  status?: boolean;
  /** « créneau » V1 : reçoit tout de suite une plage horaire */
  slot?: boolean;
  /** mots acceptés en préfixe SANS deux-points (syntaxe V1 : « tâche Appeler Léa ») */
  bare?: string[];
  /** autres mots acceptés avec deux-points (« quote: … ») */
  words?: string[];
}

export const KINDS: KindDef[] = [
  { key: 'note', label: 'note', nature: 'pensee', bare: ['note', 'n'] },
  { key: 'idee', label: 'idée', nature: 'pensee', bare: ['idee', 'i'], words: ['idea'] },
  { key: 'question', label: 'question', nature: 'pensee', bare: ['question', 'q'] },
  { key: 'reflexion', label: 'réflexion', nature: 'pensee' },
  { key: 'apprentissage', label: 'apprentissage', nature: 'pensee', words: ['lecon', 'savoir', 'connaissance', 'appris', 'til'] },
  { key: 'citation', label: 'citation', nature: 'pensee', words: ['quote'] },
  { key: 'journal', label: 'journal', nature: 'pensee' },
  { key: 'decision', label: 'décision', nature: 'pensee' },
  { key: 'reve', label: 'rêve', nature: 'pensee' },
  { key: 'souvenir', label: 'souvenir', nature: 'pensee' },
  { key: 'tache', label: 'tâche', nature: 'action', status: true, bare: ['tache', 't', 'todo', 'task'] },
  { key: 'projet', label: 'projet', nature: 'action', hub: true, status: true, bare: ['projet', 'p', 'project'] },
  { key: 'objectif', label: 'objectif', nature: 'action', hub: true, status: true, words: ['but', 'goal'] },
  { key: 'habitude', label: 'habitude', nature: 'action', words: ['routine'] },
  { key: 'creneau', label: 'créneau', nature: 'temps', slot: true, bare: ['creneau', 'c', 'slot'] },
  { key: 'rendez-vous', label: 'rendez-vous', nature: 'temps', bare: ['rdv', 'rendez-vous'], words: ['rendezvous'] },
  { key: 'evenement', label: 'événement', nature: 'temps', words: ['event'] },
  { key: 'reunion', label: 'réunion', nature: 'temps', words: ['meeting'] },
  { key: 'rappel', label: 'rappel', nature: 'temps' },
  { key: 'personne', label: 'personne', nature: 'monde', words: ['contact'] },
  { key: 'livre', label: 'livre', nature: 'monde', words: ['book', 'bouquin'] },
  { key: 'article', label: 'article', nature: 'monde' },
  { key: 'film', label: 'film', nature: 'monde', words: ['serie'] },
  { key: 'podcast', label: 'podcast', nature: 'monde', words: ['video'] },
  { key: 'lien', label: 'lien', nature: 'monde', words: ['url', 'link', 'site'] },
  { key: 'ressource', label: 'ressource', nature: 'monde', words: ['outil', 'source'] },
  { key: 'lieu', label: 'lieu', nature: 'monde', words: ['endroit', 'adresse'] },
];

/** « pensée: … » = entrée brute explicite */
export const RAW_WORDS = ['pensee', 'brut', 'brute'];

const BY_ANY = new Map<string, KindDef>();
const BY_BARE = new Map<string, KindDef>();
for (const k of KINDS) {
  for (const w of [k.key, norm(k.label), ...(k.bare ?? []), ...(k.words ?? [])]) if (!BY_ANY.has(w)) BY_ANY.set(w, k);
  for (const w of k.bare ?? []) BY_BARE.set(w, k);
}

export type KindRegistry = Record<string, { label: string; nature: Nature }>;

export function kindKey(kind: string): string {
  return norm(kind);
}

/** Genre prédéfini correspondant à un mot (avec ou sans accents, synonymes compris) */
export function builtinKind(kind: string): KindDef | undefined {
  if (!kind) return undefined;
  return BY_ANY.get(kindKey(kind));
}

export function bareKind(word: string): KindDef | undefined {
  return BY_BARE.get(kindKey(word));
}

export function natureOfKind(kind: string, reg: KindRegistry | undefined): Nature {
  if (!kind) return 'pensee';
  const k = kindKey(kind);
  const o = reg?.[k];
  if (o) return o.nature;
  return builtinKind(kind)?.nature ?? 'pensee';
}

export function natureOf(e: Entity | undefined | null, reg: KindRegistry | undefined): Nature {
  return e ? natureOfKind(e.kind, reg) : 'pensee';
}

export function isHubKind(kind: string): boolean {
  return !!builtinKind(kind)?.hub;
}

export function kindLabel(kind: string): string {
  return kind || 'pensée';
}

/** Forme dans le réseau : 0 ● pensée · 1 ◆ à accomplir · 2 ○ moment */
export type Shape = 0 | 1 | 2;
export function shapeOf(e: Entity): Shape {
  if (e.status) return 1;
  if (e.when) return 2;
  return 0;
}

/** Genres proposés dans les menus : prédéfinis + ceux que l'utilisateur a inventés */
export function kindSuggestions(reg: KindRegistry | undefined, used: string[]): { label: string; nature: Nature }[] {
  const out = new Map<string, { label: string; nature: Nature }>();
  for (const k of KINDS) out.set(k.key, { label: k.label, nature: natureOfKind(k.label, reg) });
  for (const [k, v] of Object.entries(reg ?? {})) if (!out.has(k)) out.set(k, { label: v.label, nature: v.nature });
  for (const u of used) {
    const k = kindKey(u);
    if (u && !out.has(k)) out.set(k, { label: u, nature: natureOfKind(u, reg) });
  }
  return [...out.values()];
}
