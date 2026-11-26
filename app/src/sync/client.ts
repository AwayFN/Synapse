import type { Activity, Entity, Link } from '../types';
import { TYPE_LABEL } from '../types';
import { displayTitle, normalizeEntities, setDataReadOnly, useData } from '../store/data';
import { useUI } from '../store/ui';
import { layout } from '../scene/layout';
import { applyRemote, applySnapshot, allowed, compact, diff, isApplyingRemote, type Op } from './ops';
import { initialsOf, useSession, type Announcement, type Member, type Mode, type Presence, type Role, type ShareStatus } from './session';
import { android } from './native';
import { apiBase, apiUrl, keepToken, requestInit, setApiBase, setSessionToken, standalone } from './remote';
import { findCentral } from './central';
import { brainReady, forgetBrain, forgetEverything } from './offline';

/**
 * Connexion en direct avec le serveur du cerveau ouvert (le Synapse central).
 * Dans l'application Android (V7), le cerveau vit aussi sur le téléphone (offline.ts) : sans réseau on continue, et
 * tout se synchronise dès que le Synapse central répond (son adresse est retrouvée toute seule si elle a changé).
 *   - réception : un flux d'évènements (état complet au branchement, puis changements, présence…).
 *     D'abord un flux continu (Server-Sent Events) ; si rien n'arrive (certains intermédiaires, comme les
 *     adresses gratuites trycloudflare.com, le retiennent), des requêtes « en attente » prennent le relais.
 *   - envoi : les modifications locales partent par petits lots ; ce qui n'a pas pu partir attend la reconnexion,
 *     gardé aussi sur l'appareil : rien n'est perdu, même si l'application se ferme pendant une coupure.
 *   - réseau qui change (Wi-Fi ↔ câble ↔ 4G), mise en veille : le serveur envoie un signe de vie toutes les 15 s ;
 *     sans nouvelles pendant 45 s, ou dès que l'appareil retrouve un réseau, la connexion repart toute seule
 *     (en une seconde ou deux), sans se déconnecter ni relancer l'application.
 */
export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, data: unknown) {
    super(`api ${status}`);
    this.status = status;
    this.data = data;
  }
}

/** Cerveau ouvert : chaque requête le précise (un compte peut en avoir rejoint plusieurs) */
let brainId: string | null = null;
export function setBrain(id: string | null) {
  brainId = id;
}
const withBrain = (path: string) => (brainId ? `${path}${path.includes('?') ? '&' : '?'}b=${encodeURIComponent(brainId)}` : path);

/** Une requête qui ne répond pas (connexion morte après un changement de réseau) est abandonnée, puis refaite */
export async function api<T = Record<string, unknown>>(path: string, body?: unknown, timeoutMs = 20000): Promise<T> {
  // application Android sans Synapse central connu (jamais trouvé) : comme une coupure réseau
  if (standalone() && !apiBase()) throw new TypeError('Synapse central introuvable');
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  let r: Response;
  try {
    const init = requestInit({ 'X-Synapse': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) });
    r = await fetch(apiUrl(withBrain(path)), {
      method: body === undefined ? 'GET' : 'POST',
      ...init,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } finally {
    window.clearTimeout(timer);
  }
  let data: unknown = null;
  try {
    data = await r.json();
  } catch {
    /* pas de JSON */
  }
  if (!r.ok) throw new ApiError(r.status, data);
  // application Android : le jeton de session d'une connexion (ou d'un compte créé) est gardé sur le téléphone
  keepToken(data);
  return data as T;
}

/** Un identifiant par onglet (garde le même après un rechargement) */
const clientId = (() => {
  try {
    const k = 'synapse-client-id';
    let id = sessionStorage.getItem(k);
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
      sessionStorage.setItem(k, id);
    }
    return id;
  } catch {
    return Math.random().toString(36).slice(2, 14);
  }
})();

interface Snapshot {
  seq: number;
  entities: Record<string, Entity>;
  links: Link[];
  activity: Activity[];
  layout: Record<string, [number, number, number]>;
  clientId: string;
  brainId?: string;
  me: { id: string; name: string; initials: string };
  role: Role;
  members: Member[];
  brain: { id?: string; name: string; ownerName: string };
  presence: Presence[];
}

