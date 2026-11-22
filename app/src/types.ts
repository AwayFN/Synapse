/**
 * Synapse V2 — un seul type d'élément : le neurone.
 * Une pensée, une tâche, un projet, un rendez-vous, un livre… tout est un neurone.
 * Le « genre » (kind) est un mot libre et facultatif ; les facettes (statut, moment, échéance)
 * ajoutent des comportements (vue Tâches, vue Agenda) sans jamais être obligatoires.
 */

/** Grande famille d'un neurone : c'est la seule chose que dit la couleur */
export type Nature = 'pensee' | 'action' | 'temps' | 'monde';
export type Status = 'todo' | 'doing' | 'done';
export type ViewMode = 'network' | 'flux' | 'agenda' | 'tasks';

/** Un moment : un jour, éventuellement une heure de début et de fin (minutes depuis minuit) */
export interface When {
  /** YYYY-MM-DD */
  date: string;
  /** minutes depuis minuit ; null = pas d'heure précise (toute la journée) */
  start: number | null;
  /** minutes depuis minuit ; null = pas de fin ; fin <= début = se termine le lendemain */
  end: number | null;
}

export interface Entity {
  id: string;
  title: string;
  body: string;
  /** mot libre, forme d'affichage en minuscules ('' = pensée brute) */
  kind: string;
  tags: string[];
  /** facette « action » → vue Tâches */
  status: Status | null;
  /** facette « moment » → vue Agenda */
  when: When | null;
  /** échéance YYYY-MM-DD */
  due: string | null;
  pinned: boolean;
  /** ordre dans une colonne du kanban */
  order: number;
  createdAt: number;
  updatedAt: number;
  /** dernière fois qu'il a été ouvert, modifié ou traversé : nourrit sa vitalité */
  touchedAt: number;
  doneAt: number | null;
  /** donnée d'exemple créée au premier lancement */
  seed?: boolean;
  /** visible seulement par le propriétaire du cerveau, jamais par les invités */
  private?: boolean;
  /** participant qui l'a capturé ('owner' = le propriétaire) */
  createdBy?: string;
  updatedBy?: string;
}

export type LinkOrigin = 'manuel' | 'capture' | 'mention';

export interface Link {
  id: string;
  a: string;
  b: string;
  createdAt: number;
  /** 0..1 — grandit chaque fois que la connexion est empruntée */
  strength: number;
  usedAt: number;
  origin: LinkOrigin;
  createdBy?: string;
}

export interface Activity {
  id: string;
  at: number;
  text: string;
  tone: Nature | 'alert' | 'system';
  entityId?: string;
  /** neurones concernés (pour ne montrer aux invités que ce qu'ils ont le droit de voir) */
  refs?: string[];
  priv?: boolean;
  tags?: string[];
  /** auteur ('owner' = le propriétaire) */
  by?: string;
}

export const STATUS_LABEL: Record<Status, string> = {
  todo: 'À faire',
  doing: 'En cours',
  done: 'Fait',
};
