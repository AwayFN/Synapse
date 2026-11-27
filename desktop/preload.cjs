'use strict';
// Le lien entre la page de Synapse et l'application Windows : les données (lues une fois au démarrage, puis écrites
// dans %APPDATA%\Synapse à chaque changement) et « Enregistrer sous… » pour l'export. Rien d'autre.
const { contextBridge, ipcRenderer } = require('electron');

const init = ipcRenderer.sendSync('synapse:init') || {};
const items = new Map(Object.entries(init.items || {}));
let dirty = {};
let timer = null;

function send() {
  timer = null;
  if (!Object.keys(dirty).length) return;
  const changes = dirty;
  dirty = {};
  ipcRenderer.send('synapse:write', changes);
}
function schedule() {
  if (timer === null) timer = setTimeout(send, 300);
}
/** Écrit tout de suite sur le disque (la fenêtre se ferme) */
function flush() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  const changes = dirty;
  dirty = {};
  ipcRenderer.sendSync('synapse:write-sync', changes);
}

contextBridge.exposeInMainWorld('SynapseDesktop', {
  version: String(init.version || ''),
  dataDir: String(init.dataDir || ''),
  migrated: init.migrated || null,
  storage: {
    getItem: (key) => (items.has(String(key)) ? items.get(String(key)) : null),
    setItem: (key, value) => {
      const k = String(key);
      const v = String(value);
      if (items.get(k) === v) return;
      items.set(k, v);
      dirty[k] = v;
      schedule();
    },
    removeItem: (key) => {
      const k = String(key);
      if (!items.has(k)) return;
      items.delete(k);
      dirty[k] = null;
      schedule();
    },
    flush,
  },
  saveFile: (name, text) => ipcRenderer.invoke('synapse:save-file', String(name), String(text)),
});

// filet : la fenêtre se ferme ou se recharge → tout part sur le disque
window.addEventListener('pagehide', flush);
