// Petits outils du serveur Synapse (aucune dépendance).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Dossier des données : %APPDATA%\Synapse (indépendant du dossier de l'application) */
export function dataDir() {
  const base =
    process.env.SYNAPSE_DATA_DIR ||
    (process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Synapse')
      : path.join(os.homedir(), '.synapse'));
  fs.mkdirSync(base, { recursive: true });
  return base;
}

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Écriture sans risque de fichier à moitié écrit : fichier temporaire puis renommage */
export function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = 2_000_000) {
  const text = await readBody(req, limit);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** En-têtes de sécurité communs à toutes les réponses */
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
  "font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export function json(req, res, status, obj, extra = {}) {
  let body = Buffer.from(JSON.stringify(obj ?? {}));
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extra,
  };
  if (body.length > 8192 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    body = zlib.gzipSync(body, { level: 6 });
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(body);
}

export function isLoopback(addr) {
  const a = String(addr || '');
  return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}

/** La requête est passée par un intermédiaire (tunnel, proxy) : jamais le propriétaire local */
export function isProxied(req) {
  const h = req.headers;
  return !!(h['cf-connecting-ip'] || h['cf-ray'] || h['x-forwarded-for'] || h['x-forwarded-host'] || h.forwarded);
}

export function isHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '');
  const visitor = String(req.headers['cf-visitor'] || '');
  return proto.includes('https') || visitor.includes('https');
}

/** Adresse du visiteur ; derrière l'hébergeur (mode hébergé), celle que transmet son proxy */
export function clientAddress(req, trustProxy = false) {
  const fwd = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return String(req.headers['cf-connecting-ip'] || fwd || req.socket.remoteAddress || '?');
}

/** Taille totale d'un dossier (octets) */
export function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let list = [];
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const x of list) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) walk(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch {}
      }
    }
  };
  walk(dir);
  return total;
}

/** Limiteur simple : au plus `max` évènements par fenêtre glissante, par clé */
export class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  hit(key) {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 5000) this.hits.clear();
    return list.length <= this.max;
  }
}

/** Adresses IPv4 privées de cet ordinateur (Wi-Fi, Ethernet…) */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      const priv = x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127);
      if (priv && !out.includes(a.address)) out.push(a.address);
    }
  }
  return out;
}

export function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2);
  return s.toUpperCase();
}
