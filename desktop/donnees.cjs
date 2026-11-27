'use strict';
// Les données de Synapse pour Windows : un fichier dans %APPDATA%\Synapse, sur ce PC et nulle part ailleurs.
//
//   %APPDATA%\Synapse\synapse-donnees.json       tout ton réseau (projets, tâches, notes, créneaux, liens, réglages)
//   %APPDATA%\Synapse\sauvegardes\               une copie par jour, gardée 14 jours
//
// L'application (la page) lit tout au démarrage, puis envoie chaque changement ; le fichier est écrit d'un bloc
// (fichier temporaire puis renommage) : une coupure de courant ne laisse jamais un fichier à moitié écrit.
//
// Premier lancement sur un PC qui avait l'ancienne version (V5 à V7, avec le « Synapse central ») : le réseau du compte de
// ce PC (%APPDATA%\Synapse\cerveaux\…\cerveau.json) est repris tel quel, avec la place de chaque neurone. Les anciens
// fichiers ne sont ni modifiés ni supprimés.
const fs = require('node:fs');
const path = require('node:path');

const FILE = 'synapse-donnees.json';
const BACKUPS = 'sauvegardes';
const KEEP_DAYS = 14;
/** la clé du réseau dans la page (zustand) et sa version : 2 = format V6/V7 (la page le met à jour toute seule) */
const DATA_KEY = 'synapse-data';
const LAYOUT_KEY = 'synapse-layout';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Le réseau de l'ancienne version sur ce PC (le compte « de ce PC », sinon le créateur, sinon le plus récent) */
function findOldBrain(dir) {
  const brainsDir = path.join(dir, 'cerveaux');
  let folders = [];
  try {
    folders = fs.readdirSync(brainsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  const withFile = folders.filter((f) => fs.existsSync(path.join(brainsDir, f, 'cerveau.json')));
  if (!withFile.length) return null;
  const accounts = Object.values((readJson(path.join(dir, 'comptes.json')) || {}).accounts || {});
  const mine =
    accounts.find((a) => a && a.pc && withFile.includes(a.brainId)) ||
    accounts.filter((a) => a && a.role === 'createur' && withFile.includes(a.brainId)).sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0))[0];
  if (mine) return path.join(brainsDir, mine.brainId, 'cerveau.json');
  const newest = withFile
    .map((f) => {
      const file = path.join(brainsDir, f, 'cerveau.json');
      return { file, at: fs.statSync(file).mtimeMs };
    })
    .sort((a, b) => b.at - a.at)[0];
  return newest.file;
}

/** Reprend le réseau de l'ancienne version : les éléments, les liens, le journal, la place des neurones */
function migrateFromOld(dir) {
  const file = findOldBrain(dir);
  if (!file) return null;
  const d = readJson(file);
  if (!d || typeof d.entities !== 'object' || !d.entities) return null;
  const entities = {};
  for (const [id, e] of Object.entries(d.entities)) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !['project', 'task', 'note', 'slot'].includes(e.type)) continue;
    // ce qui venait du partage n'a plus de sens : tout est à toi, ici
    const { private: _p, createdBy: _c, updatedBy: _u, ...rest } = e;
    entities[id] = rest;
  }
  const count = Object.keys(entities).length;
  if (!count) return null;
  const links = (Array.isArray(d.links) ? d.links : [])
    .filter((l) => l && entities[l.a] && entities[l.b])
    .map((l) => ({ id: l.id, a: l.a, b: l.b, createdAt: l.createdAt || Date.now() }));
  const activity = (Array.isArray(d.activity) ? d.activity : [])
    .filter((a) => a && typeof a.id === 'string')
    .slice(0, 60)
    .map((a) => ({ id: a.id, at: a.at, text: a.text, color: a.color, ...(a.entityId ? { entityId: a.entityId } : {}) }));
  const layout = {};
  for (const [id, p] of Object.entries(d.layout || {})) {
    if (entities[id] && Array.isArray(p) && p.length === 3 && p.every((x) => Number.isFinite(x))) layout[id] = p;
  }
  return {
    count,
    from: file,
    items: {
      [DATA_KEY]: JSON.stringify({ state: { entities, links, activity }, version: 2 }),
      [LAYOUT_KEY]: JSON.stringify(layout),
    },
  };
}

class Donnees {
  constructor(dir, log = () => {}) {
    this.dir = dir;
    this.file = path.join(dir, FILE);
    this.backupDir = path.join(dir, BACKUPS);
    this.log = log;
    /** clé → texte (comme le stockage d'une page) */
    this.items = {};
    this.migrated = null;
    this.timer = null;
    this.lastBackupDay = '';
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    const exists = fs.existsSync(this.file);
    let d = exists ? readJson(this.file) : null;
    if (exists && !(d && d.items)) {
      // illisible (disque plein, coupure…) : on le garde de côté et on repart de la dernière sauvegarde
      try {
        fs.copyFileSync(this.file, path.join(this.dir, `synapse-donnees-illisible-${Date.now()}.json`));
      } catch (e) {
        this.log(`copie du fichier illisible : ${e.message}`);
      }
      d = this.latestBackup();
      this.log(d ? 'fichier illisible : dernière sauvegarde reprise' : 'fichier illisible et aucune sauvegarde');
    }
    if (d && d.items && typeof d.items === 'object') {
      for (const [k, v] of Object.entries(d.items)) if (typeof v === 'string') this.items[k] = v;
    } else if (!exists) {
      const m = migrateFromOld(this.dir);
      if (m) {
        this.items = m.items;
        this.migrated = { count: m.count };
        this.log(`réseau de la version précédente repris : ${m.count} éléments (${m.from})`);
        this.saveNow();
      }
    }
    return this.items;
  }

  latestBackup() {
    try {
      const files = fs
        .readdirSync(this.backupDir)
        .filter((f) => /^synapse-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
        .reverse();
      for (const f of files) {
        const d = readJson(path.join(this.backupDir, f));
        if (d && d.items) return d;
      }
    } catch {
      /* pas de sauvegarde */
    }
    return null;
  }

  /** Les changements envoyés par la page : { clé: texte } (null = effacer) */
  patch(changes) {
    if (!changes || typeof changes !== 'object') return;
    for (const [k, v] of Object.entries(changes)) {
      if (typeof k !== 'string' || k.length > 200) continue;
      if (v === null) delete this.items[k];
      else if (typeof v === 'string') this.items[k] = v;
    }
    this.schedule();
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      writeAtomic(this.file, JSON.stringify({ app: 'synapse', v: 8, savedAt: new Date().toISOString(), items: this.items }));
      this.backup();
    } catch (e) {
      this.log(`écriture impossible : ${e.message}`);
      return false;
    }
    return true;
  }

  /** Une copie par jour, les 14 derniers jours */
  backup() {
    const day = dayKey();
    if (day === this.lastBackupDay) return;
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      fs.copyFileSync(this.file, path.join(this.backupDir, `synapse-${day}.json`));
      this.lastBackupDay = day;
      const old = fs
        .readdirSync(this.backupDir)
        .filter((f) => /^synapse-\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
        .reverse()
        .slice(KEEP_DAYS);
      for (const f of old) fs.unlinkSync(path.join(this.backupDir, f));
    } catch (e) {
      this.log(`sauvegarde : ${e.message}`);
    }
  }
}

module.exports = { Donnees, migrateFromOld, findOldBrain, FILE };
