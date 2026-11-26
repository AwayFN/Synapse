// Synapse — desktop launcher (no dependencies, plain Node).
//
//   node scripts/synapse.mjs            start the app and open the Synapse window, in one of two modes:
//                                         · serveur : this PC runs the Synapse server (the creator's PC, the
//                                           « Synapse central »): rebuild if the sources changed, start it;
//                                         · client  : any other PC: a small relay connects the window to the
//                                           Synapse central (accounts and brains live there, synced live
//                                           with the person's phone). Nothing to build: the app
//                                           itself (dist/) comes from this PC and works offline.
//                                       The mode is chosen once (a PC that already has Synapse data stays a
//                                       server, a new installation becomes a client) and remembered.
//   node scripts/synapse.mjs --serveur  force (and remember) the server mode on this PC
//   node scripts/synapse.mjs --client   force (and remember) the client mode on this PC
//   node scripts/synapse.mjs --build    rebuild dist/ (and stamp it with the source hash)
//   node scripts/synapse.mjs --stop     stop the background server (or relay)
//   node scripts/synapse.mjs --serve    the background server itself (started by the first form)
//   node scripts/synapse.mjs --serve-relais  the background relay itself (client mode)
//   --no-open                           do not open a window (tests)
//
// The server listens on this computer (127.0.0.1 and ::1); when the owner shares the brain it also
// listens on the local network and/or behind a Cloudflare tunnel. Without sharing it stops by itself
// a minute after the last Synapse window closed; with sharing it stays up for the guests.
// The brain itself is kept in %APPDATA%\Synapse (cerveaux\, comptes.json, sauvegardes\).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.SYNAPSE_PORT) || 5173;
/** version of the server API (the launcher replaces an older running server) */
const PROTO = 7;
const APP_URL = `http://localhost:${PORT}/`;
const SELF = fileURLToPath(import.meta.url);
const APP_DIR = path.resolve(path.dirname(SELF), '..');
const DIST = path.join(APP_DIR, 'dist');
const STAMP = path.join(DIST, '.synapse-build');
/** stop this long after the last window closed */
const IDLE_MS = Number(process.env.SYNAPSE_IDLE_MS) || 60_000;
/** ...or this long after start if no window ever connected */
const FIRST_MS = Number(process.env.SYNAPSE_FIRST_MS) || 120_000;
const LOG = path.join(os.tmpdir(), 'synapse-serveur.log');
const HOSTS = ['127.0.0.1', '::1'];
const SOURCES = ['src', 'public', 'index.html', 'vite.config.ts', 'package.json'];

const args = new Set(process.argv.slice(2));

// ───────────────────────────── helpers ─────────────────────────────

function say(msg = '') {
  process.stdout.write(msg + '\n');
}

function fail(msg) {
  say('');
  for (const line of String(msg).split('\n')) say('  ' + line);
  say('');
  process.exit(1);
}

function log(msg) {
  try {
    try {
      if (fs.statSync(LOG).size > 256_000) fs.writeFileSync(LOG, '');
    } catch {}
    fs.appendFileSync(LOG, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Hash of everything that ends up in the build: a copied folder keeps its hash, unlike mtimes */
function sourceHash() {
  const h = crypto.createHash('sha1');
  const walk = (rel) => {
    const abs = path.join(APP_DIR, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) walk(path.join(rel, name));
    } else {
      h.update(rel.replace(/\\/g, '/'));
      h.update('\0');
      h.update(fs.readFileSync(abs));
      h.update('\0');
    }
  };
  SOURCES.forEach(walk);
  return h.digest('hex').slice(0, 16);
}

/**
 * Empreinte du code du serveur et du relais (ce dossier scripts/) : un serveur qui tourne encore avec un ancien code
 * (Synapse mis à jour pendant qu'il tournait) est remplacé au prochain lancement, même si PROTO n'a pas changé.
 */
function codeHash() {
  const h = crypto.createHash('sha1');
  const walk = (dir) => {
    let names = [];
    try {
      names = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith('.mjs')) {
        h.update(path.relative(APP_DIR, abs).replace(/\\/g, '/'));
        h.update('\0');
        h.update(fs.readFileSync(abs));
        h.update('\0');
      }
    }
  };
  walk(path.join(APP_DIR, 'scripts'));
  return h.digest('hex').slice(0, 12);
}
const CODE = codeHash();

function readStamp() {
  try {
    return fs.readFileSync(STAMP, 'utf8').trim();
  } catch {
    return '';
  }
}

// ───────────────────────────── build ─────────────────────────────

function build(label, verbose) {
  const vite = path.join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(vite)) {
    const npm = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!fs.existsSync(npm)) return false;
    say('  Installation des composants (une seule fois, environ 1 min, Internet nécessaire)…');
    const r = spawnSync(process.execPath, [npm, 'install', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: APP_DIR,
      stdio: 'inherit',
    });
    if (r.status !== 0 || !fs.existsSync(vite)) return false;
  }
  say(`  ${label}…`);
  const hash = sourceHash();
  const r = spawnSync(process.execPath, [vite, 'build', '--logLevel', verbose ? 'info' : 'warn'], {
    cwd: APP_DIR,
    stdio: 'inherit',
  });
  if (r.status !== 0 || !fs.existsSync(path.join(DIST, 'index.html'))) return false;
  fs.writeFileSync(STAMP, hash);
  return true;
}

