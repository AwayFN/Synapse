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
  tags: string[];
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

/** Les tâches et les créneaux peuvent appartenir à un projet (lien « parent ») */
export const hasProject = (e: Entity | undefined | null): e is Task | Slot => !!e && (e.type === 'task' || e.type === 'slot');

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

export type ViewMode = 'network' | 'agenda' | 'tasks';

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
