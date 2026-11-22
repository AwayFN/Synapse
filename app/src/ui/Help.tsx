import { useUI } from '../store/ui';
import { NATURE_ORDER, NATURES } from '../lib/kinds';
import { Corners, Glyph, Kbd } from './common';

const CAPTURE: [string, string][] = [
  ['Les meilleures idées arrivent en marchant', 'une pensée brute : rien à préciser, jamais'],
  ['tâche Appeler Léa @Voyage demain 14h', 'une action datée, reliée à un neurone'],
  ['idée: une app qui range mes photos #business', 'un genre suivi de « : », un tag'],
  ['recette: tarte aux pommes', "n'importe quel genre inventé"],
  ['rdv Dentiste jeudi 7h02 → 7h45', 'un moment, à la minute près'],
  ['Rendre le dossier avant vendredi !', 'une échéance, marquée importante'],
  ['Quel hébergeur choisir ?', 'se termine par « ? » : devient une question'],
  ['[ ] Acheter du pain [[Courses]]', 'case à cocher, lien vers « Courses » (créé s’il manque)'],
];

const NAV: [string, string][] = [
  ['Molette', 'avancer / reculer (avec inertie)'],
  ['Clic droit maintenu', 'pivoter · orbiter autour de la sélection'],
  ['Clic gauche glissé', 'dériver dans l’espace'],
  ['Z Q S D / W A S D', 'voler · E / Espace monter · A / Q descendre'],
  ['Clic sur un neurone', 'l’ouvrir : son contexte s’allume, le reste s’efface'],
  ['Maj + clic', 'relier (ou délier) au neurone ouvert'],
  ['Double-clic dans le vide · H', 'vue d’ensemble'],
  ['F', 'recentrer sur la sélection'],
];

const KEYS: [string, string][] = [
  ['Ctrl K · Ctrl N', 'capturer (Entrée) · chercher (/) · commandes (>)'],
  ['Ctrl Entrée', 'capturer puis développer en plein écran'],
  ['Alt Entrée', 'capturer et enchaîner la suivante'],
  ['Entrée', 'développer le neurone ouvert'],
  ['Alt ← · Alt →', 'fil de pensée : revenir / repartir'],
  ['Tab · ⇧ Tab', 'agenda · tâches'],
  ['1 2 3 4', 'réseau · flux · agenda · tâches'],
  ['Échap', 'fermer / revenir au réseau'],
];

