import { useEffect } from 'react';
import { Scene } from './scene/Scene';
import { SceneGuard } from './scene/SceneGuard';
import { LabelLayer } from './ui/Labels';
import { Hud } from './ui/Hud';
import { DetailPanel } from './ui/DetailPanel';
import { KanbanView } from './ui/KanbanView';
import { AgendaView } from './ui/AgendaView';
import { NotesView } from './ui/NotesView';
import { NoteEditor } from './ui/NoteEditor';
import { CommandPalette } from './ui/CommandPalette';
import { Toasts } from './ui/Toasts';
import { Help } from './ui/Help';
import { NetworkSettings } from './ui/NetworkSettings';
import { MobileNav } from './ui/MobileNav';
import { useHotkeys } from './hooks/useHotkeys';
import { setStorageErrorHandler } from './store/storage';
import { useUI } from './store/ui';
import { desktop } from './lib/device';
import { installAndroidBackup } from './lib/backup';

export function App() {
  useHotkeys();
  useEffect(() => {
    setStorageErrorHandler(() =>
      useUI.getState().toast({ text: 'STOCKAGE PLEIN · EXPORTEZ VOS DONNÉES (CTRL K)', color: '#ff4d6d' }, 8000),
    );
    // application Android : une copie de sauvegarde automatique dans Documents/Synapse
    installAndroidBackup();
    // application Windows, premier lancement : le réseau de la version précédente (sur ce PC) a été repris
    const m = desktop()?.migrated;
    if (m && m.count > 0) {
      window.setTimeout(() => useUI.getState().toast({ text: `TON RÉSEAU EST LÀ · ${m.count} ÉLÉMENTS REPRIS DE LA VERSION PRÉCÉDENTE`, color: '#39ff88' }, 9000), 1200);
    }
  }, []);
  return (
    <div className="fixed inset-0 bg-black">
      <div id="stage" className="absolute inset-0 select-none overflow-hidden">
        <SceneGuard>
          <Scene />
        </SceneGuard>
        <LabelLayer />
        <Hud />
      </div>
      <DetailPanel />
      <NetworkSettings />
      <KanbanView />
      <AgendaView />
      <NotesView />
      <MobileNav />
      <NoteEditor />
      <CommandPalette />
      <Help />
      <Toasts />
    </div>
  );
}
