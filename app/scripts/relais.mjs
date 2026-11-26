// Synapse sur un PC « client » : chaque compte, chaque cerveau vit sur le Synapse central (celui du créateur), et
// tout ce qu'on fait sur ce PC apparaît en direct sur ses autres appareils (et l'inverse) — comme l'application
// Android.
//
// V7.1 : Synapse marche aussi SANS connexion sur ce PC. L'application elle-même vient de ce PC (le dossier
// app/dist), jamais du serveur : elle s'ouvre toujours, garde une copie du cerveau dans la fenêtre, et ce qui est
// fait hors ligne part dès que le Synapse central répond de nouveau.
//
// Le relais tourne en arrière-plan sur ce PC (http://localhost:5173, comme avant) : il sert l'application et
// transmet l'API (/api/…) au serveur central. Pour la fenêtre de Synapse, l'adresse ne change donc jamais (on reste
// connecté), même quand celle du serveur central change (adresse Internet gratuite, nouvelle à chaque redémarrage) :
// le relais la retrouve tout seul sur GitHub (central.json → branche synapse-adresse → adresse.json) et continue.
// Si le réseau de ce PC change (Wi-Fi → câble, autre box), les connexions se rebranchent toutes seules.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { readCentral } from './server/publish.mjs';
import { CSP, SECURITY_HEADERS } from './server/util.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

const HOSTS = ['127.0.0.1', '::1'];
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
/** la fenêtre ne voit qu'un seul serveur : celui-ci, qui transmet */
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function fetchText(url, { timeout = 7000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Synapse-relais', ...headers }, timeout }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (body.length < 200_000) body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, body, headers: res.headers }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('délai dépassé')));
    req.on('error', reject);
  });
}

