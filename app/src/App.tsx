import { useEffect } from 'react';
import { Scene } from './scene/Scene';
import { LabelLayer } from './ui/Labels';
import { Hud } from './ui/Hud';
import { DetailPanel } from './ui/DetailPanel';
import { KanbanView } from './ui/KanbanView';
import { AgendaView } from './ui/AgendaView';
import { FluxView } from './ui/FluxView';
import { NoteEditor } from './ui/NoteEditor';
import { CommandPalette } from './ui/CommandPalette';
import { Toasts } from './ui/Toasts';
import { Help } from './ui/Help';
import { ShareDialog } from './ui/ShareDialog';
import { PresenceTags } from './ui/Presence';
import { SessionOverlay } from './ui/Gate';
import { AccountPanel, AnnouncementBar, FeedbackDialog } from './ui/Account';
import { AdminPanel } from './ui/Admin';
import { useHotkeys } from './hooks/useHotkeys';
import { setStorageErrorHandler } from './store/storage';
import { useUI } from './store/ui';

export function App() {
  useHotkeys();
  useEffect(() => {
    setStorageErrorHandler(() =>
      useUI.getState().toast({ text: 'STOCKAGE PLEIN · EXPORTE TES DONNÉES (CTRL K PUIS >)', color: '#ff4d7a' }, 8000),
    );
  }, []);
  return (
    <div className="fixed inset-0 bg-[rgb(var(--ink))]">
      <div id="stage" className="absolute inset-0 select-none overflow-hidden">
        <Scene />
        <LabelLayer />
        <PresenceTags />
        <Hud />
      </div>
      <DetailPanel />
      <FluxView />
      <KanbanView />
      <AgendaView />
      <NoteEditor />
      <CommandPalette />
      <ShareDialog />
      <AccountPanel />
      <FeedbackDialog />
      <AdminPanel />
      <AnnouncementBar />
      <Help />
      <SessionOverlay />
      <Toasts />
    </div>
  );
}
