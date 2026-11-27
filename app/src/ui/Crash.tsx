import { Component, type ReactNode } from 'react';
import { flushStorage } from '../store/storage';

/**
 * Dernier filet : si un écran plante, on l'explique au lieu d'un écran noir où l'on ne peut rien faire. Rien n'est
 * perdu : tout est enregistré sur cet appareil. (Rien n'est envoyé nulle part : Synapse est 100 % local.)
 */
export class AppGuard extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(err: unknown) {
    return { error: String((err as { message?: string })?.message ?? err ?? 'erreur') };
  }

  componentDidCatch() {
    try {
      flushStorage();
    } catch {
      /* rien de plus à faire */
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fixed inset-0 bg-black flex items-center justify-center p-6">
        <div className="relative glass neon p-8 w-[min(520px,100%)]">
          <div className="hud text-[10.5px] text-[rgb(var(--alert))]">Synapse a rencontré un problème</div>
          <div className="text-[14px] text-white/70 mt-3 leading-relaxed">
            Rien n’est perdu : tes pensées sont enregistrées sur cet appareil. Recharge ; si ça recommence, ferme Synapse et rouvre-le.
          </div>
          <div className="mono text-[10.5px] text-white/35 mt-3 break-words">{this.state.error}</div>
          <button className="btn btn-primary mt-6" onClick={() => location.reload()}>
            Recharger
          </button>
        </div>
      </div>
    );
  }
}