function ensureBuilt() {
  const hasDist = fs.existsSync(path.join(DIST, 'index.html'));
  if (hasDist && readStamp() === sourceHash()) return;
  const ok = build(hasDist ? "Mise à jour de l'application (quelques secondes)" : "Préparation de l'application (première fois)");
  if (ok) return;
  if (!hasDist) fail("Impossible de préparer l'application.\nVérifie la connexion Internet puis relance Synapse.");
  say('  ⚠ Mise à jour impossible : ouverture de la version précédente.');
}

// ───────────────────────────── probing ─────────────────────────────

/** What answers on PORT at `host`: our server, something else, or nothing */
function probeHost(host) {
  return new Promise((resolve) => {
    const req = http.get({ host, port: PORT, path: '/__synapse', timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (body.length < 65_536) body += c;
      });
      res.on('end', () => {
        let info = null;
        try {
          info = JSON.parse(body);
        } catch {}
        if (info && info.app === 'synapse') resolve({ state: 'ours', info });
        // the Vite dev server answers with the app itself
        else if (/<title>\s*SYNAPSE/i.test(body)) resolve({ state: 'dev' });
        else resolve({ state: 'other' });
      });
      res.on('error', () => resolve({ state: 'other' }));
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ state: 'other' });
    });
    req.on('error', () => resolve({ state: 'free' }));
  });
}

async function probe() {
  const all = await Promise.all(HOSTS.map(probeHost));
  return (
    all.find((r) => r.state === 'other') ||
    all.find((r) => r.state === 'ours') ||
    all.find((r) => r.state === 'dev') || { state: 'free' }
  );
}

function quit() {
  return Promise.all(
    HOSTS.map(
      (host) =>
        new Promise((resolve) => {
          const req = http.request(
            { host, port: PORT, path: '/__quit', method: 'POST', headers: { 'X-Synapse': 'quit' }, timeout: 1500 },
            (res) => {
              res.resume();
              res.on('end', resolve);
              res.on('error', resolve);
            },
          );
          req.on('error', resolve);
          req.on('timeout', () => {
            req.destroy();
            resolve();
          });
          req.end();
        }),
    ),
  );
}

async function waitFor(state, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await probe();
    if (r.state === state) return r;
    await sleep(150);
  }
  return null;
}

// ───────────────────────────── window ─────────────────────────────

const APP_BROWSERS = ['msedge.exe', 'chrome.exe', 'brave.exe', 'vivaldi.exe', 'chromium.exe'];

