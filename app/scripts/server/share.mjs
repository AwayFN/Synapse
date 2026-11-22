// Comment les invités rejoignent le cerveau : même réseau (Wi-Fi) ou Internet (tunnel Cloudflare).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { lanAddresses } from './util.mjs';

/** Toute requête arrivant par le tunnel porte cet en-tête Host : elle n'est jamais prise pour le propriétaire */
export const TUNNEL_HOST = 'tunnel.synapse.invalid';
const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

export class Share {
  constructor({ port, dataDir, handler, log, onChange, tunnel }) {
    /** adresse fixe (tunnel Cloudflare nommé) : { token, url } choisis dans l'espace créateur */
    this.tunnelConfig = tunnel || (() => ({}));
    this.port = port;
    this.toolsDir = path.join(dataDir, 'outils');
    this.exe = process.env.SYNAPSE_CLOUDFLARED || path.join(this.toolsDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    this.handler = handler;
    this.log = log;
    this.onChange = onChange || (() => {});
    this.lan = { on: false, servers: [], urls: [], error: null };
    this.net = { state: 'off', url: null, error: null, proc: null, progress: 0 };
    /** l'accès Internet est voulu : s'il tombe (coupure, mise en veille), il se relance tout seul */
    this.wantNet = false;
    this.retryTimer = null;
    this.retries = 0;
  }

  /** Relance l'accès Internet après une coupure (10 s, 30 s, 1 min… puis toutes les 5 min) */
  scheduleRetry() {
    if (!this.wantNet || this.retryTimer || !this.toolReady()) return;
    const delays = [10_000, 30_000, 60_000, 120_000, 300_000];
    const ms = delays[Math.min(this.retries, delays.length - 1)];
    this.retries++;
    this.log(`tunnel : nouvel essai dans ${Math.round(ms / 1000)} s`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wantNet && this.net.state !== 'on' && this.net.state !== 'starting' && this.net.state !== 'downloading') void this.startInternet(false);
    }, ms);
    this.retryTimer.unref?.();
    this.onChange();
  }

  get active() {
    return this.lan.on || this.net.state === 'on' || this.net.state === 'starting' || this.net.state === 'downloading';
  }

  status() {
    return {
      lan: { on: this.lan.on, urls: this.lan.urls, error: this.lan.error },
      internet: {
        state: this.net.state,
        url: this.net.url,
        error: this.net.error,
        progress: this.net.progress,
        toolReady: this.toolReady(),
        fixed: !!this.net.fixed,
        /** une coupure : relance automatique en attente */
        retrying: !!this.retryTimer,
      },
    };
  }

  /** Noms d'hôte acceptés en plus de « localhost » */
  allowedHost(hostname) {
    if (hostname === TUNNEL_HOST) return this.net.state === 'on' || this.net.state === 'starting';
    if (this.net.url && hostname === new URL(this.net.url).hostname) return true;
    if (this.lan.on && this.lan.addresses?.includes(hostname)) return true;
    return (process.env.SYNAPSE_EXTRA_HOSTS || '').split(',').filter(Boolean).includes(hostname);
  }
  /** Par où la requête est arrivée */
  via(req) {
    const host = String(req.headers.host || '').toLowerCase().split(':')[0];
    if (host === TUNNEL_HOST || (this.net.url && host === new URL(this.net.url).hostname)) return 'internet';
    if (this.lan.addresses?.includes(host)) return 'lan';
    return 'local';
  }

  // ── réseau local
  async startLan() {
    if (this.lan.on) return this.status();
    const addrs = (process.env.SYNAPSE_LAN_ADDRESSES || '').split(',').filter(Boolean);
    const list = addrs.length ? addrs : lanAddresses();
    if (!list.length) {
      this.lan.error = "Aucun réseau local trouvé (es-tu connecté au Wi-Fi ?)";
      this.onChange();
      return this.status();
    }
    const servers = [];
    const ok = [];
    for (const addr of list) {
      try {
        await new Promise((resolve, reject) => {
          const s = http.createServer(this.handler);
          s.once('error', reject);
          s.listen(this.port, addr, () => {
            s.removeListener('error', reject);
            s.on('error', (e) => this.log(`lan ${addr}: ${e.message}`));
            servers.push(s);
            ok.push(addr);
            resolve();
          });
        });
      } catch (e) {
        this.log(`lan listen ${addr}: ${e.code || e.message}`);
      }
    }
    this.lan = {
      on: ok.length > 0,
      servers,
      addresses: ok,
      urls: ok.map((a) => `http://${a}:${this.port}`),
      error: ok.length ? null : "Impossible d'ouvrir l'accès réseau local",
    };
    this.log(`lan ${this.lan.on ? 'on ' + ok.join(',') : 'failed'}`);
    this.onChange();
    return this.status();
  }

  stopLan() {
    for (const s of this.lan.servers) {
      try {
        s.close();
        s.closeAllConnections?.();
      } catch {}
    }
    this.lan = { on: false, servers: [], urls: [], addresses: [], error: null };
    this.onChange();
    return this.status();
  }

  // ── Internet (tunnel Cloudflare, sans compte, adresse temporaire)
  toolReady() {
    try {
      return fs.statSync(this.exe).size > 1_000_000 || !!process.env.SYNAPSE_CLOUDFLARED;
    } catch {
      return false;
    }
  }

  download(url, dest, redirects = 6) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'User-Agent': 'Synapse' }, timeout: 30_000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          if (!next.startsWith('https://')) return reject(new Error('redirection non sécurisée'));
          return resolve(this.download(next, dest, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`téléchargement refusé (${res.statusCode})`));
        }
        const total = Number(res.headers['content-length']) || 0;
        let got = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (c) => {
          got += c.length;
          if (total) this.net.progress = Math.round((got / total) * 100);
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(got)));
        out.on('error', reject);
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('délai dépassé')));
      req.on('error', reject);
    });
  }

  /** Le programme téléchargé doit être signé par Cloudflare, sinon il est supprimé */
  verifySignature(file) {
    if (process.platform !== 'win32') return true;
    try {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const out = execFileSync(
        ps,
        ['-NoProfile', '-NonInteractive', '-Command', `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`],
        { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
      ).trim();
      const [status, subject] = out.split('|');
      this.log(`signature cloudflared: ${status} ${subject}`);
      return status === 'Valid' && /Cloudflare/i.test(subject || '');
    } catch (e) {
      this.log(`signature: ${e.message}`);
      return false;
    }
  }

  async ensureTool(consent) {
    if (this.toolReady()) return true;
    if (!consent) {
      this.net = { ...this.net, state: 'needs-consent', error: null };
      this.onChange();
      return false;
    }
    this.net = { ...this.net, state: 'downloading', error: null, progress: 0 };
    this.onChange();
    fs.mkdirSync(this.toolsDir, { recursive: true });
    const tmp = `${this.exe}.download`;
    try {
      const size = await this.download(CLOUDFLARED_URL, tmp);
      if (size < 1_000_000) throw new Error('fichier incomplet');
      if (!this.verifySignature(tmp)) throw new Error("signature Cloudflare invalide : fichier supprimé par sécurité");
      fs.renameSync(tmp, this.exe);
      return true;
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      this.net = { ...this.net, state: 'error', error: `Téléchargement impossible : ${e.message}` };
      this.onChange();
      return false;
    }
  }

  async startInternet(consent) {
    if (this.net.state === 'on' || this.net.state === 'starting' || this.net.state === 'downloading') return this.status();
    if (!(await this.ensureTool(consent))) return this.status();
    this.wantNet = true;
    const cfg = this.tunnelConfig() || {};
    if (cfg.token && cfg.url) await this.spawnFixed(cfg);
    else await this.spawnTunnel(true);
    if (this.net.state === 'on') this.retries = 0;
    else this.scheduleRetry();
    return this.status();
  }

  /** Adresse fixe : tunnel Cloudflare nommé (compte Cloudflare + nom de domaine, réglés par le créateur) */
  spawnFixed({ token, url }) {
    return new Promise((resolve) => {
      this.net = { state: 'starting', url: null, error: null, proc: null, progress: 100, fixed: true };
      this.onChange();
      const args = ['tunnel', '--no-autoupdate', 'run'];
      const isScript = /\.m?js$/i.test(this.exe);
      // le jeton passe par l'environnement : il n'apparaît pas dans la liste des processus
      const proc = spawn(isScript ? process.execPath : this.exe, isScript ? [this.exe, ...args] : args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, TUNNEL_TOKEN: token },
      });
      this.net.proc = proc;
      let output = '';
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };
      const onData = (chunk) => {
        output = (output + chunk.toString()).slice(-8000);
        if (/Registered tunnel connection|Connection [a-f0-9-]+ registered/i.test(output) && this.net.state === 'starting' && this.net.proc === proc) {
          this.net.url = url;
          this.net.state = 'on';
          this.log(`tunnel fixe ${url}`);
          this.onChange();
          done();
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e) => {
        if (this.net.proc !== proc) return;
        this.net = { state: 'error', url: null, error: `Le tunnel n'a pas pu démarrer (${e.message})`, proc: null, progress: 0, fixed: true };
        this.onChange();
        done();
      });
      proc.on('exit', (code) => {
        if (this.net.proc !== proc) return;
        const wasOn = this.net.state === 'on';
        if (wasOn) setTimeout(() => this.scheduleRetry(), 0);
        const bad = /invalid|unauthorized|token/i.test(output);
        this.net = {
          state: wasOn ? 'off' : 'error',
          url: null,
          error: wasOn ? "Le tunnel s'est arrêté" : bad ? 'Jeton de tunnel refusé par Cloudflare : vérifie-le dans l’espace créateur.' : `Le tunnel s'est arrêté (code ${code}).`,
          proc: null,
          progress: 0,
          fixed: true,
        };
        this.log(`tunnel fixe exit ${code}`);
        this.onChange();
        done();
      });
      const timer = setTimeout(() => {
        if (this.net.proc === proc && this.net.state === 'starting') {
          this.killTunnel();
          this.net.state = 'error';
          this.net.error = 'Le tunnel ne répond pas (Internet coupé, jeton ou réglage Cloudflare incorrect).';
          this.onChange();
        }
        done();
      }, 45_000);
    });
  }

  spawnTunnel(withHostHeader) {
    return new Promise((resolve) => {
      this.net = { state: 'starting', url: null, error: null, proc: null, progress: 100 };
      this.onChange();
      const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`];
      if (withHostHeader) args.push('--http-host-header', TUNNEL_HOST);
      const isScript = /\.m?js$/i.test(this.exe);
      const proc = spawn(isScript ? process.execPath : this.exe, isScript ? [this.exe, ...args] : args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.net.proc = proc;
      let output = '';
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };
      const onData = (chunk) => {
        output = (output + chunk.toString()).slice(-8000);
        const m = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (m && this.net.state === 'starting' && this.net.proc === proc) {
          this.net.url = m[0].toLowerCase();
          this.net.state = 'on';
          this.log(`tunnel ${this.net.url}`);
          this.onChange();
          done();
        }
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('error', (e) => {
        if (this.net.proc !== proc) return;
        this.net = { state: 'error', url: null, error: `Le tunnel n'a pas pu démarrer (${e.message})`, proc: null, progress: 0 };
        this.onChange();
        done();
      });
      proc.on('exit', (code) => {
        if (this.net.proc !== proc) return;
        // ancienne version sans l'option d'en-tête : on réessaie sans
        if (withHostHeader && this.net.state === 'starting' && /flag provided but not defined|http-host-header/i.test(output)) {
          this.net.proc = null;
          this.spawnTunnel(false).then(done);
          return;
        }
        const wasOn = this.net.state === 'on';
        if (wasOn) setTimeout(() => this.scheduleRetry(), 0);
        this.net = {
          state: wasOn ? 'off' : 'error',
          url: null,
          error: wasOn ? "Le tunnel s'est arrêté : nouvel essai automatique dans un instant." : `Le tunnel s'est arrêté (code ${code}). Vérifie la connexion Internet.`,
          proc: null,
          progress: 0,
        };
        this.log(`tunnel exit ${code}`);
        this.onChange();
        done();
      });
      const timer = setTimeout(() => {
        if (this.net.proc === proc && this.net.state === 'starting') {
          this.killTunnel();
          this.net.state = 'error';
          this.net.error = 'Le tunnel ne répond pas (Internet coupé ou Cloudflare indisponible).';
          this.onChange();
        }
        done();
      }, 45_000);
    });
  }

  /** Arrête le programme du tunnel (sans changer ce qui est voulu) */
  killTunnel() {
    const p = this.net.proc;
    this.net = { state: 'off', url: null, error: null, proc: null, progress: 0 };
    if (p) {
      try {
        p.kill();
      } catch {}
    }
  }

  /** Fermeture voulue de l'accès Internet : plus de relance automatique */
  stopInternet() {
    this.wantNet = false;
    this.retries = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.killTunnel();
    this.onChange();
    return this.status();
  }

  stopAll() {
    this.stopLan();
    this.stopInternet();
  }
}
