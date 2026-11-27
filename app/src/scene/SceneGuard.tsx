import { Component, type ReactNode } from 'react';
import { useUI } from '../store/ui';
import { Corners } from '../ui/common';

/** La 3D a besoin de WebGL 2 (la carte graphique) */
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
          Synapse n’a pas accès à la carte graphique de cet appareil. Tout le reste marche : l’<span className="text-white/85">agenda</span>, les{' '}
          <span className="text-white/85">tâches</span>, les notes (Ctrl K pour chercher ou créer).
        </div>
        <div className="text-[12px] text-white/45 mt-3 leading-relaxed">
          Pour retrouver la 3D : mets à jour le pilote de ta carte graphique (sur PC) ou Android System WebView (sur téléphone), puis rouvre Synapse.
        </div>
        <div className="flex gap-2 mt-5 flex-wrap">
          <button className="btn btn-primary" onClick={() => useUI.getState().setView('tasks')}>
            Voir mes tâches
          </button>
          <button className="btn" onClick={() => useUI.getState().setView('agenda')}>
            Agenda
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

  render() {
    return this.state.failed ? <NoScene /> : this.props.children;
  }
}