// ───────────────────────── transport
type Transport = 'sse' | 'poll';
const TRANSPORT_KEY = 'synapse-transport';
function preferredTransport(): Transport {
  // l'application Android se présente avec son jeton (un en-tête que le flux continu ne sait pas envoyer)
  if (standalone()) return 'poll';
  // les adresses gratuites de Cloudflare retiennent le flux continu : inutile d'essayer
  if (/\.trycloudflare\.com$/i.test(location.hostname)) return 'poll';
  try {
    return sessionStorage.getItem(TRANSPORT_KEY) === 'poll' ? 'poll' : 'sse';
  } catch {
    return 'sse';
  }
}
let transport: Transport = 'sse';
/** chaque (re)connexion a son numéro : une boucle d'une ancienne connexion s'arrête d'elle-même */
let generation = 0;
let es: EventSource | null = null;
let sseWatchdog: number | undefined;
let pollAbort: AbortController | null = null;
/** dernier signe du serveur (évènement, signe de vie, réponse d'une requête en attente) */
let lastEventAt = Date.now();
/** sans nouvelles du serveur depuis ce délai, la connexion est considérée comme morte */
const STALE_MS = 45_000;

let outbox: Op[] = [];
/** le lot en cours d'envoi (pas encore confirmé par le serveur) */
let inflight: Op[] = [];
let sending = false;
let flushTimer: number | undefined;
let reconnectTimer: number | undefined;
let backoff = 500;
let firstReset: ((ok: boolean) => void) | null = null;
const unsubscribers: (() => void)[] = [];
let started = false;
let remoteToastAt = 0;
let offlineSince = 0;
let unreachableSaid = false;

const S = () => useSession.getState();
const toast = (text: string, color = '#00e5ff', action?: { label: string; run: () => void }) => useUI.getState().toast({ text, color, action });

function membersMap(list: Member[]) {
  const m: Record<string, Member> = {};
  for (const x of list) m[x.id] = { ...x, initials: x.initials || initialsOf(x.name) };
  return m;
}

function setMode(mode: Mode) {
  if (S().mode === mode) return;
  if (mode === 'offline' && !offlineSince) offlineSince = Date.now();
  if (mode === 'online') {
    offlineSince = 0;
    unreachableSaid = false;
  }
  useSession.setState({ mode });
}

// ───────────────────────── ce qui attend (gardé sur l'appareil pendant une coupure)
const OUTBOX_PREFIX = 'synapse-attente-';
let persistTimer: number | undefined;
/** Pour un compte (pas un invité sans compte : rien de son passage ne reste sur son appareil) */
const canPersist = () => !!S().account && !!brainId;

function persistOutbox(now = false) {
  if (!canPersist()) return;
  const write = () => {
    persistTimer = undefined;
    const pending = [...inflight, ...outbox];
    try {
      if (pending.length) localStorage.setItem(OUTBOX_PREFIX + brainId, JSON.stringify(pending.slice(-2000)));
      else localStorage.removeItem(OUTBOX_PREFIX + brainId);
    } catch {
      /* stockage plein : tant pis, elles partiront si la page reste ouverte */
    }
  };
  if (now) {
    window.clearTimeout(persistTimer);
    write();
  } else if (persistTimer === undefined) persistTimer = window.setTimeout(write, 300);
}

function restoreOutbox() {
  if (!canPersist()) return;
  try {
    const raw = localStorage.getItem(OUTBOX_PREFIX + brainId);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (Array.isArray(saved) && saved.length) outbox = [...saved, ...outbox];
  } catch {
    /* illisible : ignoré */
  }
}

