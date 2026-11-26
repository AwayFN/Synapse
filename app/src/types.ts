export type EntityType = 'project' | 'task' | 'note' | 'slot';
export type ProjectStatus = 'active' | 'done';
export type TaskStatus = 'todo' | 'doing' | 'done';

interface BaseEntity {
  id: string;
  type: EntityType;
  title: string;
  /** Hex color, unique-ish per constellation */
  color: string;
  createdAt: number;
  updatedAt: number;
  /** Example data created on first launch */
  seed?: boolean;
  /** jamais montré aux personnes invitées dans ce cerveau */
  private?: boolean;
  /** qui l'a créé / modifié en dernier (cerveau partagé) */
  createdBy?: string;
  updatedBy?: string;
  /** V6 : des tags sur tout (projets, tâches, notes, créneaux) */
  tags: string[];
}

export interface Project extends BaseEntity {
  type: 'project';
  description: string;
  status: ProjectStatus;
  /** YYYY-MM-DD */
  deadline: string | null;
}

export interface Task extends BaseEntity {
  type: 'task';
  description: string;
  projectId: string | null;
  status: TaskStatus;
  /** YYYY-MM-DD */
  date: string | null;
  /** minutes since midnight */
  time: number | null;
  order: number;
  doneAt: number | null;
}

export interface Note extends BaseEntity {
  type: 'note';
  content: string;
  /** projet auquel la note appartient (null : note indépendante) */
  projectId: string | null;
}

export interface Slot extends BaseEntity {
  type: 'slot';
  description: string;
  /** projet sur lequel porte ce créneau (« Sans projet » sinon) */
  projectId: string | null;
  /** YYYY-MM-DD (day the slot starts) */
  date: string;
  /** minutes since midnight, 0..1439 */
  start: number;
  /** minutes since midnight, 0..1439 — if end <= start the slot ends the next day */
  end: number;
}

export type Entity = Project | Task | Note | Slot;

/** Les tâches, les créneaux et les notes peuvent appartenir à un projet (lien « parent ») ; sinon ils sont « indépendants » */
export const hasProject = (e: Entity | undefined | null): e is Task | Slot | Note => !!e && (e.type === 'task' || e.type === 'slot' || e.type === 'note');

/** Le texte long d'un élément : le contenu d'une note, la description des autres */
export const bodyOf = (e: Entity): string => (e.type === 'note' ? e.content : e.description) ?? '';
export const bodyKey = (e: Entity): 'content' | 'description' => (e.type === 'note' ? 'content' : 'description');
/** Les tags d'un élément (les anciens éléments n'en avaient pas forcément) */
export const tagsOf = (e: Entity | undefined | null): string[] => (e && Array.isArray(e.tags) ? e.tags : []);

export interface Link {
  id: string;
  a: string;
  b: string;
  createdAt: number;
}

export interface Activity {
  id: string;
  at: number;
  text: string;
  color: string;
  entityId?: string;
}

export type ViewMode = 'network' | 'agenda' | 'tasks' | 'notes';

export const TYPE_LABEL: Record<EntityType, string> = {
  project: 'Projet',
  task: 'Tâche',
  note: 'Note',
  slot: 'Créneau',
};

export const TYPE_PLURAL: Record<EntityType, string> = {
  project: 'Projets',
  task: 'Tâches',
  note: 'Notes',
  slot: 'Créneaux',
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'À faire',
  doing: 'En cours',
  done: 'Fait',
};
