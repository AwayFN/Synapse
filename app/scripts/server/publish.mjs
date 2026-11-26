// Le Synapse central publie son adresse Internet sur GitHub, pour que les applications (téléphone Android, PC
// Windows) le retrouvent toutes seules, même quand l'adresse gratuite change (à chaque redémarrage de Synapse).
//
//   dépôt (central.json) → branche « synapse-adresse » → fichier « adresse.json » :
//     { "app": "synapse", "adresse": "https://….trycloudflare.com", "proto": 6, "maj": "2026-11-25T21:00:00.000Z" }
//
// La publication passe par git, avec les identifiants GitHub déjà enregistrés sur ce PC (ceux qui servent à
// publier Synapse) : rien à régler. Elle se fait seulement sur le PC qui a une copie git du dépôt officiel
// (le PC du créateur), jamais chez les autres. Les applications lisent ce fichier ; elles n'écrivent jamais.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const BRANCH = 'synapse-adresse';
const FILE = 'adresse.json';

/** central.json : le dépôt GitHub de Synapse (et, si elle existe, son adresse fixe) */
export function readCentral(appDir) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(appDir, 'central.json'), 'utf8'));
    const depot = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(c.depot || '')) ? String(c.depot) : '';
    const fixe = /^https?:\/\/[^\s/]+$/i.test(String(c.adresse || '').replace(/\/+$/, '')) ? String(c.adresse).replace(/\/+$/, '') : '';
    return depot ? { depot, branche: String(c.branche || BRANCH), fichier: String(c.fichier || FILE), adresse: fixe } : null;
  } catch {
    return null;
  }
}

/** Ce dossier est-il une copie git du dépôt officiel ? (c'est alors le PC du créateur) */
function officialClone(appDir, depot) {
  try {
    const cfg = fs.readFileSync(path.join(appDir, '..', '.git', 'config'), 'utf8');
    const want = depot.toLowerCase();
    for (const m of cfg.matchAll(/^\s*url\s*=\s*(.+)$/gim)) {
      const u = m[1].trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
      if (u.endsWith(`github.com/${want}`) || u.endsWith(`github.com:${want}`)) return true;
    }
  } catch {}
  return false;
}

function run(args, { cwd, env, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, windowsHide: true, timeout, maxBuffer: 1_000_000 }, (err, stdout, stderr) => {
      if (err) {
        err.message = String(stderr || err.message || '').trim().split('\n').slice(-3).join(' ').slice(0, 280) || err.message;
        return reject(err);
      }
      resolve(String(stdout).trim());
    });
  });
}

export class Publisher {
  /**
   * appDir : dossier « app » · dataDir : données de Synapse · settings : réglages (publication)
   * current() : l'adresse Internet du serveur en ce moment (ou null) · onChange() : l'état a changé
   */
  constructor({ appDir, dataDir, settings, log, current, onChange, hosted }) {
    this.central = readCentral(appDir);
    this.official = !hosted && !!this.central && officialClone(appDir, this.central.depot);
    this.repo = path.join(dataDir, 'outils', 'adresse.git');
    this.settings = settings;
    this.log = log;
    this.current = current;
    this.onChange = onChange || (() => {});
    this.busy = false;
    this.timer = null;
    this.failures = 0;
  }

  /** La publication est-elle active ? (automatique sur le PC du créateur, sauf si l'admin l'a coupée) */
  get enabled() {
    const on = this.settings.d.publication.on;
    return this.official && on !== false;
  }

  status() {
    const p = this.settings.d.publication;
    return {
      eligible: this.official,
      enabled: this.enabled,
      depot: this.central?.depot || '',
      branche: this.central?.branche || BRANCH,
      url: p.url || null,
      at: p.at || 0,
      error: p.error || '',
      busy: this.busy,
      pending: !!this.timer,
      current: this.current() || null,
      fixe: this.central?.adresse || '',
    };
  }

  /** L'adresse a peut-être changé : on publie (un peu plus tard, pour regrouper les changements) */
  check(delay = 2500) {
    if (!this.enabled) return;
    const url = this.current();
    if (!url || url === this.settings.d.publication.url) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.publish();
    }, delay);
    this.timer.unref?.();
  }

  async publish(force = false) {
    const url = this.current();
    if (!this.official || !url || this.busy) return this.status();
    if (!force && (!this.enabled || url === this.settings.d.publication.url)) return this.status();
    this.busy = true;
    this.onChange();
    try {
      await this.push(url);
      this.failures = 0;
      this.settings.set({ publication: { url, at: Date.now(), error: '', tried: Date.now() } });
      this.log(`adresse publiée sur GitHub (${this.central.depot}, branche ${this.central.branche}) : ${url}`);
    } catch (e) {
      this.failures++;
      const msg = e.code === 'ENOENT' ? 'git est introuvable sur ce PC' : e.message || String(e);
      this.settings.set({ publication: { error: msg, tried: Date.now() } });
      this.log(`publication de l'adresse impossible : ${msg}`);
      // nouvel essai : 1 min, 5 min, puis toutes les 15 min
      const wait = [60_000, 300_000, 900_000][Math.min(this.failures - 1, 2)];
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.publish();
      }, wait);
      this.timer.unref?.();
    } finally {
      this.busy = false;
      this.onChange();
    }
    return this.status();
  }

  /** Un commit d'un seul fichier, poussé (en remplaçant l'ancien) sur la branche de l'adresse */
  async push(url) {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_AUTHOR_NAME: 'Synapse',
      GIT_AUTHOR_EMAIL: 'synapse@localhost',
      GIT_COMMITTER_NAME: 'Synapse',
      GIT_COMMITTER_EMAIL: 'synapse@localhost',
    };
    fs.mkdirSync(path.dirname(this.repo), { recursive: true });
    if (!fs.existsSync(path.join(this.repo, 'HEAD'))) await run(['init', '--bare', '--quiet', this.repo], { env });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-adresse-'));
    try {
      const file = path.join(tmp, FILE);
      const body = { app: 'synapse', adresse: url, proto: 7, maj: new Date().toISOString() };
      fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
      const opts = { cwd: this.repo, env: { ...env, GIT_INDEX_FILE: path.join(tmp, 'index') } };
      const blob = await run(['hash-object', '-w', file], opts);
      await run(['update-index', '--add', '--cacheinfo', `100644,${blob},${this.central.fichier}`], opts);
      const tree = await run(['write-tree'], opts);
      const commit = await run(['commit-tree', tree, '-m', `Synapse : adresse du serveur (${body.maj.slice(0, 16).replace('T', ' ')})`], opts);
      // SYNAPSE_PUBLICATION_REMOTE : un autre dépôt git (essais)
      const remote = process.env.SYNAPSE_PUBLICATION_REMOTE || `https://github.com/${this.central.depot}.git`;
      await run(['push', '--force', '--quiet', remote, `${commit}:refs/heads/${this.central.branche}`], { ...opts, timeout: 90_000 });
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  }

  setEnabled(on) {
    this.settings.set({ publication: { on: !!on } });
    if (on) this.check(200);
    else if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.onChange();
    return this.status();
  }
}
