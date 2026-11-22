import { useEffect } from 'react';
import { useUI } from '../store/ui';
import { isTyping } from '../scene/FlyControls';
import type { ViewMode } from '../types';
import { useSession } from '../sync/session';
import { can } from '../sync/perm';

const DIGIT_VIEWS: Record<string, ViewMode> = { Digit1: 'network', Digit2: 'flux', Digit3: 'agenda', Digit4: 'tasks' };

/**
 * Raccourcis globaux :
 *  Ctrl/⌘+K (ou Ctrl+N / Alt+N) capturer · / chercher · Tab agenda · Maj+Tab tâches · 1-4 vues
 *  Alt+← / Alt+→ fil de pensée · Entrée développer le neurone ouvert · ? aide · Échap referme
 */
export function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ui = useUI.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && !e.shiftKey && !e.altKey && (key === 'k' || e.code === 'KeyK')) {
        e.preventDefault();
        if (ui.paletteOpen) ui.closePalette();
        else ui.openPalette(can.write() ? '' : '/');
        return;
      }
      if ((mod && !e.shiftKey && (key === 'n' || e.code === 'KeyN')) || (e.altKey && !mod && e.code === 'KeyN')) {
        e.preventDefault();
        if (!ui.paletteOpen) ui.openPalette(can.write() ? '' : '/');
        return;
      }

      if (e.key === 'Escape') {
        if (ui.paletteOpen) return ui.closePalette();
        if (ui.helpOpen) return ui.setHelp(false);
        const sess = useSession.getState();
        if (sess.feedbackOpen) return useSession.setState({ feedbackOpen: false });
        if (sess.accountOpen) return useSession.setState({ accountOpen: false });
        if (sess.adminOpen) return useSession.setState({ adminOpen: false });
        if (sess.shareOpen) return useSession.setState({ shareOpen: false });
        if (sess.previewAs) return useSession.setState({ previewAs: null });
        if (sess.following) return useSession.setState({ following: null });
        if (ui.editorId) return ui.closeEditor();
        if (isTyping()) {
          (document.activeElement as HTMLElement | null)?.blur();
          return;
        }
        if (ui.view !== 'network') return ui.setView('network');
        if (ui.orphansOnly) return ui.setOrphansOnly(false);
        if (ui.selectedId) return ui.closePanel();
        if (ui.focusId) return ui.setFocus(null);
        if (ui.activeTags.length) return ui.clearTags();
        return;
      }

      if (ui.paletteOpen) return;
      // une fenêtre (compte, espace créateur, avis, partage) est ouverte : pas de raccourci derrière elle
      const ss = useSession.getState();
      if (ss.adminOpen || ss.accountOpen || ss.feedbackOpen || ss.shareOpen) return;

      // fil de pensée (même pendant l'édition d'un champ : Alt+flèche ne sert à rien d'autre ici)
      if (e.altKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        if (e.key === 'ArrowLeft') ui.back();
        else ui.forward();
        return;
      }

      if (isTyping()) return;

      if (e.key === '/' && !mod) {
        e.preventDefault();
        ui.openPalette('/');
        return;
      }
      if (e.key === 'Tab' && !mod && !e.altKey) {
        e.preventDefault();
        if (ui.editorId) return;
        ui.toggleView(e.shiftKey ? 'tasks' : 'agenda');
        return;
      }
      if (!mod && !e.altKey && !e.shiftKey && DIGIT_VIEWS[e.code] && !ui.editorId) {
        e.preventDefault();
        ui.setView(DIGIT_VIEWS[e.code]);
        return;
      }
      const onButton = (document.activeElement as HTMLElement | null)?.tagName === 'BUTTON';
      if (e.key === 'Enter' && !mod && !onButton && ui.selectedId && ui.view === 'network' && !ui.editorId) {
        e.preventDefault();
        ui.openEditor(ui.selectedId);
        return;
      }
      if (e.key === 'Backspace' && !mod && ui.view === 'network' && !ui.editorId && ui.trailPos > 0) {
        e.preventDefault();
        ui.back();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        ui.setHelp(!ui.helpOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