let deniedAt = 0;
function onReset(snap: Snapshot) {
  backoff = 500;
  lastEventAt = Date.now();
  const isOwner = snap.role === 'owner';
  // « peut regarder » : rien ne se modifie chez lui, et un petit mot le lui rappelle
  setDataReadOnly(snap.role === 'lecture', () => {
    if (Date.now() - deniedAt < 4000) return;
    deniedAt = Date.now();
    toast('TU PEUX SEULEMENT REGARDER CE CERVEAU', '#00e5ff');
  });
  // positions 3D : un invité reprend la carte du propriétaire ; le propriétaire complète la sienne
  layout.useSavedPositions(snap.layout || {}, isOwner ? 'merge' : 'replace');
  applySnapshot({ ...snap, entities: normalizeEntities(snap.entities) });
  // ce qui n'est pas encore arrivé au serveur reste visible ici (il partira juste après)
  const pending = [...inflight, ...outbox];
  if (pending.length && snap.role !== 'lecture') applyRemote(pending, { fx: false });
  useSession.setState({
    role: snap.role,
    me: { ...snap.me, initials: snap.me.initials || initialsOf(snap.me.name) },
    members: membersMap(snap.members),
    online: snap.presence || [],
    ownerName: snap.brain.ownerName,
    brainName: snap.brain.name,
  });
  setMode('online');
  // application Android : la copie du cerveau sur le téléphone est à jour (pour s'ouvrir même sans réseau)
  if (standalone()) brainReady();
  seenOnline = new Set((snap.presence || []).map((p) => p.id));
  if (firstReset) {
    firstReset(true);
    firstReset = null;
  }
  sendPresence(true);
  if (outbox.length) void flush();
}

function onBatch(b: { seq: number; by: string; clientId: string | null; ops: Op[] }) {
  if (b.clientId === clientId) return; // mon propre écho : déjà appliqué chez moi
  applyRemote(
    b.ops.map((o) => (o.t === 'put' ? { ...o, e: normalizeEntities({ [o.e.id]: o.e })[o.e.id] } : o)),
    { fx: true },
  );
  // un élément créé par quelqu'un d'autre : discrète notification
  if (b.by !== S().me.id) {
    const puts = b.ops.filter((o): o is Extract<Op, { t: 'put' }> => o.t === 'put');
    const now = Date.now();
    if (puts.length && now - remoteToastAt > 3500) {
      remoteToastAt = now;
      const e = puts[0].e;
      const who = b.by === 'owner' ? S().ownerName : S().members[b.by]?.name || 'Quelqu’un';
      toast(`${who.toUpperCase()} · ${TYPE_LABEL[e.type].toUpperCase()} · ${displayTitle(e)}${puts.length > 1 ? ` · +${puts.length - 1}` : ''}`, e.color, {
        label: 'VOIR',
        run: () => useUI.getState().openEntity(e.id),
      });
    }
  }
}

/** Qui était déjà là : pour annoncer les arrivées (« Léa est là ») */
let seenOnline = new Set<string>();

function onPresence(p: { online: Presence[] }) {
  useSession.setState({ online: p.online });
  const me = S().me.id;
  const now = new Set(p.online.map((x) => x.id));
  for (const x of p.online) {
    if (x.id !== me && !seenOnline.has(x.id)) toast(`${x.name.toUpperCase()} EST LÀ · ${x.role === 'lecture' ? 'REGARDE' : x.role === 'owner' ? 'PROPRIÉTAIRE' : 'PEUT MODIFIER'}`, '#39ff88');
  }
  seenOnline = now;
  // suivre quelqu'un : la caméra va où il regarde
  const f = S().following;
  if (!f) return;
  const who = p.online.find((x) => x.id === f);
  if (!who) {
    useSession.setState({ following: null });
    return;
  }
  const ui = useUI.getState();
  if (who.focus && who.focus !== ui.selectedId && who.focus !== ui.editorId && useData.getState().entities[who.focus]) ui.openEntity(who.focus);
}

const BYE_MODE: Record<string, Mode> = {
  revoked: 'revoked',
  left: 'revoked',
  suspended: 'suspended',
  deleted: 'deleted',
  logout: 'loggedout',
  maintenance: 'maintenance',
};

function onBye(d: { reason: string }) {
  stopTransport();
  // nouveau rôle sur le serveur (nommé admin, par exemple) : on recharge pour l'afficher
  if (d.reason === 'reload') {
    void flush().finally(() => location.reload());
    return;
  }
  const mode = BYE_MODE[d.reason] ?? 'closed';
  // le propriétaire ne « perd » jamais son propre cerveau : seulement une reconnexion
  setMode(S().role === 'owner' && mode === 'revoked' ? 'closed' : mode);
  if (standalone()) {
    // application Android : un cerveau qu'on ne peut plus voir (ou un compte supprimé) quitte le téléphone
    if (mode === 'revoked' && S().role !== 'owner') {
      outbox = [];
      forgetBrain(brainId);
    } else if (mode === 'deleted') {
      outbox = [];
      forgetEverything();
      setSessionToken(null);
    }
  }
  if (mode === 'closed' || mode === 'maintenance') scheduleReconnect(mode === 'maintenance' ? 20000 : 3000);
}