const cleanAddress = (s) => {
  const v = String(s || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s/?#]+$/i.test(v) ? v : '';
};

export function startRelay({ port, appDir, dataDir, log, idleMs, firstMs, proto, code = '', spawnServer }) {
  const central = readCentral(appDir);
  const devFile = path.join(dataDir, 'appareil.json');
  const readDev = () => {
    try {
      return JSON.parse(fs.readFileSync(devFile, 'utf8'));
    } catch {
      return {};
    }
  };
  const writeDev = (patch) => {
    try {
      fs.writeFileSync(devFile, JSON.stringify({ ...readDev(), ...patch }, null, 1));
    } catch (e) {
      log(`appareil.json: ${e.message}`);
    }
  };

  const up = { url: cleanAddress(readDev().adresse), ok: false, error: '', checkedAt: 0, resolving: null, from: '' };
  const agentS = new https.Agent({ keepAlive: true, maxSockets: 96 });
  const agentH = new http.Agent({ keepAlive: true, maxSockets: 96 });
  let rendezvous = { at: 0, url: '' };
  const alive = new Set();
  const servers = [];
  let hadClient = false;
  let lastActivity = Date.now();
  let stopping = false;
  const started = Date.now();

  /** Un serveur Synapse répond-il à cette adresse ? */
  async function healthy(url) {
    try {
      const r = await fetchText(`${url}/api/health`, { timeout: 6000 });
      const j = JSON.parse(r.body);
      return r.status === 200 && j && j.ok === true;
    } catch {
      return false;
    }
  }

  /**
   * L'adresse publiée par le Synapse central sur GitHub (API d'abord, sinon la copie « raw »).
   * SYNAPSE_RENDEZVOUS : lire ce fichier adresse.json ailleurs (tests, ou son propre point de rendez-vous).
   */
  const customRendezvous = /^https?:\/\//i.test(process.env.SYNAPSE_RENDEZVOUS || '') ? process.env.SYNAPSE_RENDEZVOUS : '';
  async function published() {
    if (!central && !customRendezvous) return '';
    if (Date.now() - rendezvous.at < (customRendezvous ? 2_000 : 60_000)) return rendezvous.url;
    let url = '';
    const sources = customRendezvous
      ? [[customRendezvous, {}]]
      : [
          [`https://api.github.com/repos/${central.depot}/contents/${central.fichier}?ref=${encodeURIComponent(central.branche)}`, { Accept: 'application/vnd.github.raw+json' }],
          [`https://raw.githubusercontent.com/${central.depot}/${central.branche}/${central.fichier}?t=${Date.now()}`, {}],
        ];
    for (const [u, h] of sources) {
      try {
        const r = await fetchText(u, { headers: h });
        if (r.status !== 200) continue;
        const j = JSON.parse(r.body);
        if (j && j.app === 'synapse' && cleanAddress(j.adresse)) {
          url = cleanAddress(j.adresse);
          break;
        }
      } catch {}
    }
    rendezvous = { at: Date.now(), url };
    return url;
  }

  /** Trouve le Synapse central : dernière adresse connue, puis celle publiée sur GitHub, puis l'adresse fixe */
  function resolve(reason = '') {
    if (up.resolving) return up.resolving;
    up.resolving = (async () => {
      const tried = [];
      const attempt = async (url, from) => {
        if (!url || tried.includes(url)) return false;
        tried.push(url);
        if (!(await healthy(url))) return false;
        const changed = url !== up.url;
        up.url = url;
        up.ok = true;
        up.error = '';
        up.from = from;
        if (changed) {
          log(`relais : Synapse central → ${url} (${from})`);
          writeDev({ adresse: url, maj: new Date().toISOString() });
        }
        return true;
      };
      try {
        if (reason) log(`relais : recherche du Synapse central (${reason})`);
        // SYNAPSE_CENTRAL : une adresse imposée (tests, réseau d'entreprise…)
        if (await attempt(cleanAddress(process.env.SYNAPSE_CENTRAL), 'SYNAPSE_CENTRAL')) return true;
        if (await attempt(up.url, 'dernière adresse')) return true;
        if (await attempt(await published(), customRendezvous ? 'point de rendez-vous' : 'GitHub')) return true;
        if (await attempt(central?.adresse, 'adresse fixe')) return true;
        up.ok = false;
        up.error = !central
          ? 'Aucun Synapse central n’est indiqué (central.json).'
          : 'Le Synapse central ne répond pas pour l’instant : l’ordinateur qui l’héberge est peut-être éteint, ou Internet est coupé.';
        return false;
      } finally {
        up.checkedAt = Date.now();
        up.resolving = null;
      }
    })();
    return up.resolving;
  }

  function markDown(why) {
    if (!up.ok) return;
    up.ok = false;
    up.error = why;
    log(`relais : Synapse central injoignable (${why})`);
    void resolve('connexion perdue');
  }

  // ───────────────────────── page d'attente (le serveur central ne répond pas)
  const offlinePage = () => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SYNAPSE — connexion…</title><style>
html,body{margin:0;height:100%;background:#000;color:#e9e9f1;font:15px/1.6 system-ui,Segoe UI,sans-serif}
.w{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
.c{max-width:520px;border:1px solid rgba(255,255,255,.08);background:linear-gradient(180deg,rgba(14,14,24,.8),rgba(5,5,10,.78));padding:30px;box-shadow:0 0 50px rgba(0,229,255,.06)}
.t{display:flex;gap:12px;align-items:center;font:600 14px/1 ui-monospace,Consolas,monospace;letter-spacing:.42em;text-transform:uppercase}
.d{width:8px;height:8px;transform:rotate(45deg);background:#ff2e88;box-shadow:0 0 12px #ff2e88}
.h{margin-top:26px;font:10px/1.4 ui-monospace,Consolas,monospace;letter-spacing:.16em;text-transform:uppercase;color:#00e5ff}
p{color:rgba(233,233,241,.7)} small{color:rgba(233,233,241,.4)}
button{font:10.5px ui-monospace,Consolas,monospace;letter-spacing:.14em;text-transform:uppercase;padding:7px 12px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.03);color:#e9e9f1;cursor:pointer;margin:6px 6px 0 0}
button:hover{border-color:#00e5ff} .p{background:rgba(0,229,255,.13);border-color:rgba(0,229,255,.6);color:#00e5ff}
.b{width:7px;height:7px;border-radius:50%;background:#ff4d6d;display:inline-block;margin-right:8px;animation:b 2.6s ease-in-out infinite}@keyframes b{50%{opacity:.35}}
</style></head><body><div class="w"><div class="c"><div class="t"><i class="d"></i>Synapse</div>
<div class="h"><span class="b"></span>Connexion au Synapse central…</div>
<p id="m">${String(up.error || 'Recherche du serveur…').replace(/[<>&]/g, '')}</p>
<small>Nouvel essai automatique toutes les quelques secondes : la page s’ouvrira toute seule dès que le serveur répond.</small><div style="margin-top:18px">
<button class="p" onclick="go()">Réessayer maintenant</button><button onclick="solo()">Utiliser Synapse seul sur ce PC</button></div>
<small id="s" style="display:block;margin-top:14px"></small></div></div>
<script>
async function st(){try{const r=await fetch('/__relais',{cache:'no-store'});return await r.json()}catch(e){return null}}
async function tick(){const s=await st();if(s&&s.ok){location.reload();return}if(s&&s.error)document.getElementById('m').textContent=s.error}
async function go(){document.getElementById('s').textContent='Recherche…';await fetch('/__relais/retry',{method:'POST',headers:{'X-Synapse':'relais'}}).catch(()=>{});await tick();document.getElementById('s').textContent=''}
async function solo(){if(!confirm('Utiliser Synapse seul sur ce PC ? Tu crées un compte qui ne vit que sur cet ordinateur (pas sur ton téléphone, pas chez le créateur). Tu pourras revenir au Synapse central plus tard avec « Lancer Synapse --client ».'))return;
document.getElementById('s').textContent='Démarrage de Synapse sur ce PC…';await fetch('/__relais/serveur',{method:'POST',headers:{'X-Synapse':'relais'}}).catch(()=>{});
const t=Date.now();const w=async()=>{try{const r=await fetch('/__synapse',{cache:'no-store'});const j=await r.json();if(j.mode==='serveur'){location.replace('/');return}}catch(e){}if(Date.now()-t<60000)setTimeout(w,700)};setTimeout(w,1200)}
setInterval(tick,3000);
</script></body></html>`;

  function sendJson(res, status, obj) {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': b.length });
    res.end(b);
  }

  // ───────────────────────── l'application, servie par ce PC (elle s'ouvre même sans connexion)
  const dist = path.join(appDir, 'dist');
  const hasApp = () => fs.existsSync(path.join(dist, 'index.html'));

  function serveApp(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    let rel;
    try {
      rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).slice(1);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const hidden = rel.split(/[\\/]/).some((seg) => seg.startsWith('.'));
    let file = path.resolve(dist, rel);
    if (rel.includes('\0') || hidden || !file.startsWith(dist + path.sep)) {
      res.writeHead(404);
      return res.end();
    }
    let st = null;
    try {
      st = fs.statSync(file);
    } catch {}
    if (!st || !st.isFile()) {
      // une adresse de l'application (/?cerveau=…) : la page de Synapse ; un fichier qui manque : 404
      if (path.extname(rel)) {
        res.writeHead(404);
        return res.end();
      }
      file = path.join(dist, 'index.html');
      try {
        st = fs.statSync(file);
      } catch {
        res.writeHead(500);
        return res.end();
      }
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const immutable = file.startsWith(path.join(dist, 'assets') + path.sep);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...SECURITY_HEADERS,
      ...(type.startsWith('text/html') ? { 'Content-Security-Policy': CSP } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  }

  /** Le serveur central ne répond pas : page d'attente pour une page, erreur claire pour l'application */
  function unavailable(req, res) {
    if (res.headersSent) return res.destroy();
    const p = String(req.url || '/');
    if (p.startsWith('/api/')) return sendJson(res, 502, { error: 'central', message: up.error || 'Synapse central injoignable' });
    if (req.method === 'GET' && !path.extname(p.split('?')[0])) {
      const b = Buffer.from(offlinePage());
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': b.length, 'Retry-After': '3' });
      return res.end(b);
    }
    res.writeHead(502);
    res.end();
  }

  function proxy(req, res) {
    let target;
    try {
      target = new URL(req.url, up.url);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const https_ = target.protocol === 'https:';
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.includes(k)) headers[k] = v;
    headers.host = target.host;
    headers['x-synapse-app'] = 'windows';
    // relayé : le serveur ne prend jamais cette requête pour « quelqu'un devant son propre écran »
    headers['x-forwarded-for'] = '127.0.0.1';
    delete headers.origin;
    delete headers.referer;
    const stream = /\/api\/(events|poll)\b/.test(target.pathname);
    const upReq = (https_ ? https : http).request(
      target,
      { method: req.method, headers, agent: https_ ? agentS : agentH, timeout: stream ? 70_000 : 45_000 },
      (ur) => {
        const status = ur.statusCode || 502;
        const type = String(ur.headers['content-type'] || '');
        // tunnel Cloudflare fermé (530), ou passerelle qui ne trouve plus le serveur : l'adresse a peut-être changé
        if (status === 530 || ((status === 502 || status === 504 || status === 521 || status === 523) && !type.includes('json'))) {
          ur.resume();
          markDown(`le serveur ne répond plus à ${up.url} (${status})`);
          return unavailable(req, res);
        }
        const h = {};
        for (const [k, v] of Object.entries(ur.headers)) if (!HOP.includes(k) && k !== 'strict-transport-security' && k !== 'alt-svc') h[k] = v;
        // le cookie de session vit ici, sur ce PC (http://localhost) : sans « Secure » ni domaine
        if (h['set-cookie']) h['set-cookie'] = [].concat(h['set-cookie']).map((c) => c.replace(/;\s*Secure/gi, '').replace(/;\s*Domain=[^;]*/gi, ''));
        res.writeHead(status, h);
        if (stream && typeof res.flushHeaders === 'function') res.flushHeaders();
        ur.pipe(res);
        ur.on('error', () => res.destroy());
        ur.on('aborted', () => res.destroy());
      },
    );
    upReq.on('timeout', () => upReq.destroy(new Error('délai dépassé')));
    upReq.on('error', (e) => {
      if (res.headersSent) return res.destroy();
      if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|délai|socket hang up/i.test(`${e.code} ${e.message}`)) markDown(e.code || e.message);
      unavailable(req, res);
    });
    res.on('close', () => {
      if (!res.writableFinished) upReq.destroy();
    });
    req.pipe(upReq);
  }

  function shutdown(why) {
    if (stopping) return;
    stopping = true;
    log(`relais : arrêt (${why})`);
    for (const c of alive) c.end();
    for (const s of servers) {
      try {
        s.close();
        s.closeAllConnections?.();
      } catch {}
    }
    agentS.destroy();
    agentH.destroy();
    setTimeout(() => process.exit(0), 250);
  }

  const hostOf = (req) => {
    const h = String(req.headers.host || '').toLowerCase();
    return h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  };

  function handler(req, res) {
    lastActivity = Date.now();
    // anti « DNS rebinding » : seulement « localhost »
    if (!LOCAL_NAMES.has(hostOf(req))) {
      res.writeHead(403);
      return res.end();
    }
    const p = String(req.url || '/').split('?')[0];
    if (p === '/__synapse') {
      return sendJson(res, 200, { app: 'synapse', mode: 'client', proto, code, pid: process.pid, root: path.join(appDir, 'dist'), clients: alive.size, since: started, upstream: up.url || null, ok: up.ok });
    }
    if (p === '/__alive') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      alive.add(res);
      hadClient = true;
      req.on('close', () => {
        alive.delete(res);
        lastActivity = Date.now();
      });
      return;
    }
    if (p === '/__quit') {
      if (req.method !== 'POST' || req.headers['x-synapse'] !== 'quit') {
        res.writeHead(403);
        return res.end();
      }
      res.writeHead(200);
      res.end('bye');
      return shutdown('quit');
    }
    if (p === '/__relais') {
      return sendJson(res, 200, { mode: 'client', ok: up.ok, upstream: up.url || null, from: up.from, error: up.ok ? '' : up.error, depot: central?.depot || null, checkedAt: up.checkedAt });
    }
    if (p === '/__relais/retry' || p === '/__relais/serveur') {
      if (req.method !== 'POST' || req.headers['x-synapse'] !== 'relais') {
        res.writeHead(403);
        return res.end();
      }
      if (p === '/__relais/retry') {
        rendezvous.at = 0;
        return void resolve('nouvel essai demandé').then((ok) => sendJson(res, 200, { ok, error: up.error }));
      }
      // « Utiliser Synapse seul sur ce PC » : ce PC devient son propre serveur
      writeDev({ mode: 'serveur' });
      sendJson(res, 200, { ok: true });
      log('relais : passage en mode « serveur sur ce PC »');
      stopping = true;
      for (const c of alive) c.end();
      for (const s of servers) {
        try {
          s.close();
          s.closeAllConnections?.();
        } catch {}
      }
      setTimeout(() => {
        spawnServer();
        setTimeout(() => process.exit(0), 300);
      }, 400);
      return;
    }
    // l'application vient de ce PC : elle s'ouvre même sans connexion (seule l'API part au Synapse central)
    if (!p.startsWith('/api/') && hasApp()) return serveApp(req, res, p);
    if (!up.ok) {
      // une nouvelle recherche au plus toutes les 5 s pendant qu'on attend
      if (Date.now() - up.checkedAt > 5000) void resolve();
      return unavailable(req, res);
    }
    proxy(req, res);
  }

  const listen = (h) =>
    new Promise((ok, ko) => {
      const s = http.createServer(handler);
      s.keepAliveTimeout = 65_000;
      s.once('error', ko);
      s.listen(port, h, () => {
        s.removeListener('error', ko);
        s.on('error', (e) => log(`relais ${h}: ${e.message}`));
        servers.push(s);
        ok();
      });
    });

  process.on('uncaughtException', (e) => {
    log(`relais : plantage ${e.stack || e}`);
    process.exit(1);
  });

  listen(HOSTS[0])
    .catch((e) => {
      log(`relais : port ${port} indisponible (${e.code})`);
      process.exit(e.code === 'EADDRINUSE' ? 3 : 2);
    })
    .then(() => listen(HOSTS[1]).catch(() => {}))
    .then(async () => {
      log(`relais : démarré · port ${port} · dépôt ${central?.depot || '—'}`);
      await resolve('démarrage');
      // vérification régulière : un serveur central revenu (ou une nouvelle adresse) est retrouvé tout seul
      setInterval(() => {
        const now = Date.now();
        if (!up.ok && now - up.checkedAt > 10_000) void resolve();
        else if (up.ok && alive.size && now - up.checkedAt > 120_000) {
          // de temps en temps, on s'assure que l'adresse connue répond toujours
          void healthy(up.url).then((ok) => {
            up.checkedAt = Date.now();
            if (!ok) markDown('vérification périodique');
          });
        }
        for (const c of alive) c.write(': ping\n\n');
        if (alive.size > 0) return;
        const idle = now - lastActivity;
        if (idle > (hadClient ? idleMs : firstMs)) shutdown(hadClient ? 'fenêtres fermées' : 'aucune fenêtre');
      }, 5000).unref?.();
    });
}
