import type { Activity, Entity, Link } from '../types';
import { TYPE_LABEL } from '../types';
import { displayTitle, setDataReadOnly, useData } from '../store/data';
import { useUI } from '../store/ui';
import { layout } from '../scene/layout';
import { applyRemote, applySnapshot, allowed, compact, diff, isApplyingRemote, type Op } from './ops';
import { initialsOf, useSession, type Announcement, type Member, type Mode, type Presence, type Role, type ShareStatus } from './session';

/**
 * Connexion en direct avec le serveur du cerveau ouvert.
 *   - réception : un flux d'évènements (état complet au branchement, puis changements, présence…).
 *     D'abord un flux continu (Server-Sent Events) ; si rien n'arrive (certains intermédiaires, comme les
 *     adresses gratuites trycloudflare.com, le retiennent), des requêtes « en attente » prennent le relais.
 *   - envoi : les modifications locales partent par petits lots ; ce qui n'a pas pu partir attend
 *     la reconnexion (rien n'est perdu si la connexion saute quelques secondes)
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

export async function api<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(withBrain(path), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Synapse': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
    cache: 'no-store',
  });
  let data: unknown = null;
  try {
    data = await r.json();
  } catch {
    /* pas de JSON */
  }
  if (!r.ok) throw new ApiError(r.status, data);
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

let outbox: Op[] = [];
let sending = false;
let flushTimer: number | undefined;
let reconnectTimer: number | undefined;
let backoff = 1000;
let firstReset: ((ok: boolean) => void) | null = null;
const unsubscribers: (() => void)[] = [];
let started = false;
let remoteToastAt = 0;

const S = () => useSession.getState();
const toast = (text: string, color = '#00e5ff', action?: { label: string; run: () => void }) => useUI.getState().toast({ text, color, action });

function membersMap(list: Member[]) {
  const m: Record<string, Member> = {};
  for (const x of list) m[x.id] = { ...x, initials: x.initials || initialsOf(x.name) };
  return m;
}

let deniedAt = 0;
function onReset(snap: Snapshot) {
  backoff = 1000;
  const isOwner = snap.role === 'owner';
  // « peut regarder » : rien ne se modifie chez lui, et un petit mot le lui rappelle
  setDataReadOnly(snap.role === 'lecture', () => {
    if (Date.now() - deniedAt < 4000) return;
    deniedAt = Date.now();
    toast('TU PEUX SEULEMENT REGARDER CE CERVEAU', '#00e5ff');
  });
  // positions 3D : un invité reprend la carte du propriétaire ; le propriétaire complète la sienne
  layout.useSavedPositions(snap.layout || {}, isOwner ? 'merge' : 'replace');
  applySnapshot(snap);
  useSession.setState({
    mode: 'online',
    role: snap.role,
    me: { ...snap.me, initials: snap.me.initials || initialsOf(snap.me.name) },
    members: membersMap(snap.members),
    online: snap.presence || [],
    ownerName: snap.brain.ownerName,
    brainName: snap.brain.name,
  });
  seenOnline = new Set((snap.presence || []).map((p) => p.id));
  if (firstReset) {
    firstReset(true);
    firstReset = null;
  }
  sendPresence(true);
}

function onBatch(b: { seq: number; by: string; clientId: string | null; ops: Op[] }) {
  if (b.clientId === clientId) return; // mon propre écho : déjà appliqué chez moi
  applyRemote(b.ops, { fx: true });
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
  useSession.setState({ mode: S().role === 'owner' && mode === 'revoked' ? 'closed' : mode });
  if (mode === 'closed' || mode === 'maintenance') scheduleReconnect(mode === 'maintenance' ? 20000 : 5000);
}