function dispatch(type: string, data: unknown) {
  lastEventAt = Date.now();
  try {
    switch (type) {
      case 'ping':
        return;
      case 'reset':
        return onReset(data as Snapshot);
      case 'batch':
        return onBatch(data as never);
      case 'presence':
        return onPresence(data as never);
      case 'members':
        return useSession.setState({ members: membersMap((data as { members: Member[] }).members) });
      case 'share': {
        const d = data as ShareStatus;
        // quelqu'un vient de rejoindre mon cerveau
        const before = S().share;
        if (before) {
          const known = new Set(before.members.map((m) => m.id));
          for (const m of d.members) if (!known.has(m.id)) toast(`${m.name.toUpperCase()} A REJOINT TON CERVEAU`, '#39ff88', { label: 'VOIR', run: () => useSession.setState({ shareOpen: true }) });
        }
        return useSession.setState({ share: d, ownerName: d.ownerName, brainName: d.brainName });
      }
      case 'brain': {
        const d = data as { name: string; ownerName: string };
        useSession.setState((s) => ({
          brainName: d.name,
          ownerName: d.ownerName,
          brains: s.brains.map((b) => (b.id === s.brainId ? { ...b, name: d.name, ownerName: d.ownerName } : b)),
        }));
        return;
      }
      case 'announce':
        return useSession.setState({ announcement: (data as Announcement | null) ?? null });
      case 'staff': {
        const d = data as { feedback: number; errors: number; accounts: number };
        const before = S().staff;
        if (before && d.accounts > before.accounts) toast('NOUVEAU COMPTE SUR TON SYNAPSE', '#39ff88', { label: 'VOIR', run: () => useSession.setState({ adminOpen: true }) });
        return useSession.setState({ staff: d });
      }
      case 'bye':
        return onBye(data as { reason: string });
    }
  } catch (e) {
    console.error('synapse sync', type, e);
  }
}

function stopTransport() {
  generation++;
  window.clearTimeout(sseWatchdog);
  if (es) {
    es.close();
    es = null;
  }
  if (pollAbort) {
    pollAbort.abort();
    pollAbort = null;
  }
}

function lostConnection() {
  stopTransport();
  if (S().mode === 'online' || S().mode === 'connecting') setMode('offline');
  if (firstReset) {
    firstReset(false);
    firstReset = null;
  }
  scheduleReconnect();
}

function connect() {
  stopTransport();
  lastEventAt = Date.now();
  transport = preferredTransport();
  if (transport === 'poll') return void pollLoop(generation, true);
  const gen = generation;
  const source = new EventSource(withBrain(`/api/events?c=${encodeURIComponent(clientId)}`));
  es = source;
  let gotReset = false;
  for (const type of ['reset', 'batch', 'presence', 'members', 'share', 'brain', 'announce', 'staff', 'bye', 'ping']) {
    source.addEventListener(type, (ev) => {
      if (gen !== generation) return;
      if (type === 'reset') gotReset = true;
      let data: unknown = null;
      try {
        data = JSON.parse((ev as MessageEvent).data);
      } catch {
        return;
      }
      dispatch(type, data);
    });
  }
  // rien en 6 s : un intermédiaire retient le flux → requêtes en attente
  sseWatchdog = window.setTimeout(() => {
    if (gen !== generation || gotReset) return;
    try {
      sessionStorage.setItem(TRANSPORT_KEY, 'poll');
    } catch {
      /* pas grave */
    }
    connect();
  }, 6000);
  source.onerror = () => {
    // le navigateur réessaierait tout seul, mais on veut d'abord renvoyer ce qui attend
    if (gen !== generation) return;
    lostConnection();
  };
}

