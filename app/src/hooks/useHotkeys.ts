import { useEffect } from 'react';
import { useUI } from '../store/ui';
import { newNote } from '../lib/actions';
import { isTyping } from '../scene/FlyControls';

/**
 * Global shortcuts:
 *  Ctrl/⌘+K palette · Ctrl/⌘+N or Alt+N new note · Tab agenda · Shift+Tab tasks · ? help · Esc closes layers
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

      if (e.key === 'Escape') {
        if (ui.paletteOpen) return ui.closePalette();
        if (ui.helpOpen) return ui.setHelp(false);
        if (ui.editorId) return ui.closeEditor();
        if (isTyping()) {
          (document.activeElement as HTMLElement | null)?.blur();
          return;
        }
        if (ui.view !== 'network') return ui.setView('network');
        if (ui.selectedId) return ui.closePanel();
        if (ui.focusId) return ui.setFocus(null);
        if (ui.activeTags.length) return ui.clearTags();
        return;
      }

      if (ui.paletteOpen || isTyping()) return;

      if (e.key === 'Tab' && !mod && !e.altKey) {
        e.preventDefault();
        if (ui.editorId) return;
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
