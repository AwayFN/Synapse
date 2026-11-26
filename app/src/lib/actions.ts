import { useData } from '../store/data';
import { useUI } from '../store/ui';

/** Ctrl+N: empty note, born in front of the camera, opened in the editor (dans la vue Notes, on y reste) */
export function newNote(title = '') {
  const n = useData.getState().createNote({ title });
  useUI.getState().openEditor(n.id, { keepView: useUI.getState().view === 'notes' });
  return n;
}