/** Requêtes « en attente » : chacune revient dès qu'il y a du nouveau (ou vide au bout de 25 s) */
async function pollLoop(gen: number, init: boolean) {
  let refused = 0;
  while (gen === generation) {
    let r: Response;
    const ctrl = new AbortController();
    pollAbort = ctrl;
    // une requête qui dépasse 40 s : la connexion est morte (changement de réseau), on la refait
    const timer = window.setTimeout(() => ctrl.abort(), 40_000);
    try {
      if (standalone() && !apiBase()) throw new TypeError('Synapse central introuvable');
      r = await fetch(apiUrl(withBrain(`/api/poll?c=${encodeURIComponent(clientId)}${init ? '&init=1' : ''}`)), { ...requestInit(), cache: 'no-store', signal: ctrl.signal });
    } catch {
      window.clearTimeout(timer);
      if (gen === generation) lostConnection();
      return;
    }
    window.clearTimeout(timer);
    if (gen !== generation) return;
    lastEventAt = Date.now();
    if (r.status === 409) {
      // le serveur ne connaît plus cette fenêtre (redémarrage) : on repart d'un état complet.
      // Refusé encore et encore (cerveau pas encore créé) : on n'insiste pas, nouvel essai plus tard
      if (++refused > 3) {
        lostConnection();
        return;
      }
      init = true;
      continue;
    }
    refused = 0;
    if (r.status === 401 || r.status === 403 || r.status === 503) {
      onBye({ reason: r.status === 503 ? 'maintenance' : 'revoked' });
      return;
    }
    if (!r.ok) {
      lostConnection();
      return;
    }
    let body: { events: { e: string; d: unknown }[]; overflow?: boolean };
    try {
      body = await r.json();
    } catch {
      lostConnection();
      return;
    }
    init = !!body.overflow;
    for (const ev of body.events || []) {
      if (gen !== generation) return;
      dispatch(ev.e, ev.d);
    }
  }
}

/** Le serveur ne répond plus depuis 20 s : l'application Android vérifie s'il a changé d'adresse */
function maybeUnreachable() {
  if (standalone()) return relocate();
  if (unreachableSaid || !offlineSince || Date.now() - offlineSince < 20_000) return;
  unreachableSaid = true;
  try {
    android()?.unreachable?.();
  } catch {
    /* pas dans l'application (V6) */
  }
}

let relocating = false;
let lastRelocate = 0;
/**
 * Application Android : le Synapse central ne répond plus à son adresse. Il en a peut-être changé (adresse gratuite,
 * nouvelle à chaque redémarrage sur le PC du créateur) : on cherche la nouvelle (GitHub), au plus toutes les 30 s.
 */
function relocate(force = false) {
  if (!standalone() || relocating) return;
  const wait = apiBase() ? 30_000 : 10_000;
  if (!force && (Date.now() - lastRelocate < wait || (apiBase() && Date.now() - offlineSince < 8000))) return;
  relocating = true;
  lastRelocate = Date.now();
  void findCentral()
    .then((url) => {
      if (url && url !== apiBase()) {
        setApiBase(url);
        reconnectNow('nouvelle adresse du Synapse central');
      } else if (url && force) reconnectNow('nouvel essai');
    })
    .finally(() => {
      relocating = false;
    });
}

/** « Réessayer maintenant » (application Android hors ligne) : on cherche le Synapse central tout de suite */
export function retrySync() {
  if (standalone()) relocate(true);
  reconnectNow('nouvel essai demandé');
}

function scheduleReconnect(delay = backoff) {
  if (reconnectTimer !== undefined) return;
  reconnectTimer = window.setTimeout(async () => {
    reconnectTimer = undefined;
    backoff = Math.min(8000, Math.round(backoff * 1.6));
    // application Android sans adresse connue pour le Synapse central : on la cherche d'abord
    if (standalone() && !apiBase()) {
      relocate();
      return scheduleReconnect();
    }
    try {
      const hello = await api<{ auth: string; account: unknown; suspended?: boolean; server?: { maintenance: string | null } }>('/api/hello', undefined, 12000);
      if (hello.suspended) return setMode('suspended');
      if (hello.server?.maintenance != null && hello.auth === 'none') {
        setMode('maintenance');
        return scheduleReconnect(20000);
      }
      if (hello.auth === 'none') {
        setMode(S().account && !hello.account ? 'loggedout' : 'revoked');
        return;
      }
      await flush();
      connect();
    } catch {
      maybeUnreachable();
      scheduleReconnect();
    }
  }, delay);
}