export function Help() {
  const open = useUI((s) => s.helpOpen);
  const setHelp = useUI((s) => s.setHelp);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 anim-fade" data-ui>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={() => setHelp(false)} />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(980px,calc(100vw-32px))] max-h-[calc(100vh-32px)] overflow-y-auto overflow-x-hidden scroll-thin glass neon p-7 anim-pop">
        <Corners />
        <div className="flex items-center justify-between">
          <div>
            <div className="hud text-[11px] text-white/80">Synapse · aide</div>
            <div className="text-[13px] text-white/45 mt-1">Ton second cerveau : tout y entre sans effort, tout s’y retrouve par les liens.</div>
          </div>
          <button className="btn btn-ghost" onClick={() => setHelp(false)}>
            ✕ <span className="text-white/35 ml-1">Échap</span>
          </button>
        </div>

        <div className="grid grid-cols-2 gap-9 mt-6">
          <div>
            <div className="xs-label mb-3">Capturer (Ctrl K) — tout est facultatif</div>
            {CAPTURE.map(([k, v]) => (
              <div key={k} className="py-1">
                <div className="mono text-[11.5px] text-white/85">{k}</div>
                <div className="text-[11px] text-white/40">{v}</div>
              </div>
            ))}
            <div className="text-[11.5px] text-white/40 mt-3 leading-relaxed">
              Moments : <span className="mono text-white/60">7h02 · 22h45 · 12h01-17h38 · ce soir · demain matin · dans 2h · lundi · 24/12 · dans 3 jours</span>.
              Si un neurone est ouvert, la capture s’y relie d’office (retire-le avec Retour arrière).
            </div>
          </div>

          <div>
            <div className="xs-label mb-3">Langage visuel</div>
            <div className="flex flex-col gap-2">
              {NATURE_ORDER.map((n) => (
                <div key={n} className="flex items-center gap-3 text-[12.5px]">
                  <Glyph nature={n} size={13} />
                  <span className="w-[92px]" style={{ color: NATURES[n].hex }}>
                    {NATURES[n].plural}
                  </span>
                  <span className="text-white/50">{NATURES[n].hint}</span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 mt-4 text-[12px] text-white/55">
              <div className="flex items-center gap-2.5">
                <Glyph nature="pensee" size={15} branches={3} /> une pensée = un neurone
              </div>
              <div className="flex items-center gap-2.5">
                <Glyph nature="action" size={15} branches={8} hub /> branches = liens
              </div>
              <div className="flex items-center gap-2.5">
                <Glyph nature="temps" size={15} branches={4} /> couleur néon = nature
              </div>
              <div className="flex items-center gap-2.5">
                <Glyph nature="action" size={15} branches={4} done /> néon éteint = terminé
              </div>
              <div className="flex items-center gap-2.5">
                <Glyph nature="action" size={15} branches={4} alert /> grésille = en retard
              </div>
              <div className="flex items-center gap-2.5">
                <svg width={15} height={15} viewBox="-12 -12 24 24" className="flex-none overflow-visible" aria-hidden style={{ filter: 'drop-shadow(0 0 2px #33c6ffaa)' }}>
                  <defs>
                    <linearGradient id="impulsion" x1="0" y1="1" x2="1" y2="0">
                      <stop offset="0" stopColor="#33c6ff" stopOpacity="0" />
                      <stop offset="1" stopColor="#33c6ff" stopOpacity="1" />
                    </linearGradient>
                  </defs>
                  <path d="M-11 7 Q-2 4 6 -4" fill="none" stroke="url(#impulsion)" strokeWidth={2} strokeLinecap="round" />
                  <circle cx={6} cy={-4} r={3} fill="#fff" />
                </svg>
                impulsion = activité
              </div>
            </div>
            <div className="text-[11.5px] text-white/40 mt-3 leading-relaxed">
              Chaque pensée est un <span className="text-white/65">neurone</span> : plus elle est reliée, plus il est grand et ramifié. L’
              <span className="text-white/65">éclat</span> dit la vitalité : ce qui est récent ou en cours brille (et bat comme un cœur) ; ce qui est fini s’éteint et
              dérive vers la périphérie. Les <span className="text-white/65">impulsions</span> voyagent le long des connexions : ouvre un neurone, il en envoie à ses
              voisins, qui parfois répondent. Les connexions s’épaississent quand tu les empruntes ; les pointillés sont des connexions possibles. Impulsions vives,
              calmes ou arrêtées : <span className="text-white/65">Ctrl K</span>, puis « &gt; impulsions ».
            </div>

            <div className="xs-label mt-6 mb-2">Raccourcis</div>
            {KEYS.map(([k, v]) => (
              <div key={k} className="flex gap-3 py-1 text-[12px]">
                <span className="w-[120px] flex-none">
                  <Kbd>{k}</Kbd>
                </span>
                <span className="text-white/55">{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6">
          <div className="xs-label mb-2">Navigation 3D</div>
          <div className="grid grid-cols-2 gap-x-9">
            {NAV.map(([k, v]) => (
              <div key={k} className="flex gap-3 py-1 text-[12px]">
                <span className="w-[170px] flex-none">
                  <Kbd>{k}</Kbd>
                </span>
                <span className="text-white/55">{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6">
          <div className="xs-label mb-2">Sur téléphone</div>
          <div className="text-[12px] text-white/55 leading-relaxed">
            Ton prénom en haut à droite → <span className="text-white/80">Sur ton téléphone</span> : vise le QR code avec l’appareil photo, et tu es connecté (rien à
            installer). Au doigt : <span className="text-white/75">un doigt</span> tourne autour du réseau, <span className="text-white/75">pincer</span> avance ou
            recule, <span className="text-white/75">deux doigts</span> déplacent, <span className="text-white/75">toucher</span> ouvre un neurone,{' '}
            <span className="text-white/75">double toucher</span> dans le vide revient à la vue d’ensemble. Chaque invitation a aussi son QR code (bouton QR).
          </div>
        </div>

        <div className="mt-6">
          <div className="xs-label mb-2">Partager ton cerveau · inviter des amis</div>
          <div className="text-[12px] text-white/55 leading-relaxed">
            Bouton <span className="text-white/80">Partager</span> en haut à droite : crée un lien d’invitation avec un rôle (
            <span className="text-white/75">lecture</span>, <span className="text-white/75">contribution</span>, <span className="text-white/75">édition</span>) et
            une zone (tout, ou certains tags), puis envoie-le. La personne entre avec son compte Synapse, ou juste un prénom : rien à installer. Les neurones{' '}
            <span className="text-white/80">🔒 privés</span> (facette du panneau, ou « !privé » à la capture) ne sont jamais montrés. Tu vois qui est là et où il
            regarde ; clique sur son nom pour suivre sa caméra. Ton menu (ton prénom, en haut à droite) : tes cerveaux, inviter un ami à créer son compte, ton profil,
            écrire à l’équipe.
          </div>
        </div>

        <div className="mt-6 pt-4 border-t border-white/[0.06] text-[11.5px] text-white/38 leading-relaxed">
          Tout est enregistré automatiquement sur cet ordinateur (avec une sauvegarde par jour). Tu peux aussi « Exporter mes données » (Ctrl K puis &gt;).
          Les exports de la V1 s’importent aussi.
        </div>
      </div>
    </div>
  );
}
