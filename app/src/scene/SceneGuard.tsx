import { Component, type ReactNode } from 'react';
import { reportError } from '../sync/errors';
import { useUI } from '../store/ui';
import { Corners } from '../ui/common';

/** La 3D a besoin de WebGL 2 (la carte graphique, par le navigateur) */
function webgl2Available(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/** À la place du réseau 3D quand il ne peut pas s'afficher : le reste de Synapse marche quand même */
function NoScene() {
  return (
    <div className="absolute inset-0 flex items-center justify-center p-6 pointer-events-none" data-no-scene>
      <div className="relative glass neon p-7 w-[min(540px,100%)] pointer-events-auto anim-pop" data-ui>
        <Corners />
        <div className="hud text-[10.5px] text-white/80">La vue 3D ne peut pas s’afficher ici</div>
        <div className="text-[13px] text-white/65 mt-3 leading-relaxed">
          Le navigateur n’a pas accès à la carte graphique de cet ordinateur. Tout le reste marche : l’
          <span className="text-white/85">emploi du temps</span>, les <span className="text-white/85">tâches</span>, les notes (Ctrl K pour chercher ou créer), et
          le partage.
        </div>
        <div className="text-[12px] text-white/45 mt-3 leading-relaxed">
          Pour retrouver la 3D : dans les paramètres du navigateur (Edge ou Chrome), active « Utiliser l’accélération graphique quand elle est disponible », ou
          mets à jour le pilote de ta carte graphique, puis relance Synapse.
        </div>
        <div className="flex gap-2 mt-5 flex-wrap">
          <button className="btn btn-primary" onClick={() => useUI.getState().setView('tasks')}>
            Voir mes tâches
          </button>
          <button className="btn" onClick={() => useUI.getState().setView('agenda')}>
            Emploi du temps
          </button>
          <button className="btn btn-ghost" onClick={() => location.reload()}>
            Réessayer
          </button>
        </div>
      </div>
    </div>
  );
}

export class SceneGuard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: !webgl2Available() };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidMount() {
    if (this.state.failed) reportError(new Error('WebGL 2 indisponible : vue 3D remplacée par un message'), 'vue 3D');
  }

  componentDidCatch(err: unknown) {
    reportError(err, 'vue 3D');
  }

  render() {
    return this.state.failed ? <NoScene /> : this.props.children;
  }
}
