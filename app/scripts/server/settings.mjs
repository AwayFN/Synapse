// Réglages du serveur, choisis dans l'espace créateur (fichier serveur.json).
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './util.mjs';

export const REGISTRATION = ['ouverte', 'invitation', 'fermee'];

/** Texte montré à l'inscription ; {createur} est remplacé par le nom du créateur */
export const DEFAULT_TERMS = `Synapse est proposé par {createur}, à titre personnel et gratuit.

• Ce que tu écris reste à toi. Ton cerveau est enregistré sur le serveur de Synapse, avec une sauvegarde par jour.
• L'espace créateur de Synapse ne montre que des chiffres (nombre de neurones, dates d'inscription et de connexion, vues utilisées, erreurs techniques), jamais ce que tu écris.
• Ce qui est conservé à ton sujet : ton nom, ton adresse e-mail, une empreinte de ton mot de passe (jamais le mot de passe lui-même), tes dates d'inscription et de connexion.
• Tu peux exporter toutes tes données à tout moment (Ctrl K, puis « Exporter mes données ») et supprimer ton compte depuis le menu de ton compte : tout est alors effacé sous 30 jours.
• Pas de publicité, pas de revente de données, pas de traceur.
• Service en test : il peut s'interrompre. Garde des exports de ce qui compte pour toi.
• Pour toute question sur tes données, écris à {createur}.`;

const DEFAULTS = {
  v: 4,
  appName: 'Synapse',
  registration: 'invitation',
  brainInvitesAllowSignup: true,
  membersCanInvite: true,
  memberInviteQuota: 5,
  maxAccounts: 0,
  maxNeurons: 0,
  maintenance: { on: false, message: '' },
  announcement: { id: '', text: '', level: 'info', at: 0 },
  terms: DEFAULT_TERMS,
  termsAt: 0,
  publicUrl: '',
  tunnelToken: '',
  share: { lan: false, internet: false },
  legacyBrain: '',
  /** adresse Internet gratuite actuelle, et la précédente (elle change à chaque redémarrage) */
  netUrl: '',
  netUrlPrev: '',
  netUrlAt: 0,
};

const int = (v, min, max, d) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
};
const text = (v, max) =>
  String(v ?? '')
    .replace(/\u0000/g, '')
    .slice(0, max);

/** Adresse publique (https://…) : seulement l'origine, sans chemin */
export function cleanUrl(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

export class Settings {
  constructor(dir, log = () => {}) {
    this.file = path.join(dir, 'serveur.json');
    this.log = log;
    const d = readJsonFile(this.file) || {};
    this.d = {
      ...structuredClone(DEFAULTS),
      ...d,
      maintenance: { ...DEFAULTS.maintenance, ...(d.maintenance || {}) },
      announcement: { ...DEFAULTS.announcement, ...(d.announcement || {}) },
      share: { ...DEFAULTS.share, ...(d.share || {}) },
    };
    if (!REGISTRATION.includes(this.d.registration)) this.d.registration = 'invitation';
    this.timer = null;
  }
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 300);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      writeJsonAtomic(this.file, JSON.stringify(this.d, null, 1));
    } catch (e) {
      this.log(`serveur.json: ${e.message}`);
    }
  }

  /** Ce que l'espace créateur affiche (le jeton du tunnel ne repart jamais vers un navigateur) */
  public() {
    const { tunnelToken, share, legacyBrain, v, netUrl, netUrlPrev, netUrlAt, ...rest } = this.d;
    return { ...rest, tunnelTokenSet: !!tunnelToken, defaultTerms: DEFAULT_TERMS };
  }

  /** Applique les champs reconnus ; renvoie la liste des réglages changés */
  set(p) {
    const d = this.d;
    const changed = [];
    const put = (k, v) => {
      if (JSON.stringify(d[k]) !== JSON.stringify(v)) {
        d[k] = v;
        changed.push(k);
      }
    };
    if (p.appName !== undefined) put('appName', text(p.appName, 40).trim() || 'Synapse');
    if (p.registration !== undefined && REGISTRATION.includes(p.registration)) put('registration', p.registration);
    if (p.brainInvitesAllowSignup !== undefined) put('brainInvitesAllowSignup', !!p.brainInvitesAllowSignup);
    if (p.membersCanInvite !== undefined) put('membersCanInvite', !!p.membersCanInvite);
    if (p.memberInviteQuota !== undefined) put('memberInviteQuota', int(p.memberInviteQuota, 0, 100, 5));
    if (p.maxAccounts !== undefined) put('maxAccounts', int(p.maxAccounts, 0, 100000, 0));
    if (p.maxNeurons !== undefined) put('maxNeurons', int(p.maxNeurons, 0, 1000000, 0));
    if (p.terms !== undefined) {
      const before = d.terms;
      put('terms', text(p.terms, 8000));
      if (before !== d.terms) d.termsAt = Date.now();
    }
    if (p.publicUrl !== undefined) put('publicUrl', cleanUrl(p.publicUrl));
    if (p.tunnelToken !== undefined) put('tunnelToken', text(p.tunnelToken, 2000).trim());
    if (p.maintenance !== undefined) put('maintenance', { on: !!p.maintenance.on, message: text(p.maintenance.message, 300).trim() });
    if (p.announcement !== undefined) put('announcement', p.announcement);
    if (p.share !== undefined) put('share', { ...d.share, ...p.share });
    if (p.legacyBrain !== undefined) put('legacyBrain', String(p.legacyBrain));
    if (p.netUrl !== undefined) put('netUrl', cleanUrl(p.netUrl));
    if (p.netUrlPrev !== undefined) put('netUrlPrev', cleanUrl(p.netUrlPrev));
    if (p.netUrlAt !== undefined) put('netUrlAt', int(p.netUrlAt, 0, 8.64e15, 0));
    if (changed.length) this.save();
    return changed;
  }
}
