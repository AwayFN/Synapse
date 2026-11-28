import { useEffect } from 'react';
import { networkSettingsVisible, panelVisible, useUI } from '../store/ui';
import { ViewTabs } from './Hud';

/**
 * Un panneau qui prend tout l'écran du téléphone à l'intérieur d'une vue (dans l'agenda : un élément ouvert, « À
 * planifier ») : tant qu'il est là, la barre des vues s'efface (elle passerait par-dessus ses boutons du bas).
 */
export function useCoverMobileNav(active: boolean) {
  useEffect(() => {
    if (!active) return;
    useUI.setState((s) => ({ navCovers: s.navCovers + 1 }));
    return () => useUI.setState((s) => ({ navCovers: Math.max(0, s.navCovers - 1) }));
  }, [active]);
}

/**
 * Sur téléphone (V8.1) : la barre des vues (Réseau · Agenda · Tâches · Notes), en bas, à portée de pouce, dans TOUTES
 * les vues — comme une vraie application. Elle s'efface quand une fiche, l'éditeur, la barre de commande, l'aide ou un
 * panneau plein écran prennent l'écran. (Sur ordinateur, les vues restent en haut du réseau.)
 */
export function MobileNav() {
  const hidden = useUI((s) => !!s.editorId || s.paletteOpen || s.helpOpen || panelVisible(s) || networkSettingsVisible(s) || s.navCovers > 0);
  if (hidden) return null;
  return (
    <nav
      className="md:hidden fixed left-1/2 -translate-x-1/2 bottom-[calc(12px+env(safe-area-inset-bottom))] z-[45] anim-fade"
      data-mobile-nav
      aria-label="Vues"
    >
      <ViewTabs />
    </nav>
  );
}
