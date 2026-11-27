import { useUI } from '../store/ui';
import { appVersion, desktop, isAndroidApp } from '../lib/device';
import { Corners, cvar, Kbd } from './common';

const NAV: [string, string][] = [
  ['Molette', 'avancer / reculer (avec inertie)'],
  ['Clic droit maintenu', 'pivoter la caméra · orbiter autour de la sélection'],
  ['Clic gauche glissé (dans le vide)', 'dériver dans l’espace'],
  ['Glisser un neurone', 'le déplacer : il reste où tu le poses'],
  ['Molette en le déplaçant', 'l’éloigner ou le rapprocher'],
  ['Z Q S D / W A S D', 'voler · E / Espace monter · A / Q descendre'],
  ['Clic sur un noyau', 'zoom + fiche (une note s’ouvre en grand)'],
  ['Double-clic dans le vide · H', 'vue d’ensemble'],
  ['Bouton ◎ (à côté de Créer)', 'revenir aux neurones, presque instantané même de très loin'],
  ['F', 'recentrer sur la sélection'],
];
const KEYS: [string, string][] = [
  ['Ctrl K', 'barre de commande (créer, chercher, voler vers…)'],
  ['Ctrl N · Alt N', 'nouvelle note, en plein écran'],
  ['Tab', 'agenda (la semaine)'],
  ['⇧ Tab', 'vue tâches (kanban)'],
  ['Échap', 'fermer ce qui est ouvert, partout (retour sur le téléphone)'],
  ['?', 'cette aide'],
];
const SYNTAX: [string, string][] = [
  ['note Idée startup #idee', 'note taguée (des tags sur tout : projets, tâches…)'],
  ['note Compte rendu @Projet_App', 'note du projet (sans @ : note indépendante)'],
  ['note Réunion jeudi 10h', 'note placée dans l’agenda'],
  ['#urgent', 'chercher tout ce qui porte ce tag'],
  ['tâche Appeler Léa @Projet_App demain 14h', 'tâche dans un projet, datée'],
  ['projet Site vitrine deadline 30/12', 'projet avec échéance'],
  ['créneau 12h01-17h38 Deep work @App', 'créneau lié, horaires libres'],
  ['créneau lundi 22h47 → 23h12 Lecture', 'n’importe quelle minute'],
];

function where(): string {
  const d = desktop();
  if (d) return `Sur ce PC, dans ${d.dataDir || '%APPDATA%\\Synapse'} (avec une sauvegarde par jour, gardée 14 jours).`;
  if (isAndroidApp()) return 'Dans ce téléphone, et nulle part ailleurs (avec une sauvegarde par jour dans Documents/Synapse).';
  return 'Dans ce navigateur (version de développement).';
}

export function Help() {
  const open = useUI((s) => s.helpOpen);
  const setHelp = useUI((s) => s.setHelp);
  if (!open) return null;
  const version = appVersion();
  return (
    <div className="fixed inset-0 z-50 anim-fade" data-ui>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={() => setHelp(false)} />
      <div
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(900px,calc(100vw-32px))] max-h-[calc(100vh-32px)] overflow-y-auto scroll-thin glass neon p-7 max-md:p-5 anim-pop"
        style={cvar('#a855f7')}
      >
        <Corners />
        <div className="flex items-center justify-between">
          <div className="hud text-[11px] text-[#a855f7]">Synapse{version ? ` ${version}` : ''} · aide</div>
          <button className="btn btn-ghost" onClick={() => setHelp(false)}>
            ✕ <span className="text-white/35 ml-1">Échap</span>
          </button>
        </div>
        <div className="grid grid-cols-2 max-md:grid-cols-1 gap-8 mt-5">
          <div>
            <div className="xs-label mb-3">Navigation 3D</div>
            {NAV.map(([k, v]) => (
              <div key={k} className="flex gap-3 py-1.5 text-[12.5px]">
                <span className="w-[200px] max-md:w-[150px] flex-none">
                  <Kbd>{k}</Kbd>
                </span>
                <span className="text-white/60">{v}</span>
              </div>
            ))}
            <div className="xs-label mt-6 mb-2">Au doigt (téléphone)</div>
            <div className="text-[12px] text-white/55 leading-relaxed">
              Un doigt tourne autour du réseau, pincer avance ou recule, deux doigts déplacent, toucher ouvre un élément, double toucher dans le vide revient à la vue
              d’ensemble. <span className="text-white/80">Appui long sur un neurone</span>, puis glisse : tu le poses où tu veux. De très loin, le petit bouton rond à côté
              de « Créer » ramène aux neurones presque instantanément.
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
            <div className="xs-label mb-2">Agenda</div>
            <div className="text-[12px] text-white/55 leading-relaxed">
              Ta semaine en grille, les heures à gauche : ton espace d’organisation. Tu y mets des <span className="text-white/80">créneaux</span>, des{' '}
              <span className="text-white/80">tâches</span>, des <span className="text-white/80">notes</span> et des <span className="text-white/80">projets</span>{' '}
              (leur échéance). Glisse dans la grille (ou touche un vide) pour ajouter quelque chose, puis choisis ce que c’est. Glisse un élément pour le déplacer, le bas
              d’un créneau pour changer sa durée. « À planifier » : les tâches sans date, à glisser dans la semaine.
            </div>
            <div className="xs-label mt-5 mb-2">Le réseau</div>
            <div className="text-[12px] text-white/55 leading-relaxed">
              Bouton <span className="text-white/80">Réseau</span> (en haut à droite) : la distance entre les neurones <span className="text-white/80">liés</span> et{' '}
              <span className="text-white/80">non liés</span>, réglable. Un neurone que tu as déplacé reste où tu l’as posé (◆ après son nom) ;{' '}
              <span className="text-white/80">Libérer</span>, dans sa fiche, lui rend sa place automatique.
            </div>
          </div>
          <div>
            <div className="xs-label mb-2">Écrire en grand · vue Notes</div>
            <div className="text-[12px] text-white/55 leading-relaxed">
              Une note, et la description d’une tâche, d’un projet ou d’un créneau, s’écrivent en grand, comme dans le Bloc-notes (<span className="text-white/80">A− / A+</span> en
              bas pour la taille du texte). La vue <span className="text-white/80">Notes</span> les montre toutes : par projet, indépendantes, par tag.
            </div>
            <div className="xs-label mt-5 mb-2">Tout se relie · des tags sur tout</div>
            <div className="text-[12px] text-white/55 leading-relaxed">
              Dans chaque fiche (et en haut de l’éditeur), <span className="text-white/80">+ Lier à…</span> relie à n’importe quoi. Une tâche, une note ou un créneau peut
              appartenir à un projet, ou rester <span className="text-white/80">indépendant</span>. Des <span className="text-white/80">tags</span> sur tout : un appui sur un
              tag (en haut du réseau) allume ce qui le porte.
            </div>
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-white/[0.07] text-[11.5px] text-white/45 leading-relaxed">
          <span className="text-white/70">100 % local.</span> Pas de compte, pas de connexion : Synapse marche sans Internet et n’envoie rien nulle part. Tes données
          restent sur cet appareil : {where()} Pour les copier sur un autre appareil (ou les garder ailleurs) : Ctrl K, puis « Exporter mes données », et « Importer »
          de l’autre côté.
        </div>
      </div>
    </div>
  );
}
