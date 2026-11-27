'use strict';
// Copie l'application compilée (app/dist) dans desktop/web : c'est elle que l'installateur met dans Synapse.
// (Compiler d'abord l'application : dans app/, « npm run build ».)
const fs = require('node:fs');
const path = require('node:path');

const src = path.join(__dirname, '..', '..', 'app', 'dist');
const dest = path.join(__dirname, '..', 'web');
if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error("app/dist/index.html introuvable : compile d'abord Synapse (dans app/ : npm run build).");
  process.exit(1);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
const n = fs.readdirSync(path.join(dest, 'assets')).length;
console.log(`web/ prêt (${n} fichiers dans assets/)`);