function regValue(key, value) {
  try {
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const out = execFileSync(reg, ['query', key, ...(value ? ['/v', value] : ['/ve'])], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.*)/);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

/** The default browser, if it can open a page as a standalone app window (Chromium family) */
function appBrowser() {
  if (process.platform !== 'win32') return null;
  const base = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations';
  const progId = regValue(`${base}\\https\\UserChoice`, 'ProgId') || regValue(`${base}\\http\\UserChoice`, 'ProgId');
  if (!progId) return null;
  const cmd = regValue(`HKCR\\${progId}\\shell\\open\\command`);
  if (!cmd) return null;
  let exe = cmd.startsWith('"') ? cmd.slice(1, cmd.indexOf('"', 1)) : cmd.split(/\s+/)[0];
  exe = exe.replace(/%([^%]+)%/g, (all, v) => process.env[v] ?? all);
  if (!APP_BROWSERS.includes(path.basename(exe).toLowerCase())) return null;
  return fs.existsSync(exe) ? exe : null;
}

function openWindow() {
  const exe = appBrowser();
  if (exe) {
    // its own window, without tabs or address bar (and the page gets Ctrl+N)
    spawn(exe, [`--app=${APP_URL}`, '--start-maximized'], { detached: true, stdio: 'ignore' }).unref();
    return path.basename(exe, '.exe');
  }
  if (process.platform === 'win32') {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', APP_URL], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [APP_URL], { detached: true, stdio: 'ignore' }).unref();
  }
  return 'default';
}

// ───────────────────────────── mode ─────────────────────────────

/**
 * Serveur ou client ? Choisi une fois, puis retenu (%APPDATA%\Synapse\appareil.json) :
 *   - un PC qui a déjà des données Synapse (comptes, cerveaux) reste un serveur (le PC du créateur) ;
 *   - une nouvelle installation se connecte au Synapse central (central.json), comme l'application Android :
 *     on y crée son compte, et on retrouve tout sur ses autres appareils ;
 *   - --serveur / --client imposent le mode (et le retiennent).
 */
async function deviceMode() {
  const { dataDir } = await import('./server/util.mjs');
  const { readCentral } = await import('./server/publish.mjs');
  const root = dataDir();
  const file = path.join(root, 'appareil.json');
  let dev = {};
  try {
    dev = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const forced = args.has('--serveur') ? 'serveur' : args.has('--client') ? 'client' : null;
  let mode = forced || (dev.mode === 'serveur' || dev.mode === 'client' ? dev.mode : null);
  if (!mode) {
    let hasData = fs.existsSync(path.join(root, 'cerveau.json'));
    try {
      const c = JSON.parse(fs.readFileSync(path.join(root, 'comptes.json'), 'utf8'));
      if (Object.keys(c.accounts || {}).length) hasData = true;
    } catch {}
    try {
      if (fs.readdirSync(path.join(root, 'cerveaux')).length) hasData = true;
    } catch {}
    mode = hasData || !readCentral(APP_DIR) ? 'serveur' : 'client';
  }
  if (dev.mode !== mode) {
    try {
      fs.writeFileSync(file, JSON.stringify({ ...dev, mode }, null, 1));
    } catch {}
  }
  return mode;
}

// ───────────────────────────── launch ─────────────────────────────

async function launch() {
  say('');
  say('  SYNAPSE · démarrage…');
  const mode = await deviceMode();

  let st = await probe();
  if (st.state === 'ours' && (!samePath(st.info.root, DIST) || st.info.proto !== PROTO || st.info.code !== CODE || (st.info.mode || 'serveur') !== mode)) {
    // a server from another copy of the folder (or an older version of Synapse, or the other mode) is still
    // running: replace it
    await quit();
    await waitFor('free', 5000);
    st = await probe();
  }
  if (st.state === 'other') {
    fail(
      `Le port ${PORT} est déjà utilisé par un autre programme.\n` +
        `Ferme ce programme (ou redémarre l'ordinateur), puis relance Synapse.`,
    );
  }

  // client : rien à compiler non plus (dist/ est dans le dossier) : le relais sert l'application depuis ce PC (elle
  // marche sans connexion) et transmet l'API au Synapse central
  if (mode === 'serveur') ensureBuilt();

  if (st.state === 'free') {
    const child = spawn(process.execPath, [SELF, mode === 'client' ? '--serve-relais' : '--serve'], {
      cwd: os.homedir(), // never lock the project folder
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    if (!(await waitFor('ours', 15_000))) fail(`${mode === 'client' ? 'La connexion au Synapse central' : 'Le serveur local'} n'a pas démarré.\nDétails : ${LOG}`);
  }

  if (!args.has('--no-open')) openWindow();
  if (mode === 'client') say(st.state === 'free' ? '  ✓ Synapse est ouvert (connecté au Synapse central).' : '  ✓ Synapse tournait déjà : nouvelle fenêtre ouverte.');
  else say(st.state === 'free' ? '  ✓ Synapse est ouvert.' : '  ✓ Synapse tournait déjà : nouvelle fenêtre ouverte.');
}

// ───────────────────────────── server ─────────────────────────────

/** The background server lives in ./server/ (app, shared brain, invitations, live sync) */
async function serve() {
  const { startServer } = await import('./server/server.mjs');
  startServer({ port: PORT, dist: DIST, idleMs: IDLE_MS, firstMs: FIRST_MS, log, stamp: readStamp, code: CODE });
}

/** Client mode: the relay to the Synapse central (./relais.mjs) */
async function serveRelay() {
  const { dataDir } = await import('./server/util.mjs');
  const { startRelay } = await import('./relais.mjs');
  startRelay({
    port: PORT,
    appDir: APP_DIR,
    dataDir: dataDir(),
    log,
    idleMs: IDLE_MS,
    firstMs: FIRST_MS,
    proto: PROTO,
    code: CODE,
    // « Utiliser Synapse seul sur ce PC » (quand le Synapse central ne répond pas) : ce PC devient serveur
    spawnServer: () => spawn(process.execPath, [SELF, '--serve'], { cwd: os.homedir(), detached: true, stdio: 'ignore', windowsHide: true }).unref(),
  });
}

// ───────────────────────────── main ─────────────────────────────

// Node.js trop ancien : un message clair plutôt qu'une erreur incompréhensible plus loin
if (Number(process.versions.node.split('.')[0]) < 18) {
  if (process.platform === 'win32' && !args.has('--serve')) {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', 'https://nodejs.org/fr/download'], { detached: true, stdio: 'ignore' }).unref();
  }
  fail(
    `Ta version de Node.js (${process.version}) est trop ancienne pour Synapse.\n` +
      `Installe la version LTS (la page de téléchargement s'ouvre), puis relance Synapse.`,
  );
}

if (args.has('--serve')) {
  serve();
} else if (args.has('--serve-relais')) {
  serveRelay();
} else if (args.has('--build')) {
  if (!build('Compilation', true)) fail('La compilation a échoué.');
  say(`  ✓ dist/ à jour (${readStamp()}).`);
} else if (args.has('--stop')) {
  quit()
    .then(() => waitFor('free', 5000))
    .then((r) => say(r ? '  Synapse est arrêté.' : '  Le serveur ne répond pas à la demande d’arrêt.'));
} else {
  launch().catch((e) => fail(`Erreur inattendue : ${(e && e.stack) || e}`));
}
