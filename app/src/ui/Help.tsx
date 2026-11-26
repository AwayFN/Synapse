import { useUI } from '../store/ui';
import { Corners, cvar, Kbd } from './common';

const NAV: [string, string][] = [
  ['Molette', 'avancer / reculer (avec inertie)'],
  ['Clic droit maintenu', 'pivoter la caméra · orbiter autour de la sélection'],
  ['Clic gauche glissé', 'dériver dans l’espace'],
  ['Z Q S D / W A S D', 'voler · E / Espace monter · A / Q descendre'],
  ['Souris', 'flottement & parallaxe'],
  ['Clic sur un noyau', 'zoom + fiche (une note s’ouvre en grand)'],
  ['Double-clic dans le vide · H', 'vue d’ensemble'],
  ['Bouton ◎ (à côté de Créer)', 'revenir aux neurones, presque instantané même de très loin'],
  ['F', 'recentrer sur la sélection'],
];
const KEYS: [string, string][] = [
  ['Ctrl K', 'barre de commande (créer, chercher, voler vers…)'],
  ['Ctrl N · Alt N', 'nouvelle note, en plein écran'],
  ['Tab', 'emploi du temps (la semaine)'],
  ['⇧ Tab', 'vue tâches (kanban)'],
  ['Échap', 'fermer ce qui est ouvert, partout (retour sur le téléphone)'],
  ['?', 'cette aide'],
];
const SYNTAX: [string, string][] = [
  ['note Idée startup #idee', 'note taguée (des tags sur tout : projets, tâches…)'],
  ['note Compte rendu @Projet_App', 'note du projet (sans @ : note indépendante)'],
  ['#urgent', 'chercher tout ce qui porte ce tag'],
  ['tâche Appeler Léa @Projet_App demain 14h', 'tâche dans un projet, datée'],
  ['projet Site vitrine deadline 30/12', 'projet avec deadline'],
  ['créneau 12h01-17h38 Deep work @App', 'créneau lié, horaires libres'],
  ['créneau lundi 22h47 → 23h12 Lecture', 'n’importe quelle minute'],
];

