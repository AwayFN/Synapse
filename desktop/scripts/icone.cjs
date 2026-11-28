'use strict';
// Fabrique l'icône de l'application Windows à partir de celle de Synapse (app/public/icon.svg) :
//   desktop/icon.png       l'icône de la fenêtre (256 × 256)
//   desktop/build/icon.ico l'icône de l'installateur, du raccourci sur le bureau et de Synapse.exe (16 à 256 px)
// À relancer seulement si l'icône change :  npm run icone   (dans desktop/)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, '..', 'app', 'public', 'icon.svg'), 'utf8');

/** Un fichier .ico qui contient chaque taille en PNG (Windows Vista et plus) */
function ico(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([head, ...entries, ...pngs.map((p) => p.data)]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 300, height: 300 });
  await win.loadURL('data:text/html;charset=utf-8,<!doctype html><html><body></body></html>');
  const src = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
  // l'icône de Synapse, et celle de l'installateur : la même, avec une flèche de téléchargement (on ne les confond pas)
  const render = (badge) =>
    win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(src)};
    await img.decode();
    const out = {};
    for (const s of ${JSON.stringify(SIZES)}) {
      const c = document.createElement('canvas');
      c.width = s; c.height = s;
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, 0, 0, s, s);
      if (${badge}) {
        const k = s / 512;
        g.beginPath();
        g.arc(392 * k, 392 * k, 112 * k, 0, Math.PI * 2);
        g.fillStyle = '#000';
        g.fill();
        g.beginPath();
        g.arc(392 * k, 392 * k, 96 * k, 0, Math.PI * 2);
        g.fillStyle = '#00e5ff';
        g.fill();
        g.strokeStyle = '#000';
        g.lineWidth = 26 * k;
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.beginPath();
        g.moveTo(392 * k, 334 * k);
        g.lineTo(392 * k, 444 * k);
        g.moveTo(346 * k, 400 * k);
        g.lineTo(392 * k, 446 * k);
        g.lineTo(438 * k, 400 * k);
        g.stroke();
      }
      out[s] = c.toDataURL('image/png');
    }
    return out;
  })()`);
  const toPngs = (urls) => SIZES.map((size) => ({ size, data: Buffer.from(urls[size].split(',')[1], 'base64') }));
  const pngs = toPngs(await render(false));
  const setup = toPngs(await render(true));
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico(pngs));
  fs.writeFileSync(path.join(root, 'build', 'installer.ico'), ico(setup));
  fs.writeFileSync(path.join(root, 'icon.png'), pngs.find((p) => p.size === 256).data);
  console.log(`icônes prêtes : icon.png, build/icon.ico et build/installer.ico (${SIZES.join(', ')} px)`);
  app.quit();
});