function dispatch(type: string, data: unknown) {
  try {
    switch (type) {
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
}

function lostConnection() {
  stopTransport();
  if (S().mode === 'online' || S().mode === 'connecting') useSession.setState({ mode: 'offline' });
  if (firstReset) {
    firstReset(false);
    firstReset = null;
  }
  scheduleReconnect();
}

function connect() {
  stopTransport();
  transport = preferredTransport();
  if (transport === 'poll') return void pollLoop(generation, true);
  const gen = generation;
  const source = new EventSource(withBrain(`/api/events?c=${encodeURIComponent(clientId)}`));
  es = source;
  let gotReset = false;
  for (const type of ['reset', 'batch', 'presence', 'members', 'share', 'brain', 'announce', 'staff', 'bye']) {
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
  while (gen === generation) {
    let r: Response;
    try {
      r = await fetch(withBrain(`/api/poll?c=${encodeURIComponent(clientId)}${init ? '&init=1' : ''}`), { credentials: 'same-origin', cache: 'no-store' });
    } catch {
      if (gen === generation) lostConnection();
      return;
    }
    if (gen !== generation) return;
    if (r.status === 409) {
      // le serveur ne connaît plus cette fenêtre (redémarrage) : on repart d'un état complet
      init = true;
      continue;
    }
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

function scheduleReconnect(delay = backoff) {
  if (reconnectTimer !== undefined) return;
  reconnectTimer = window.setTimeout(async () => {
    reconnectTimer = undefined;
    backoff = Math.min(15000, backoff * 1.7);
    try {
      const hello = await api<{ auth: string; account: unknown; suspended?: boolean; server?: { maintenance: string | null } }>('/api/hello');
      if (hello.suspended) return useSession.setState({ mode: 'suspended' });
      if (hello.server?.maintenance != null && hello.auth === 'none') {
        useSession.setState({ mode: 'maintenance' });
        return scheduleReconnect(20000);
      }
      if (hello.auth === 'none') {
        useSession.setState({ mode: S().account && !hello.account ? 'loggedout' : 'revoked' });
        return;
      }
      await flush();
      connect();
    } catch {
      scheduleReconnect();
    }
  }, delay);
}

// ───────────────────────── envoi
function queue(ops: Op[]) {
  if (!ops.length) return;
  outbox.push(...ops);
  if (flushTimer === undefined) flushTimer = window.setTimeout(() => void flush(), 120);
}

async function flush(): Promise<void> {
  if (flushTimer !== undefined) {
    window.clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  if (sending || !outbox.length) return;
  const batch = compact(outbox.splice(0, 400));
  sending = true;
  try {
    const r = await api<{ seq: number; rejected: { i: number; reason: string }[]; fixes: Op[] }>('/api/ops', { clientId, ops: batch });
    if (r.fixes?.length) applyRemote(r.fixes, { fx: false });
    if (r.rejected?.some((x) => x.reason === 'forbidden')) toast('TU PEUX SEULEMENT REGARDER CE CERVEAU : MODIFICATION ANNULÉE', '#ff4d6d');
    if (r.rejected?.some((x) => x.reason === 'locked')) toast('QUELQU’UN ÉCRIT DÉJÀ ICI : ATTENDS QU’IL AIT FINI', '#ffb020');
    if (r.rejected?.some((x) => x.reason === 'limit')) toast('LIMITE D’ÉLÉMENTS ATTEINTE SUR CE SERVEUR', '#ff4d6d');
  } catch (e) {
    const status = e instanceof ApiError ? e.status : 0;
    if (status === 401 || status === 403) {
      outbox = [];
      if (status === 401) useSession.setState({ mode: 'revoked' });
    } else if (status === 503) {
      outbox.unshift(...batch);
      useSession.setState({ mode: 'maintenance' });
      scheduleReconnect(20000);
    } else {
      // pas de réseau : on réessaiera
      outbox.unshift(...batch);
      if (S().mode === 'online') useSession.setState({ mode: 'offline' });
      scheduleReconnect();
    }
  } finally {
    sending = false;
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
      if (mode !== 'online' && mode !== 'offline') return;
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
  unsubscribers.push(
    () => window.clearInterval(hb),
    () => window.clearInterval(lay),
  );
  window.addEventListener('pagehide', () => {
    void flush();
  });
  return ready;
}

export function pendingChanges() {
  return outbox.length + (sending ? 1 : 0);
}

/** Recharge l'état complet (après un import, par exemple) */
export function resync() {
  if (S().mode === 'local') return;
  connect();
}

/** Ouvre un autre cerveau (le sien, ou un cerveau rejoint) : on envoie d'abord ce qui attend */
export async function openBrain(id: string, mine: boolean) {
  await flush().catch(() => {});
  location.assign(mine ? '/' : `/?cerveau=${encodeURIComponent(id)}`);
}

export { clientId };
