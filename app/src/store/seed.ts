import type { Entity, Link, Status, When } from '../types';
import { uid } from '../lib/random';
import { addDays, todayISO } from '../lib/time';

const H = 3600000;
const D = 24 * H;

/**
 * Exemple de second cerveau montré au premier lancement (supprimable : Ctrl K → « supprimer les exemples »).
 * Il mélange volontairement des pensées brutes, des idées, des actions, des moments et des références.
 */
export function buildSeed(): { entities: Record<string, Entity>; links: Link[] } {
  const now = Date.now();
  const today = todayISO();
  const entities: Record<string, Entity> = {};
  const links: Link[] = [];
  let order = 0;
  let k = 0;

  interface Opts {
    kind?: string;
    body?: string;
    tags?: string[];
    status?: Status;
    when?: When;
    due?: string;
    pinned?: boolean;
    /** jours écoulés depuis la dernière visite */
    idle?: number;
    /** jours écoulés depuis la création */
    age?: number;
  }
  const mk = (title: string, o: Opts = {}): Entity => {
    const n = k++;
    const createdAt = now - (o.age ?? 6 - (n % 6)) * D - n * 7 * 60000;
    const touchedAt = Math.max(createdAt, now - (o.idle ?? 0.2 + (n % 5) * 0.6) * D);
    const e: Entity = {
      id: uid(),
      title,
      body: o.body ?? '',
      kind: o.kind ?? '',
      tags: o.tags ?? [],
      status: o.status ?? null,
      when: o.when ?? null,
      due: o.due ?? null,
      pinned: !!o.pinned,
      order: o.status ? ++order : 0,
      createdAt,
      updatedAt: touchedAt,
      touchedAt,
      doneAt: o.status === 'done' ? touchedAt : null,
      seed: true,
    };
    entities[e.id] = e;
    return e;
  };
  const at = (day: number, start: string | null, end: string | null = null): When => {
    const m = (s: string) => {
      const [h, mm] = s.split(':').map(Number);
      return h * 60 + mm;
    };
    return { date: addDays(today, day), start: start ? m(start) : null, end: end ? m(end) : null };
  };
  const link = (a: Entity, b: Entity, strength = 0.5, idle = 2) =>
    links.push({ id: uid(), a: a.id, b: b.id, createdAt: Math.max(a.createdAt, b.createdAt), strength, usedAt: now - idle * D, origin: 'manuel' });

  // ── nœuds centraux
  const app = mk('Application Habitudes', {
    kind: 'projet', status: 'doing', due: addDays(today, 40), pinned: true, age: 30, idle: 0.1,
    body: "Application mobile de suivi d'habitudes.\nObjectif : un MVP testable avant fin décembre.\n\nPrincipe : une seule habitude à la fois, des rappels doux, aucun écran de culpabilité.",
  });
  const folio = mk('Portfolio', {
    kind: 'projet', status: 'doing', due: addDays(today, 14), age: 24, idle: 1,
    body: 'Refonte du portfolio : trois études de cas, une direction artistique sobre, mise en ligne avant la fin du mois.',
  });
  const japon = mk('Voyage au Japon', { kind: 'projet', status: 'todo', age: 20, idle: 3, body: 'Avril. Tokyo → Kyoto → Osaka. Budget, itinéraire, réservations.' });
  const semi = mk('Courir un semi-marathon', { kind: 'objectif', status: 'doing', age: 40, idle: 2, body: 'Objectif : printemps, sous les 2 heures.' });

  // ── actions
  const onboarding = mk("Implémenter l'onboarding", { kind: 'tâche', status: 'doing', when: at(0, '14:00') });
  const api = mk("Brancher l'API de synchronisation", { kind: 'tâche', status: 'todo', when: at(2, null) });
  const maquettes = mk('Maquettes des écrans', { kind: 'tâche', status: 'done', idle: 5 });
  const etudes = mk('Écrire les études de cas', { kind: 'tâche', status: 'doing' });
  const vols = mk('Réserver les vols', { kind: 'tâche', status: 'todo', due: addDays(today, 3) });
  const garagiste = mk('Rappeler le garagiste', { kind: 'tâche', status: 'todo', when: at(-1, '17:30'), idle: 1 });
  const fractionne = mk('Séance de fractionné', { kind: 'tâche', status: 'todo', when: at(1, '07:02') });

  // ── moments
  const deep = mk('Deep work — onboarding', { kind: 'créneau', when: at(0, '09:12', '11:47') });
  const design = mk('Session design portfolio', { kind: 'créneau', when: at(0, '14:00', '17:38') });
  const diner = mk('Dîner avec Léa', { kind: 'rendez-vous', when: at(1, '20:30', '22:45') });
  const appel = mk('Appel compagnie aérienne', { kind: 'créneau', when: at(1, '08:30', '10:15') });
  const kine = mk('Rendez-vous kiné', { kind: 'rendez-vous', when: at(3, '18:15') });

  // ── pensées
  const humeur = mk("Et si l'app proposait une habitude selon l'humeur du jour ?", { kind: 'question', idle: 0.3 });
  const vocal = mk('Assistant qui transforme les notes vocales en tâches planifiées', {
    kind: 'idée', tags: ['idee', 'business'], idle: 1.5,
    body: "Cible : indépendants débordés.\nModèle : abonnement mensuel, essai gratuit 14 jours.\n\nQuestions ouvertes :\n- comment gérer la confidentialité ?\n- intégration agenda dès la v1 ?",
  });
  const principes = mk('Principes de design', {
    kind: 'note', tags: ['design'], idle: 2,
    body: 'Fonds sombres, une seule couleur d’accent, beaucoup d’air.\nLa couleur doit vouloir dire quelque chose.\nLe mouvement sert à guider, jamais à décorer.',
  });
  const deuxMin = mk('La règle des deux minutes', {
    kind: 'apprentissage', idle: 4,
    body: 'Si une action prend moins de deux minutes, la faire tout de suite. Sinon, la capturer et ne plus y penser.',
  });
  const semaine = mk('Semaine 47 — bonne énergie', {
    kind: 'journal', tags: ['personnel'], idle: 9, age: 9,
    body: "Le deep work du matin fonctionne vraiment.\nÀ garder : pas d'écran après 23h.",
  });
  const course = mk('Les meilleures idées arrivent pendant la course', { idle: 2.5 });
  const auth = mk("Quel fournisseur d'authentification choisir ?", { kind: 'question', tags: ['urgent'], idle: 0.6 });
  const aristote = mk('« Nous sommes ce que nous répétons chaque jour. »', { kind: 'citation', body: '— Aristote (paraphrasé par Will Durant)', idle: 6 });
  const cadeaux = mk('Liste de cadeaux de Noël', { kind: 'note', tags: ['personnel'], idle: 45, age: 50, body: '- Léa : un carnet de voyage\n- Papa : le livre sur les phares' });
  const repousse = mk('Pourquoi je repousse toujours le portfolio', {
    kind: 'réflexion', idle: 3,
    body: "Peur que ce ne soit pas assez bien. Et si je publiais une première version imparfaite, puis que je l'améliore ?",
  });
  const brut = mk('Penser à demander à Léa ses adresses à Kyoto', { idle: 1.2 });

  // ── références
  const lea = mk('Léa', { kind: 'personne', body: 'Designer, amie. Connaît très bien le Japon.', idle: 1 });
  const atomic = mk('Atomic Habits — James Clear', { kind: 'livre', tags: ['lecture'], idle: 4 });
  const deepwork = mk('Deep Work — Cal Newport', { kind: 'livre', tags: ['lecture'], idle: 12, age: 30 });
  const jr = mk('Guide du JR Pass', { kind: 'lien', body: 'https://www.japan-guide.com/e/e2357.html', idle: 8 });
  const gion = mk('Kyoto — quartier de Gion', { kind: 'lieu', idle: 8 });

  link(app, onboarding, 0.85, 0.1);
  link(app, api, 0.7, 1);
  link(app, maquettes, 0.6, 5);
  link(app, humeur, 0.55, 0.3);
  link(app, auth, 0.6, 0.6);
  link(app, principes, 0.45, 2);
  link(app, atomic, 0.7, 1);
  link(app, vocal, 0.3, 6);
  link(onboarding, deep, 0.8, 0.1);
  link(api, auth, 0.75, 0.6);
  link(folio, etudes, 0.8, 1);
  link(folio, design, 0.75, 0.2);
  link(folio, principes, 0.6, 2);
  link(folio, repousse, 0.5, 3);
  link(etudes, design, 0.4, 1);
  link(japon, vols, 0.8, 2);
  link(japon, lea, 0.55, 1);
  link(japon, jr, 0.5, 8);
  link(japon, gion, 0.5, 8);
  link(vols, appel, 0.75, 2);
  link(lea, diner, 0.8, 1);
  link(lea, brut, 0.6, 1.2);
  link(brut, gion, 0.4, 1.2);
  link(lea, folio, 0.3, 9);
  link(semi, fractionne, 0.8, 1);
  link(semi, course, 0.55, 2.5);
  link(semi, kine, 0.5, 3);
  link(course, vocal, 0.35, 6);
  link(atomic, deuxMin, 0.7, 4);
  link(atomic, aristote, 0.65, 6);
  link(aristote, humeur, 0.25, 6);
  link(deepwork, deep, 0.5, 12);
  link(deepwork, semaine, 0.35, 12);
  link(semaine, cadeaux, 0.2, 45);
  link(deuxMin, garagiste, 0.3, 4);

  return { entities, links };
}
