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
      useUI.getState().toast({ text: 'STOCKAGE PLEIN · EXPORTEZ VOS DONNÉES (CTRL K)', color: '#ff4d6d' }, 8000),
    );
  }, []);
  return (
    <div className="fixed inset-0 bg-black">
      <div id="stage" className="absolute inset-0 select-none overflow-hidden">
        <SceneGuard>
          <Scene />
        </SceneGuard>
        <LabelLayer />
        <PresenceTags />
        <Hud />
      </div>
      <DetailPanel />
      <KanbanView />
      <AgendaView />
      <NotesView />
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
