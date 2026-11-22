// Synapse — desktop launcher (no dependencies, plain Node).
//
//   node scripts/synapse.mjs           start the app: rebuild if the sources changed, start the
//                                      local server in the background, open the Synapse window
//   node scripts/synapse.mjs --build   rebuild dist/ (and stamp it with the source hash)
//   node scripts/synapse.mjs --stop    stop the background server
//   node scripts/synapse.mjs --serve   the background server itself (started by the first form)
//   --no-open                          do not open a window (tests)
//
// The server listens on this computer (127.0.0.1 and ::1); when the owner shares the brain it also
// listens on the local network and/or behind a Cloudflare tunnel. Without sharing it stops by itself
// a minute after the last Synapse window closed; with sharing it stays up for the guests.
// The brain itself is kept in %APPDATA%\Synapse (cerveau.json, acces.json, sauvegardes\).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.SYNAPSE_PORT) || 5173;
/** version of the server API (the launcher replaces an older running server) */
const PROTO = 4;
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

// ───────────────────────────── launch ─────────────────────────────

async function launch() {
  say('');
  say('  SYNAPSE · démarrage…');

  let st = await probe();
  if (st.state === 'ours' && (!samePath(st.info.root, DIST) || st.info.proto !== PROTO)) {
    // a server from another copy of the folder (or an older version of Synapse) is still running: replace it
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

  ensureBuilt();

  if (st.state === 'free') {
    const child = spawn(process.execPath, [SELF, '--serve'], {
      cwd: os.homedir(), // never lock the project folder
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    if (!(await waitFor('ours', 15_000))) fail(`Le serveur local n'a pas démarré.\nDétails : ${LOG}`);
  }

  if (!args.has('--no-open')) openWindow();
  say(st.state === 'free' ? '  ✓ Synapse est ouvert.' : '  ✓ Synapse tournait déjà : nouvelle fenêtre ouverte.');
}

// ───────────────────────────── server ─────────────────────────────

/** The background server lives in ./server/ (app, shared brain, invitations, live sync) */
async function serve() {
  const { startServer } = await import("./server/server.mjs");
  startServer({ port: PORT, dist: DIST, idleMs: IDLE_MS, firstMs: FIRST_MS, log, stamp: readStamp });
}

// ───────────────────────────── main ─────────────────────────────

if (args.has('--serve')) {
  serve();
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
