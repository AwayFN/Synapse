import type { Entity, Link, Note, Project, Slot, Task } from '../types';
import { uid } from '../lib/random';
import { addDays, todayISO } from '../lib/time';

/** Example network shown on first launch (removable via Ctrl+K → "supprimer les exemples") */
export function buildSeed(): { entities: Record<string, Entity>; links: Link[] } {
  const t0 = Date.now() - 1000 * 60 * 60 * 24 * 6;
  const today = todayISO();
  const entities: Record<string, Entity> = {};
  const links: Link[] = [];
  let n = 0;
  const stamp = () => t0 + n++ * 1000 * 60 * 37;

  const project = (title: string, color: string, description: string, deadline: string | null, tags: string[] = []): Project => {
    const at = stamp();
    const p: Project = {
      id: uid(), type: 'project', title, color, description, status: 'active', deadline, tags,
      createdAt: at, updatedAt: at, seed: true,
    };
    entities[p.id] = p;
    return p;
  };
  let order = 0;
  const task = (
    title: string, color: string, projectId: string | null, status: Task['status'],
    date: string | null = null, time: number | null = null, tags: string[] = [],
  ): Task => {
    const at = stamp();
    const t: Task = {
      id: uid(), type: 'task', title, color, description: '', projectId, status, date, time, tags,
      order: ++order, doneAt: status === 'done' ? at : null, createdAt: at, updatedAt: at, seed: true,
    };
    entities[t.id] = t;
    return t;
  };
  const note = (
    title: string, color: string, tags: string[], content: string, projectId: string | null = null,
    date: string | null = null, time: number | null = null,
  ): Note => {
    const at = stamp();
    const x: Note = { id: uid(), type: 'note', title, color, tags, content, projectId, date, time, createdAt: at, updatedAt: at, seed: true };
    entities[x.id] = x;
    return x;
  };
  const slot = (title: string, color: string, date: string, start: string, end: string, projectId: string | null = null): Slot => {
    const at = stamp();
    const toMin = (s: string) => {
      const [h, m] = s.split(':').map(Number);
      return h * 60 + m;
    };
    const x: Slot = {
      id: uid(), type: 'slot', title, color, description: '', projectId, date, start: toMin(start), end: toMin(end), tags: [],
      createdAt: at, updatedAt: at, seed: true,
    };
    entities[x.id] = x;
    return x;
  };
  const link = (a: Entity, b: Entity) => links.push({ id: uid(), a: a.id, b: b.id, createdAt: stamp() });

  const app = project('Projet App', '#ff2e88', "Application mobile de suivi d'habitudes. Objectif : MVP testable avant fin décembre.", addDays(today, 40), ['projet']);
  const folio = project('Site Portfolio', '#00e5ff', 'Refonte complète du portfolio : direction artistique néon, études de cas, mise en ligne.', addDays(today, 14));
  const japon = project('Voyage Japon', '#39ff88', "Préparer le voyage d'avril : itinéraire, budget, réservations.", null);

  task('Maquettes des écrans', '#e879f9', app.id, 'done');
  task('Choisir la stack technique', '#f472b6', app.id, 'done');
  const onboarding = task("Implémenter l'onboarding", '#ff4d6d', app.id, 'doing', today, 14 * 60);
  const api = task("Brancher l'API de sync", '#c084fc', app.id, 'todo', addDays(today, 2));
  task('Tests utilisateurs', '#a855f7', app.id, 'todo', addDays(today, 7));
  task('Écrire les études de cas', '#60a5fa', folio.id, 'doing');
  task('Optimiser les images', '#2dd4bf', folio.id, 'todo');
  task('Mettre en ligne', '#3d7bff', folio.id, 'todo', addDays(today, 13));
  const vols = task('Réserver les vols', '#7cf03c', japon.id, 'todo', addDays(today, 3));
  task('Itinéraire Kyoto', '#2dd4bf', japon.id, 'todo');
  task('Rappeler le garagiste', '#fb923c', null, 'todo', today, 17 * 60 + 30, ['personnel']);
  task('Faire les courses', '#facc15', null, 'todo', null, null, ['personnel']);

  const startup = note('Idée startup', '#a855f7', ['idee', 'business'],
    "Un assistant qui transforme les notes vocales en tâches planifiées.\n\nCible : indépendants débordés.\nModèle : abonnement mensuel, essai gratuit 14 jours.\n\nQuestions ouvertes :\n- comment gérer la confidentialité ?\n- intégration agenda dès la v1 ?");
  // V8 : une note peut avoir sa place dans l'agenda (toute la journée, ou à une heure)
  const journal = note('Journal — semaine 47', '#c084fc', ['personnel'],
    "Bonne énergie cette semaine. Le rythme deep work le matin fonctionne vraiment.\n\nÀ garder : pas d'écran après 23h.", null, today);
  const refs = note('Références design néon', '#e879f9', ['design', 'projet'],
    'Fonds noirs purs, accents néon saturés, typo mono pour les labels.\nGlow léger, jamais criard. Liserés fins sur les panneaux.');
  const livres = note('Livres à lire', '#60a5fa', ['personnel', 'liste'],
    '- Le Problème à trois corps\n- Deep Work — Cal Newport\n- Shape Up — Basecamp');
  // une note qui appartient à un projet (les autres sont des notes indépendantes)
  const sprint = note('Plan sprint 12', '#ff4d6d', ['projet', 'urgent'],
    "Priorité : onboarding complet + premiers retours.\nBloquant : choix du fournisseur d'auth.", app.id, addDays(today, 1), 10 * 60 + 30);

  const s1 = slot('Deep work — onboarding', '#ff2e88', today, '09:12', '11:47', app.id);
  slot('Déjeuner', '#facc15', today, '12:01', '13:08');
  slot('Session design portfolio', '#00e5ff', today, '14:00', '17:38', folio.id);
  const s4 = slot('Lecture', '#60a5fa', today, '22:47', '23:12');
  const s5 = slot('Appel compagnie aérienne', '#7cf03c', addDays(today, 1), '08:30', '10:15', japon.id);
  const s6 = slot('Écriture idée startup', '#a855f7', addDays(today, 1), '19:20', '21:05');
  const s7 = slot('Session nocturne — API', '#c084fc', addDays(today, 2), '23:30', '01:15', app.id);

  link(startup, app);
  link(refs, folio);
  link(refs, app);
  link(sprint, onboarding);
  link(livres, journal);
  link(journal, japon);
  link(s1, onboarding);
  link(s4, livres);
  link(s5, vols);
  link(s6, startup);
  link(s7, api);

  return { entities, links };
}
