// Synapse en ligne : le serveur seul, pour un hébergeur (VPS, Docker, Render, Railway, Fly.io…).
//
//   node scripts/serveur-public.mjs
//
// Variables d'environnement :
//   PORT (ou SYNAPSE_PORT)     port d'écoute (8080 par défaut)
//   SYNAPSE_HOST               adresse d'écoute (0.0.0.0 par défaut)
//   SYNAPSE_DATA_DIR           dossier des données : À METTRE SUR UN DISQUE PERSISTANT (/data dans Docker)
//   SYNAPSE_URL_PUBLIQUE       adresse publique, ex. https://synapse.mon-domaine.fr (liens d'invitation,
//                              et seuls les visiteurs arrivant par cette adresse sont acceptés)
//   SYNAPSE_SETUP_TOKEN        (facultatif) jeton d'installation choisi à l'avance
//
// Au premier démarrage, le journal affiche un lien « INSTALLATION » : ouvre-le pour créer le compte créateur.
// L'application doit avoir été compilée avant (dist/) : `node scripts/synapse.mjs --build`, ou le Dockerfile.
// HTTPS : laisse l'hébergeur (ou un proxy comme Caddy/nginx) s'en charger devant ce serveur.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server/server.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(APP_DIR, 'dist');
const port = Number(process.env.PORT || process.env.SYNAPSE_PORT) || 8080;

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('Synapse : dist/index.html introuvable. Compile d’abord l’application : node scripts/synapse.mjs --build');
  process.exit(1);
}

const stamp = () => {
  try {
    return fs.readFileSync(path.join(DIST, '.synapse-build'), 'utf8').trim();
  } catch {
    return '';
  }
};
const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

startServer({ port, dist: DIST, idleMs: 0, firstMs: 0, log, stamp, hosted: true });
