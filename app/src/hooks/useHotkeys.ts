import { useEffect } from 'react';
import { networkSettingsVisible, useUI } from '../store/ui';
import { newNote } from '../lib/actions';
import { isTyping } from '../scene/FlyControls';

/** Les réglages du réseau sont ouverts (et visibles) : Tab ne change pas de vue derrière eux */
const overlay = () => networkSettingsVisible(useUI.getState());

/**
 * Global shortcuts:
 *  Ctrl/⌘+K palette · Ctrl/⌘+N or Alt+N new note · Tab agenda · Shift+Tab tasks · ? help
 *  (Échap ferme ce qui est ouvert, partout : voir lib/back.ts)
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
        else ui.openPalette();
        return;
      }
      if ((mod && !e.shiftKey && (key === 'n' || e.code === 'KeyN')) || (e.altKey && !mod && e.code === 'KeyN')) {
        e.preventDefault();
        if (ui.paletteOpen) ui.closePalette();
        newNote();
        return;
      }

      if (e.key === 'Escape') return;

      if (ui.paletteOpen || isTyping()) return;

      if (e.key === 'Tab' && !mod && !e.altKey) {
        e.preventDefault();
        if (ui.editorId || overlay()) return;
        ui.toggleView(e.shiftKey ? 'tasks' : 'agenda');
        if (ui.selectedId) ui.select(null);
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
