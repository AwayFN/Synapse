'use strict';
// Synapse pour Windows (V8) : l'application dans sa propre fenêtre, installée avec une icône sur le bureau.
//
// 100 % local :
//  - l'application (app/dist, copiée dans le dossier « web ») est servie depuis le PC lui-même, à l'adresse réservée
//    synapse://app/ ; elle ne charge rien depuis Internet ;
//  - toute requête vers Internet est refusée (http, https, ws…), et la page ne peut ni ouvrir d'autres fenêtres ni
//    naviguer ailleurs ;
//  - les données sont dans %APPDATA%\Synapse (voir donnees.cjs), avec une sauvegarde par jour.
// Pas de compte, pas de serveur, pas de mise à jour automatique : rien ne sort de ce PC.
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { Donnees } = require('./donnees.cjs');

const SCHEME = 'synapse';
const ORIGIN = `${SCHEME}://app`;

// avant tout : l'adresse réservée de l'application (comme une vraie page : stockage, modules, polices)
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }]);

// %APPDATA%\Synapse (SYNAPSE_DATA_DIR : un autre dossier, pour les essais)
const DATA_DIR = process.env.SYNAPSE_DATA_DIR ? path.resolve(process.env.SYNAPSE_DATA_DIR) : path.join(app.getPath('appData'), 'Synapse');
// les fichiers internes de la fenêtre (cache…) à part, dans un sous-dossier : le dossier des données reste lisible
app.setPath('userData', path.join(DATA_DIR, 'application'));

const LOG = path.join(DATA_DIR, 'application', 'journal.txt');
function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 200_000) fs.writeFileSync(LOG, '');
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* pas grave */
  }
}

/** L'application compilée : dans l'application installée (web/), ou app/dist pendant le développement */
const WEB_DIR = [path.join(__dirname, 'web'), path.join(__dirname, '..', 'app', 'dist')].find((d) => fs.existsSync(path.join(d, 'index.html')));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};
/** La page ne parle qu'à elle-même */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
  "connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'";

async function serve(request) {
  const url = new URL(request.url);
  if (url.host !== 'app' || !WEB_DIR) return new Response('', { status: 404 });
  let rel = decodeURIComponent(url.pathname);
  if (!rel || rel === '/') rel = '/index.html';
  // une adresse sans extension : l'application
  if (!path.posix.basename(rel).includes('.')) rel = '/index.html';
  const file = path.normalize(path.join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR + path.sep)) return new Response('', { status: 403 });
  try {
    const body = await fs.promises.readFile(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'content-type': type, 'x-content-type-options': 'nosniff' };
    if (type.startsWith('text/html')) headers['content-security-policy'] = CSP;
    return new Response(body, { status: 200, headers });
  } catch {
    return new Response('', { status: 404 });
  }
}

const donnees = new Donnees(DATA_DIR, log);
let win = null;

// ───────────────────────── la page demande : ses données, les écrire, enregistrer un fichier (export)

ipcMain.on('synapse:init', (e) => {
  e.returnValue = { version: app.getVersion(), dataDir: DATA_DIR, items: donnees.items, migrated: donnees.migrated };
});
ipcMain.on('synapse:write', (_e, changes) => donnees.patch(changes));
ipcMain.on('synapse:write-sync', (e, changes) => {
  donnees.patch(changes);
  e.returnValue = donnees.saveNow();
});
ipcMain.handle('synapse:save-file', async (_e, name, text) => {
  if (typeof name !== 'string' || typeof text !== 'string') return false;
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'synapse.json';
  const r = await dialog.showSaveDialog(win ?? undefined, {
    title: 'Exporter mes données',
    defaultPath: path.join(app.getPath('documents'), safe),
    filters: [{ name: 'Données Synapse', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return false;
  try {
    await fs.promises.writeFile(r.filePath, text, 'utf8');
    return true;
  } catch (err) {
    log(`export : ${err.message}`);
    return false;
  }
});

// ───────────────────────── la fenêtre (taille et position gardées)

const WIN_FILE = path.join(DATA_DIR, 'application', 'fenetre.json');
function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(WIN_FILE, 'utf8'));
    if (b && b.width >= 640 && b.height >= 480) return b;
  } catch {
    /* première fois */
  }
  return { width: 1440, height: 900 };
}
function saveBounds() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.mkdirSync(path.dirname(WIN_FILE), { recursive: true });
    fs.writeFileSync(WIN_FILE, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  } catch {
    /* pas grave */
  }
}

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    minWidth: 820,
    minHeight: 560,
    show: false,
    title: 'Synapse',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // le correcteur d'orthographe d'Electron télécharge ses dictionnaires sur Internet : pas dans Synapse
      spellcheck: false,
      devTools: !app.isPackaged || process.env.SYNAPSE_DEVTOOLS === '1',
    },
  });
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveBounds);
  win.on('closed', () => {
    win = null;
  });
  const wc = win.webContents;
  // pas d'autre fenêtre, pas d'autre page : Synapse reste chez lui
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN + '/')) e.preventDefault();
  });
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      e.preventDefault();
    } else if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
      wc.reload();
      e.preventDefault();
    } else if (input.key === 'F12' && (!app.isPackaged || process.env.SYNAPSE_DEVTOOLS === '1')) {
      wc.toggleDevTools();
      e.preventDefault();
    }
  });
  wc.on('render-process-gone', (_e, d) => log(`la page s'est arrêtée : ${d.reason}`));
  if (!WEB_DIR) {
    dialog.showErrorBox('Synapse', "L'application est incomplète (dossier « web » introuvable). Réinstalle Synapse.");
    app.quit();
    return;
  }
  win.loadURL(`${ORIGIN}/index.html`);
}

// une seule fenêtre Synapse à la fois (un double-clic de plus la ramène devant)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(() => {
    donnees.load();
    Menu.setApplicationMenu(null);
    protocol.handle(SCHEME, serve);
    // aucune connexion à Internet, quoi qu'il arrive
    const ses = session.defaultSession;
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (d, cb) => {
      log(`requête refusée (100 % local) : ${d.url.slice(0, 120)}`);
      cb({ cancel: true });
    });
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    createWindow();
  });

  app.on('before-quit', () => donnees.saveNow());
  app.on('window-all-closed', () => {
    donnees.saveNow();
    app.quit();
  });
}