/**
 * Le réseau vient de changer (ou l'appareil revient de veille) : on n'attend pas, on se rebranche tout de suite.
 * Rien n'est perdu : ce qui attend part juste avant.
 */
export function reconnectNow(reason = '') {
  if (!started) return;
  const m = S().mode;
  if (m !== 'online' && m !== 'offline' && m !== 'closed' && m !== 'connecting') return;
  void reason;
  window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  backoff = 500;
  stopTransport();
  if (m === 'online') setMode('offline');
  scheduleReconnect(150);
}

// ───────────────────────── envoi
function queue(ops: Op[]) {
  if (!ops.length) return;
  outbox.push(...ops);
  persistOutbox();
  if (flushTimer === undefined) flushTimer = window.setTimeout(() => void flush(), 120);
}

async function flush(): Promise<void> {
  if (flushTimer !== undefined) {
    window.clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (sending || !outbox.length) return;
  const batch = compact(outbox.splice(0, 400));
  inflight = batch;
  sending = true;
  try {
    const r = await api<{ seq: number; rejected: { i: number; reason: string }[]; fixes: Op[] }>('/api/ops', { clientId, ops: batch });
    inflight = [];
    if (r.fixes?.length) applyRemote(r.fixes, { fx: false });
    if (r.rejected?.some((x) => x.reason === 'forbidden')) toast('TU PEUX SEULEMENT REGARDER CE CERVEAU : MODIFICATION ANNULÉE', '#ff4d6d');
    if (r.rejected?.some((x) => x.reason === 'locked')) toast('QUELQU’UN ÉCRIT DÉJÀ ICI : ATTENDS QU’IL AIT FINI', '#ffb020');
    if (r.rejected?.some((x) => x.reason === 'limit')) toast('LIMITE D’ÉLÉMENTS ATTEINTE SUR CE SERVEUR', '#ff4d6d');
  } catch (e) {
    inflight = [];
    const status = e instanceof ApiError ? e.status : 0;
    if (status === 401 || status === 403) {
      outbox = [];
      if (status === 401) setMode('revoked');
    } else if (status === 503) {
      outbox.unshift(...batch);
      setMode('maintenance');
      scheduleReconnect(20000);
    } else if (status === 400 || status === 413) {
      // lot refusé tel quel (trop gros, illisible) : on ne le renvoie pas en boucle
      toast('UNE MODIFICATION N’A PAS PU ÊTRE ENREGISTRÉE', '#ff4d6d');
    } else {
      // pas de réseau (ou connexion morte) : on réessaiera à la reconnexion
      outbox.unshift(...batch);
      if (S().mode === 'online') {
        setMode('offline');
        stopTransport();
      }
      scheduleReconnect();
    }
  } finally {
    sending = false;
    persistOutbox();
  }
  if (outbox.length && S().mode === 'online') flushTimer = window.setTimeout(() => void flush(), 200);
}

// ───────────────────────── présence
let presenceTimer: number | undefined;
let lastPresence = '';
export function sendPresence(force = false) {
  if (S().mode !== 'online') return;
  if (presenceTimer !== undefined && !force) return;
  const go = () => {
    presenceTimer = undefined;
    const ui = useUI.getState();
    const p = { clientId, view: ui.view, focus: ui.editorId ?? ui.selectedId, editing: S().editing };
    const key = JSON.stringify(p);
    if (key === lastPresence && !force) return;
    lastPresence = key;
    api('/api/presence', p).catch(() => {});
  };
  if (force) {
    if (presenceTimer !== undefined) window.clearTimeout(presenceTimer);
    go();
  } else presenceTimer = window.setTimeout(go, 120);
}

// ───────────────────────── positions 3D (le propriétaire les partage)
let lastLayout = '';
function uploadLayout() {
  if (S().mode !== 'online' || S().role !== 'owner') return;
  const positions = layout.positions();
  const key = JSON.stringify(positions);
  if (key === lastLayout || key === '{}') return;
  lastLayout = key;
  api('/api/layout', { positions }).catch(() => {
    lastLayout = '';
  });
}

/**
 * Démarre la synchronisation : se branche, attend l'état complet, puis écoute les modifications locales.
 * Renvoie false si le serveur n'a pas répondu à temps (l'application continue en mode hors ligne).
 */
export function startSync(): Promise<boolean> {
  if (started) return Promise.resolve(true);
  started = true;
  useSession.setState({ mode: 'connecting' });
  // des modifications faites pendant une coupure, puis l'application fermée : elles partent maintenant
  restoreOutbox();
  const ready = new Promise<boolean>((resolve) => {
    firstReset = resolve;
    window.setTimeout(() => {
      if (firstReset) {
        firstReset(false);
        firstReset = null;
      }
    }, 20000);
  });
  connect();
  // toute modification locale (création, édition, lien…) devient une opération envoyée au serveur
  unsubscribers.push(
    useData.subscribe((next, prev) => {
      if (isApplyingRemote()) return;
      const mode = S().mode;
      if (mode !== 'online' && mode !== 'offline' && mode !== 'connecting' && mode !== 'closed') return;
      queue(allowed(diff(prev, next)));
    }),
  );
  unsubscribers.push(
    useUI.subscribe((s, p) => {
      if (s.selectedId !== p.selectedId || s.editorId !== p.editorId || s.view !== p.view) sendPresence();
    }),
  );
  unsubscribers.push(
    useSession.subscribe((s, p) => {
      if (s.editing !== p.editing) sendPresence(true);
    }),
  );
  const hb = window.setInterval(() => sendPresence(true), 25000);
  const lay = window.setInterval(uploadLayout, 15000);
  // connexion silencieusement morte (aucun signe de vie du serveur depuis 45 s) : on se rebranche
  const watch = window.setInterval(() => {
    if (S().mode === 'online' && Date.now() - lastEventAt > STALE_MS) lostConnection();
    if (S().mode === 'offline' || (standalone() && S().mode === 'closed')) maybeUnreachable();
  }, 5000);
  unsubscribers.push(
    () => window.clearInterval(hb),
    () => window.clearInterval(lay),
    () => window.clearInterval(watch),
  );
  // le réseau revient ou change (Wi-Fi ↔ câble ↔ 4G) : reconnexion immédiate
  window.addEventListener('online', () => reconnectNow('réseau'));
  window.addEventListener('offline', () => {
    if (S().mode === 'online') {
      stopTransport();
      setMode('offline');
      scheduleReconnect(1000);
    }
  });
  // retour au premier plan (téléphone sorti de veille, onglet revenu) : si la connexion a vieilli, on la refait
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      persistOutbox(true);
      return;
    }
    const m = S().mode;
    if (m === 'offline' || m === 'closed') reconnectNow('retour');
    else if (m === 'online' && Date.now() - lastEventAt > 30_000) reconnectNow('retour après une pause');
  });
  // l'application Android prévient quand le réseau du téléphone change, ou qu'elle revient au premier plan
  const w = window as unknown as { __synapseNetwork?: (on: boolean) => void; __synapseResume?: () => void };
  w.__synapseNetwork = (on: boolean) => {
    if (on) reconnectNow('réseau du téléphone');
    else if (S().mode === 'online') {
      stopTransport();
      setMode('offline');
      scheduleReconnect(1500);
    }
  };
  w.__synapseResume = () => {
    const m = S().mode;
    if (m === 'offline' || m === 'closed' || Date.now() - lastEventAt > 30_000) reconnectNow('application rouverte');
  };
  window.addEventListener('pagehide', () => {
    persistOutbox(true);
    void flush();
  });
  return ready;
}

export function pendingChanges() {
  return outbox.length + inflight.length;
}

/** Recharge l'état complet (après un import, par exemple) */
export function resync() {
  if (S().mode === 'local') return;
  connect();
}

/** Ce qui n'a pas encore pu partir, et la prochaine tentative (application Android : état de la synchronisation) */
export function syncInfo() {
  return { pending: outbox.length + inflight.length, offlineSince, server: apiBase() };
}

/** Ouvre un autre cerveau (le sien, ou un cerveau rejoint) : on envoie d'abord ce qui attend */
export async function openBrain(id: string, mine: boolean) {
  await flush().catch(() => {});
  location.assign(mine ? '/' : `/?cerveau=${encodeURIComponent(id)}`);
}

export { clientId };