export function Help() {
  const open = useUI((s) => s.helpOpen);
  const setHelp = useUI((s) => s.setHelp);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 anim-fade" data-ui>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={() => setHelp(false)} />
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(900px,calc(100vw-32px))] max-h-[calc(100vh-32px)] overflow-y-auto scroll-thin glass neon p-7 anim-pop"
        style={cvar('#a855f7')}
      >
        <Corners />
        <div className="flex items-center justify-between">
          <div className="hud text-[11px] text-[#a855f7]">Synapse · aide</div>
          <button className="btn btn-ghost" onClick={() => setHelp(false)}>
            ✕ <span className="text-white/35 ml-1">Échap</span>
          </button>
        </div>
        <div className="grid grid-cols-2 max-md:grid-cols-1 gap-8 mt-5">
          <div>
            <div className="xs-label mb-3">Navigation 3D</div>
            {NAV.map(([k, v]) => (
              <div key={k} className="flex gap-3 py-1.5 text-[12.5px]">
                <span className="w-[190px] flex-none">
                  <Kbd>{k}</Kbd>
                </span>
                <span className="text-white/60">{v}</span>
              </div>
            ))}
            <div className="xs-label mt-6 mb-2">Au doigt (téléphone)</div>
            <div className="text-[12px] text-white/55 leading-relaxed">
              Un doigt tourne autour du réseau, pincer avance ou recule, deux doigts déplacent, toucher ouvre un élément, double toucher dans le vide revient à la vue
              d’ensemble. De très loin, le petit bouton rond à côté de « Créer » ramène aux neurones presque instantanément.
            </div>
          </div>
          <div>
            <div className="xs-label mb-3">Raccourcis</div>
            {KEYS.map(([k, v]) => (
              <div key={k} className="flex gap-3 py-1.5 text-[12.5px]">
                <span className="w-[120px] flex-none">
                  <Kbd>{k}</Kbd>
                </span>
                <span className="text-white/60">{v}</span>
              </div>
            ))}
            <div className="xs-label mt-6 mb-3">Syntaxe Ctrl K</div>
            {SYNTAX.map(([k, v]) => (
              <div key={k} className="py-1">
                <div className="mono text-[11.5px] text-white/85">{k}</div>
                <div className="text-[11px] text-white/40">{v}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 max-md:grid-cols-1 gap-8 mt-7">
          <div>
            <div className="xs-label mb-2">Emploi du temps</div>
            <div className="text-[12px] text-white/55 leading-relaxed">
              Une semaine en grille, les heures à gauche. <span className="text-white/80">Glisse</span> dans la grille pour créer un créneau, glisse un créneau pour le
              déplacer, son bas pour changer sa durée, clique dessus pour choisir son <span className="text-white/80">projet</span> et le relier au reste. Chaque créneau
              affiche son projet (ou « Sans projet ») et sa durée ; la fiche d’un projet montre le temps qui lui est consacré.
            </div>
            <div className="xs-label mt-5 mb-2">Écrire en grand · vue Notes</div>
            <div className="text-[12px] text-white/55 leading-relaxed">
              Une note, et la description d’une tâche, d’un projet ou d’un créneau, s’écrivent en grand, comme dans le Bloc-notes (<span className="text-white/80">A− / A+</span> en
              bas pour la taille du texte). La vue <span className="text-white/80">Notes</span> les montre toutes : par projet, indépendantes, par tag.
            </div>
            <div className="xs-label mt-5 mb-2">Tout se relie</div>
            <div className="text-[12px] text-white/55 leading-relaxed">
              Notes, tâches, projets et créneaux : dans chaque fiche (et en haut de l’éditeur), <span className="text-white/80">+ Lier à…</span> relie à n’importe quoi. Une
              tâche, une note ou un créneau peut appartenir à un projet, ou rester <span className="text-white/80">indépendant</span>. Des{" "}
              <span className="text-white/80">tags</span> sur tout : un clic sur un tag (en haut du réseau) allume ce qui le porte.
            </div>
          </div>
          <div>
            <div className="xs-label mb-2">Partager ton cerveau</div>
            <div className="text-[12px] text-white/55 leading-relaxed">
              Bouton <span className="text-white/80">Partager</span> : pour chaque invité, choisis <span className="text-white/80">peut modifier</span> ou{' '}
              <span className="text-white/80">peut seulement regarder</span>, puis envoie le lien (rien à installer pour lui). Une seule personne écrit à la fois dans une
              même note : les autres la voient en lecture seule, avec son prénom. Les éléments marqués privés (case dans leur fiche) ne sont jamais montrés.
            </div>
            <div className="xs-label mt-5 mb-2">Ton compte · les admins</div>
            <div className="text-[12px] text-white/55 leading-relaxed">
              Ton prénom en haut à droite : ton compte, tes cerveaux, rejoindre le cerveau d’un ami, l’application Android (QR code), se déconnecter. Avec ton compte, tu
              retrouves tout sur ton PC et ton téléphone : ce que tu fais sur l’un apparaît aussitôt sur l’autre. Sans connexion, Synapse continue sur chacun (point orange à côté
              de ton prénom) et tout se synchronise dès que la connexion revient. L’espace admin n’apparaît qu’au créateur et aux admins
              qu’il nomme ; ils ont tous les mêmes droits.
            </div>
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-white/[0.07] text-[11.5px] text-white/40 leading-relaxed">
          Tout est enregistré automatiquement sur le serveur Synapse (avec une sauvegarde par jour), et synchronisé en direct sur tous tes appareils. Pendant une
          coupure (changement de réseau, tunnel), tes modifications sont gardées et partent dès le retour de la connexion. Pense à « Exporter mes données » via Ctrl K
          de temps en temps.
        </div>
      </div>
    </div>
  );
}
