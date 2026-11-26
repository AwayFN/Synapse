import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError } from '../sync/client';
import { linkBases, SERVER_ROLE_LABEL, useSession, type ServerRole } from '../sync/session';
import { ALERT_HEX } from '../lib/color';

/** Ce qui est créé (des chiffres seulement, jamais le contenu) */
const CREATED = [
  { key: 'action', label: 'Projets et tâches', color: '#00e5ff' },
  { key: 'pensee', label: 'Notes', color: '#a855f7' },
  { key: 'temps', label: 'Créneaux', color: '#ffb020' },
];
import { fmtRelative } from '../lib/time';
import { Corners, cvar, Kbd } from './common';
import { CopyButton } from './Account';
import { AccessCards } from './ShareDialog';

/**
 * Espace admin : tout ce qu'il faut savoir et régler sur son serveur Synapse (créateur et admins seulement).
 * Des chiffres et des métadonnées, jamais le contenu des cerveaux (respect des utilisateurs, et RGPD).
 */

// ───────────────────────── formats
const comma = (s: string) => s.replace('.', ',');
const fmtBytes = (n: number) =>
  n < 1024 ? `${n} o` : n < 1024 ** 2 ? `${comma((n / 1024).toFixed(n < 10240 ? 1 : 0))} Ko` : n < 1024 ** 3 ? `${comma((n / 1024 ** 2).toFixed(1))} Mo` : `${comma((n / 1024 ** 3).toFixed(2))} Go`;
const fmtDate = (t: number) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = (t: number) => new Date(t).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const ago = (t: number | null | undefined) => (t ? fmtRelative(t - Date.now()) : 'jamais');
const fmtUptime = (ms: number) => {
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d ? `${d} j ${h} h` : h ? `${h} h ${m % 60} min` : `${m % 60} min`;
};
const fmtHours = (s: number) => (s >= 3600 ? `${comma((s / 3600).toFixed(1))} h` : `${Math.round(s / 60)} min`);
function device(ua: string) {
  if (!ua) return '—';
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  const o = /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return o ? `${b} · ${o}` : b;
}
const errCode = (e: unknown) => (e instanceof ApiError ? (e.data as { error?: string })?.error ?? '' : 'network');
const ERRORS: Record<string, string> = {
  createur: 'Réservé au créateur.',
  'last-creator': 'Il faut garder au moins un créateur actif.',
  self: 'Pas sur ton propre compte.',
  email: 'Ce compte n’a pas d’adresse e-mail.',
  network: 'Le serveur ne répond pas.',
};
const explain = (e: unknown) => ERRORS[errCode(e)] ?? 'Action impossible.';

function useApi<T>(path: string, every = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const reload = useCallback(() => {
    api<T>(path)
      .then((d) => {
        setData(d);
        setError(false);
      })
      .catch(() => setError(true));
  }, [path]);
  useEffect(() => {
    reload();
    if (!every) return;
    const t = window.setInterval(reload, every);
    return () => window.clearInterval(t);
  }, [reload, every]);
  return { data, setData, reload, error };
}

// ───────────────────────── types (réponses du serveur)
interface DayStat {
  date: string;
  active: number;
  guests: number;
  signups: number;
  captures: number;
  ops: number;
  visits: number;
  logins: number;
  peak: number;
  errors: number;
  feedback: number;
}
interface Overview {
  accounts: { total: number; createurs: number; admins: number; membres: number; suspendus: number; new7: number; new30: number };
  active: { today: number; d7: number; d30: number };
  online: { accounts: number; guests: number; windows: number };
  /** appareils connectés à un compte (une session chacun) */
  devices?: { android: number; windows: number; navigateur: number };
  content: { brains: number; nonEmpty: number; neurons: number; links: number; shared: number; members: number; invites: number };
  storage: number;
  feedback: { unread: number; total: number };
  errors: { day: number; total: number };
  signups: { registration: string; open: number };
  series: DayStat[];
  views: Record<string, number>;
  natures: Record<string, number>;
  server: { hosted: boolean; uptime: number; build: string; node: string };
}
interface User {
  id: string;
  name: string;
  email: string;
  role: ServerRole;
  status: 'actif' | 'suspendu';
  createdAt: number;
  lastSeen: number | null;
  via: string;
  invitedBy: string | null;
  hasPassword: boolean;
  brain: { n: number; l: number; bytes: number; members: number };
  joined: number;
  sessions: number;
  device: string;
  devices?: { app: AppKind; ua: string; createdAt: number; lastSeen: number; online?: boolean }[];
  onlineOn?: AppKind[];
  pc?: boolean;
  activeDays: number;
  online: boolean;
}
type AppKind = 'android' | 'windows' | 'navigateur';
const APP_LABEL: Record<AppKind, string> = { android: 'Application Android', windows: 'Application Windows', navigateur: 'Navigateur' };
const APP_ICON: Record<AppKind, string> = { android: '▣', windows: '▤', navigateur: '◌' };
interface Publication {
  eligible: boolean;
  enabled: boolean;
  depot: string;
  branche: string;
  url: string | null;
  at: number;
  error: string;
  busy: boolean;
  pending: boolean;
  current: string | null;
  fixe: string;
}
interface Signup {
  id: string;
  token: string;
  note: string;
  createdByName: string;
  maxUses: number;
  uses: number;
  usedBy: string[];
  createdAt: number;
  expiresAt: number | null;
  state: string;
}
interface Feedback {
  id: string;
  at: number;
  kind: 'idee' | 'probleme' | 'autre';
  text: string;
  from: { name: string; role: string; account: boolean } | null;
  view: string | null;
  version: string;
  ua: string;
  status: 'nouveau' | 'lu' | 'traite';
}
interface ErrorGroup {
  sig: string;
  source: 'client' | 'serveur';
  message: string;
  stack: string;
  first: number;
  last: number;
  count: number;
  people: number;
  where: string;
  version: string;
  ua: string;
}
interface JournalItem {
  id: string;
  at: number;
  type: string;
  text: string;
  who: { id: string; name: string } | null;
  ip: string;
}
interface Settings {
  appName: string;
  registration: 'ouverte' | 'invitation' | 'fermee';
  brainInvitesAllowSignup: boolean;
  membersCanInvite: boolean;
  memberInviteQuota: number;
  maxAccounts: number;
  maxNeurons: number;
  maintenance: { on: boolean; message: string };
  announcement: { id: string; text: string; level: 'info' | 'important'; at: number };
  terms: string;
  termsAt: number;
  publicUrl: string;
  tunnelTokenSet: boolean;
  defaultTerms: string;
}
interface ServerDetails {
  hosted: boolean;
  proto: number;
  build: string;
  node: string;
  platform: string;
  started: number;
  uptime: number;
  memory: number;
  storage: number;
  dataDir: string | null;
  brainsLoaded: number;
  windows: number;
  publicUrl: string | null;
  envPublicUrl: boolean;
  publication?: Publication;
}

// ───────────────────────── petits éléments
function Tile({ label, value, sub, alert }: { label: string; value: ReactNode; sub?: ReactNode; alert?: boolean }) {
  return (
    <div className="glass p-4 flex flex-col gap-1 min-w-0">
      <span className="xs-label truncate">{label}</span>
      <span className={`text-[26px] leading-none font-semibold tracking-tight tabular-nums ${alert ? 'text-[rgb(var(--alert))]' : 'text-white'}`}>{value}</span>
      {sub && <span className="mono text-[9.5px] tracking-[0.06em] text-white/40 truncate">{sub}</span>}
    </div>
  );
}

function Panel({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="glass p-5 min-w-0">
      <div className="flex items-center justify-between gap-3 mb-4">
        <span className="hud text-[10px] text-white/75">{title}</span>
        {right}
      </div>
      {children}
    </div>
  );
}

const METRICS: { k: keyof DayStat; label: string; unit: string }[] = [
  { k: 'active', label: 'Personnes actives', unit: 'personne' },
  { k: 'signups', label: 'Inscriptions', unit: 'inscription' },
  { k: 'captures', label: 'Captures', unit: 'capture' },
  { k: 'visits', label: 'Visites', unit: 'visite' },
  { k: 'peak', label: 'Pic en ligne', unit: 'personne' },
];
const plural = (n: number, w: string) => `${n} ${w}${n > 1 ? 's' : ''}`;
const dayLabel = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });

/** 30 jours, une seule série : barres fines arrondies côté valeur, infobulle au survol, tableau à la demande */
function ActivityChart({ series }: { series: DayStat[] }) {
  const [metric, setMetric] = useState<keyof DayStat>('active');
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const m = METRICS.find((x) => x.k === metric)!;
  const values = series.map((d) => Number(d[metric]) || 0);
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  const top = max <= 4 ? max : Math.ceil(max / 2) * 2;
  return (
    <Panel
      title={`${m.label} · 30 derniers jours`}
      right={
        <div className="flex items-center gap-2">
          <div className="seg">
            {METRICS.map((x) => (
              <button key={x.k} data-on={metric === x.k ? '1' : '0'} onClick={() => setMetric(x.k)}>
                {x.label}
              </button>
            ))}
          </div>
          <button className="btn btn-ghost !px-2 !text-[9px]" onClick={() => setTable((t) => !t)}>
            {table ? 'Graphique' : 'Tableau'}
          </button>
        </div>
      }
    >
      {table ? (
        <div className="max-h-[220px] overflow-y-auto scroll-thin">
          <table className="w-full text-[12px]">
            <tbody>
              {[...series].reverse().map((d) => (
                <tr key={d.date} className="border-b border-white/[0.04]">
                  <td className="py-1 text-white/55">{dayLabel(d.date)}</td>
                  <td className="py-1 text-right tabular-nums text-white/85">{Number(d[metric]) || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <div className="flex items-end gap-[2px] h-[170px] relative" onMouseLeave={() => setHover(null)}>
            {/* repères discrets */}
            <div className="absolute inset-x-0 top-0 border-t border-white/[0.06] pointer-events-none" />
            <div className="absolute inset-x-0 top-1/2 border-t border-white/[0.04] pointer-events-none" />
            {values.map((v, i) => (
              <div key={series[i].date} className="flex-1 h-full flex items-end cursor-default" onMouseEnter={() => setHover(i)}>
                <div
                  className="w-full rounded-t-[4px] transition-colors"
                  style={{
                    height: v ? `${Math.max(2, (v / top) * 100)}%` : 0,
                    background: `rgb(var(--pearl) / ${hover === i ? 0.95 : i === values.length - 1 ? 0.75 : 0.5})`,
                  }}
                />
              </div>
            ))}
          </div>
          <div className="border-t border-white/15" />
          <div className="flex justify-between mono text-[9px] text-white/35 mt-1.5">
            <span>{dayLabel(series[0]?.date ?? '')}</span>
            <span>{dayLabel(series[Math.floor(series.length / 2)]?.date ?? '')}</span>
            <span>aujourd’hui</span>
          </div>
          <div className="absolute left-0 -top-1 mono text-[9px] text-white/30 pointer-events-none">{top}</div>
          {hover !== null && (
            <div
              className="absolute -top-2 glass px-2.5 py-1.5 pointer-events-none -translate-x-1/2 -translate-y-full whitespace-nowrap"
              style={{ left: `${((hover + 0.5) / values.length) * 100}%` }}
            >
              <div className="mono text-[9px] text-white/45 uppercase">{dayLabel(series[hover].date)}</div>
              <div className="text-[12.5px] text-white tabular-nums">{plural(values[hover], m.unit)}</div>
            </div>
          )}
          <div className="text-[11px] text-white/40 mt-3">
            Total sur 30 jours : <span className="text-white/75 tabular-nums">{total}</span>
            {metric === 'active' && ' (jours-personnes)'}
          </div>
        </div>
      )}
    </Panel>
  );
}

/** Barres horizontales d'une seule teinte : l'étiquette dit ce que c'est */
function HBars({ rows }: { rows: { key: string; label: ReactNode; value: number; display: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const total = rows.reduce((a, r) => a + r.value, 0);
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[120px_1fr_110px] items-center gap-3" title={`${r.display} · ${total ? Math.round((r.value / total) * 100) : 0} %`}>
          <span className="text-[12px] text-white/70 flex items-center gap-2 truncate">{r.label}</span>
          <div className="h-[6px] bg-white/[0.04] rounded-r-[3px]">
            <div className="h-full rounded-r-[3px] bg-[rgb(var(--pearl)/0.6)]" style={{ width: `${(r.value / max) * 100}%` }} />
          </div>
          <span className="mono text-[10px] text-white/50 text-right tabular-nums">
            {total ? Math.round((r.value / total) * 100) : 0} % · {r.display}
          </span>
        </div>
      ))}
      {!total && <div className="text-[11.5px] text-white/35">Pas encore de données.</div>}
    </div>
  );
}

const VIEW_LABEL: Record<string, string> = { network: 'Réseau 3D', agenda: 'Emploi du temps', tasks: 'Tâches', notes: 'Notes' };

function OverviewTab() {
  const { data: o, error } = useApi<Overview>('/api/admin/overview', 15000);
  if (!o) return <div className="mono text-[11px] text-white/40">{error ? 'Impossible de charger.' : 'Chargement…'}</div>;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-4 max-md:grid-cols-2 gap-3">
        <Tile label="Comptes" value={o.accounts.total} sub={`+${o.accounts.new7} cette semaine · ${o.accounts.admins + o.accounts.createurs} équipe`} />
        <Tile label="Actifs aujourd’hui" value={o.active.today} sub={`${o.active.d7} sur 7 j · ${o.active.d30} sur 30 j`} />
        <Tile label="En ligne maintenant" value={o.online.accounts + o.online.guests} sub={`${plural(o.online.accounts, 'compte')} · ${plural(o.online.guests, 'invité')}`} />
        {o.devices && (
          <Tile
            label="Appareils connectés"
            value={o.devices.android + o.devices.windows + o.devices.navigateur}
            sub={`${o.devices.android} Android · ${o.devices.windows} Windows · ${o.devices.navigateur} navigateur${o.devices.navigateur > 1 ? 's' : ''}`}
          />
        )}
        <Tile label="Neurones" value={o.content.neurons.toLocaleString('fr-FR')} sub={`${o.content.links.toLocaleString('fr-FR')} liens · ${o.content.nonEmpty} cerveaux remplis`} />
        <Tile label="Cerveaux partagés" value={o.content.shared} sub={`${plural(o.content.members, 'membre')} · ${plural(o.content.invites, 'invitation')} en attente`} />
        <Tile label="Retours non lus" value={o.feedback.unread} sub={`${o.feedback.total} au total`} />
        <Tile label="Erreurs · 24 h" value={o.errors.day} alert={o.errors.day > 0} sub={o.errors.day > 0 ? '⚠ voir l’onglet Erreurs' : `${o.errors.total} types connus`} />
        <Tile label="Stockage" value={fmtBytes(o.storage)} sub={`serveur allumé depuis ${fmtUptime(o.server.uptime)}`} />
      </div>
      <ActivityChart series={o.series} />
      <div className="grid grid-cols-2 max-md:grid-cols-1 gap-4">
        <Panel title="Vues utilisées · 30 jours">
          <HBars rows={Object.entries(VIEW_LABEL).map(([k, label]) => ({ key: k, label, value: o.views[k] || 0, display: fmtHours(o.views[k] || 0) }))} />
        </Panel>
        <Panel title="Ce qui est créé · 30 jours">
          <HBars
            rows={CREATED.map((c) => ({
              key: c.key,
              label: (
                <>
                  <span className="inline-block w-[7px] h-[7px] mr-1.5" style={{ background: c.color, boxShadow: `0 0 6px ${c.color}` }} /> {c.label}
                </>
              ),
              value: o.natures[c.key] || 0,
              display: String(o.natures[c.key] || 0),
            }))}
          />
        </Panel>
      </div>
      <div className="text-[11px] text-white/35 leading-relaxed">
        Inscriptions : <span className="text-white/60">{o.signups.registration === 'ouverte' ? 'ouvertes à tous' : o.signups.registration === 'invitation' ? 'sur invitation' : 'fermées'}</span> ·{' '}
        {plural(o.signups.open, 'invitation')} à Synapse valable{o.signups.open > 1 ? 's' : ''} · Ici, que des chiffres : le contenu des cerveaux n’apparaît jamais.
      </div>
    </div>
  );
}

// ───────────────────────── personnes
const VIA: Record<string, string> = { local: 'PC du créateur', installation: 'installation sur son PC (serveur)', invitation: 'invitation', cerveau: 'invité dans un cerveau', ouverte: 'inscription libre (application ou navigateur)' };

function UserRow({ u, me, isCreator, onChange }: { u: User; me: string; isCreator: boolean; onChange: (users: User[]) => void }) {
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [reset, setReset] = useState<string | null>(null);
  // un admin a les mêmes droits que le créateur ; seul le compte du créateur reste protégé
  const manageable = u.id !== me && (isCreator || u.role !== 'createur');
  const act = async (path: string, body: Record<string, unknown>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setMsg(null);
    try {
      const r = await api<{ users?: User[]; token?: string }>(path, { id: u.id, ...body });
      if (r.users) onChange(r.users);
      if (r.token) {
        const base = linkBases()[0];
        setReset(base ? `${base.url}/#reinit=${r.token}` : null);
        if (!base) setMsg('Lien créé, mais aucune adresse publique : ouvre l’accès Internet.');
      }
    } catch (e) {
      setMsg(explain(e));
    }
  };
  return (
    <div className="border-b border-white/[0.05] last:border-0">
      <button className="w-full flex items-center gap-3 py-2.5 text-left hover:bg-white/[0.02]" onClick={() => setOpen((x) => !x)}>
        <span className={`w-7 h-7 rounded-full border flex items-center justify-center mono text-[9.5px] flex-none ${u.online ? 'border-white/70 text-white' : 'border-white/15 text-white/45'}`}>
          {(u.name || '?').slice(0, 2).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] text-white/85 truncate">
            {u.name || 'Sans nom'}
            {u.online && (
              <span className="mono text-[9px] text-[#39ff88] ml-2">
                ● EN LIGNE{u.onlineOn?.length ? ` · ${u.onlineOn.map((a) => (a === 'android' ? 'ANDROID' : a === 'windows' ? 'WINDOWS' : 'NAVIGATEUR')).join(' + ')}` : ''}
              </span>
            )}
            {u.status === 'suspendu' && <span className="mono text-[9px] text-[rgb(var(--alert))] ml-2">SUSPENDU</span>}
          </span>
          <span className="block mono text-[9.5px] tracking-[0.06em] text-white/35 truncate">{u.email || 'pas d’e-mail'}</span>
        </span>
        <span className="mono text-[9.5px] text-white/55 w-[70px] uppercase">{SERVER_ROLE_LABEL[u.role]}</span>
        <span className="mono text-[10px] text-white/60 w-[90px] text-right tabular-nums max-md:hidden">{u.brain.n} neurones</span>
        <span className="mono text-[10px] text-white/45 w-[110px] text-right">{u.online ? 'maintenant' : ago(u.lastSeen)}</span>
        <span className="mono text-[10px] text-white/45 w-[80px] text-right tabular-nums max-md:hidden" title="jours actifs sur les 30 derniers">
          {u.activeDays}/30 j
        </span>
      </button>
      {open && (
        <div className="pl-10 pb-4 flex flex-col gap-3 anim-pop">
          <div className="grid grid-cols-3 max-md:grid-cols-1 gap-x-6 gap-y-1.5 text-[11.5px]">
            <span className="text-white/40">
              Inscrit : <span className="text-white/70">{fmtDate(u.createdAt)}</span>
            </span>
            <span className="text-white/40">
              Arrivé par : <span className="text-white/70">{VIA[u.via] ?? u.via}</span>
              {u.invitedBy ? <span className="text-white/70"> ({u.invitedBy})</span> : null}
            </span>
            <span className="text-white/40">
              Appareil : <span className="text-white/70">{device(u.device)}</span>
            </span>
            <span className="text-white/40">
              Cerveau : <span className="text-white/70">{u.brain.n} neurones · {u.brain.l} liens · {fmtBytes(u.brain.bytes)}</span>
            </span>
            <span className="text-white/40">
              Partage : <span className="text-white/70">{plural(u.brain.members, 'membre')} chez lui · a rejoint {plural(u.joined, 'cerveau')}</span>
            </span>
            <span className="text-white/40">
              Sessions : <span className="text-white/70">{u.sessions}</span> · mot de passe : <span className="text-white/70">{u.hasPassword ? 'oui' : 'non'}</span>
            </span>
          </div>
          {!!u.devices?.length && (
            <div className="flex flex-col gap-1" data-user-devices>
              <span className="xs-label">Ses appareils (connecté sur chacun)</span>
              {u.devices.map((d, i) => {
                const live = d.online ?? u.onlineOn?.includes(d.app);
                return (
                  <div key={i} className="flex items-center gap-2 text-[11.5px] flex-wrap">
                    <span className={`mono w-4 text-center ${live ? 'text-[#39ff88]' : 'text-white/40'}`}>{APP_ICON[d.app] ?? '◌'}</span>
                    <span className="text-white/75">{APP_LABEL[d.app] ?? 'Navigateur'}</span>
                    <span className="text-white/35">{device(d.ua)}</span>
                    <span className="text-white/35 ml-auto">{live ? <span className="text-[#39ff88]">en ligne</span> : `vu ${ago(d.lastSeen)}`} · depuis le {fmtDate(d.createdAt)}</span>
                  </div>
                );
              })}
            </div>
          )}
          {manageable ? (
            <div className="flex flex-wrap items-center gap-2">
              {u.role !== 'createur' && (
                <button
                  className={`btn !text-[9.5px] ${u.role === 'admin' ? '' : 'btn-primary'}`}
                  data-make-admin
                  onClick={() =>
                    void act(
                      '/api/admin/users/update',
                      { role: u.role === 'admin' ? 'membre' : 'admin' },
                      u.role === 'admin'
                        ? `Retirer à ${u.name} son rôle d’admin ? Il redevient un utilisateur normal, sans l’espace admin.`
                        : `Nommer ${u.name} admin ? Il aura exactement les mêmes droits que toi : voir tous les utilisateurs, les gérer, régler Synapse.`,
                    )
                  }
                >
                  {u.role === 'admin' ? 'Retirer admin' : '★ Nommer admin'}
                </button>
              )}
              <button
                className="btn !text-[9.5px]"
                onClick={() =>
                  void act(
                    '/api/admin/users/update',
                    { status: u.status === 'suspendu' ? 'actif' : 'suspendu' },
                    u.status === 'suspendu' ? undefined : `Suspendre ${u.name} ? Il est déconnecté tout de suite et ne peut plus entrer.`,
                  )
                }
              >
                {u.status === 'suspendu' ? 'Réactiver' : 'Suspendre'}
              </button>
              <button className="btn !text-[9.5px]" disabled={!u.email} onClick={() => void act('/api/admin/users/reset', {})}>
                Lien de nouveau mot de passe
              </button>
              <button className="btn btn-ghost !text-[9.5px]" onClick={() => void act('/api/admin/users/logout', {})}>
                Déconnecter partout
              </button>
              <button
                className="btn btn-ghost btn-danger !text-[9.5px]"
                onClick={() => void act('/api/admin/users/delete', {}, `Supprimer le compte de ${u.name} et son cerveau ? (effacement définitif sous 30 jours)`)}
              >
                Supprimer
              </button>
            </div>
          ) : (
            <div className="text-[11px] text-white/35">{u.id === me ? 'C’est toi.' : 'Le compte du créateur ne peut être géré que par lui.'}</div>
          )}
          {reset && (
            <div className="glass p-3 flex flex-col gap-2">
              <div className="hud text-[9px] text-white/70">Envoie ce lien à {u.name} · valable 48 h, une seule fois</div>
              <div className="flex gap-2">
                <input readOnly value={reset} className="field field-mono !text-[11px] !py-1.5 flex-1 min-w-0" onFocus={(e) => e.currentTarget.select()} />
                <CopyButton text={reset} label="Copier" />
              </div>
            </div>
          )}
          {msg && <div className="text-[11.5px] text-[rgb(var(--alert))]">{msg}</div>}
        </div>
      )}
    </div>
  );
}

function PeopleTab() {
  const { data, setData } = useApi<{ users: User[] }>('/api/admin/users', 20000);
  const account = useSession((s) => s.account)!;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'tous' | 'ligne' | 'equipe' | 'suspendus'>('tous');
  const users = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.users ?? []).filter(
      (u) =>
        (!s || u.name.toLowerCase().includes(s) || u.email.includes(s)) &&
        (filter === 'tous' || (filter === 'ligne' && u.online) || (filter === 'equipe' && u.role !== 'membre') || (filter === 'suspendus' && u.status === 'suspendu')),
    );
  }, [data, q, filter]);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <input className="field !w-[260px]" placeholder="Chercher un nom, un e-mail…" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg">
          {(
            [
              ['tous', 'Tous'],
              ['ligne', 'En ligne'],
              ['equipe', 'Équipe'],
              ['suspendus', 'Suspendus'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} data-on={filter === k ? '1' : '0'} onClick={() => setFilter(k)}>
              {label}
            </button>
          ))}
        </div>
        <span className="mono text-[10px] text-white/40 ml-auto">{plural(users.length, 'compte')}</span>
      </div>
      <div className="glass px-4">
        <div className="flex items-center gap-3 py-2 border-b border-white/[0.08] mono text-[9px] tracking-[0.1em] text-white/35 uppercase">
          <span className="w-7" />
          <span className="flex-1">Personne</span>
          <span className="w-[70px]">Rôle</span>
          <span className="w-[90px] text-right max-md:hidden">Cerveau</span>
          <span className="w-[110px] text-right">Vu</span>
          <span className="w-[80px] text-right max-md:hidden">Assiduité</span>
        </div>
        {!data ? (
          <div className="mono text-[11px] text-white/40 py-4">Chargement…</div>
        ) : (
          users.map((u) => <UserRow key={u.id} u={u} me={account.id} isCreator={account.role === 'createur'} onChange={(list) => setData({ users: list })} />)
        )}
      </div>
      <div className="text-[11px] text-white/35 leading-relaxed">
        Créateur et admins : exactement les mêmes droits (voir et gérer tout le monde, régler Synapse) · Membre : utilise Synapse, sans espace admin. Toi seul nommes ou retires les admins au départ ; ensuite un admin peut aussi le faire. Les mots de passe ne sont jamais visibles
        (seulement leur empreinte) ; pour un oubli, crée un lien de nouveau mot de passe.
      </div>
    </div>
  );
}

// ───────────────────────── inscriptions
const REG: Record<Settings['registration'], { label: string; hint: string }> = {
  ouverte: { label: 'Ouvertes', hint: 'Tout le monde peut créer un compte avec l’adresse de Synapse.' },
  invitation: { label: 'Sur invitation', hint: 'Il faut un lien d’invitation à Synapse (ou à un cerveau, si tu l’autorises).' },
  fermee: { label: 'Fermées', hint: 'Plus personne ne peut créer de compte. Les comptes existants continuent.' },
};

function SignupsTab() {
  const account = useSession((s) => s.account)!;
  const isCreator = account.role === 'createur';
  const settings = useApi<Settings>('/api/admin/settings');
  const { data, setData } = useApi<{ signups: Signup[] }>('/api/admin/signups');
  const [note, setNote] = useState('');
  const [uses, setUses] = useState(1);
  const [ttl, setTtl] = useState(24 * 7);
  const [created, setCreated] = useState<string | null>(null);
  const s = settings.data;
  const base = linkBases()[0];
  const save = async (patch: Partial<Settings>) => {
    const r = await api<Settings>('/api/admin/settings', patch).catch(() => null);
    if (r) settings.setData(r);
  };
  return (
    <div className="flex flex-col gap-4">
      {s && (
        <Panel title="Qui peut créer un compte">
          <div className="seg w-fit">
            {(Object.keys(REG) as Settings['registration'][]).map((k) => (
              <button key={k} data-on={s.registration === k ? '1' : '0'} disabled={!isCreator} onClick={() => void save({ registration: k })}>
                {REG[k].label}
              </button>
            ))}
          </div>
          <div className="text-[12px] text-white/50 mt-2">{REG[s.registration].hint}</div>
          <div className="flex flex-col gap-2 mt-4">
            <label className="flex items-center gap-2 text-[12px] text-white/65 cursor-pointer">
              <input type="checkbox" disabled={!isCreator} checked={s.brainInvitesAllowSignup} onChange={(e) => void save({ brainInvitesAllowSignup: e.target.checked })} />
              Une invitation à un cerveau permet aussi de créer son compte
            </label>
            <label className="flex items-center gap-2 text-[12px] text-white/65 cursor-pointer">
              <input type="checkbox" disabled={!isCreator} checked={s.membersCanInvite} onChange={(e) => void save({ membersCanInvite: e.target.checked })} />
              Les membres peuvent inviter des amis, jusqu’à
              <input
                type="number"
                min={0}
                max={100}
                className="field !w-[64px] !py-0.5 !text-[12px]"
                disabled={!isCreator}
                defaultValue={s.memberInviteQuota}
                onBlur={(e) => void save({ memberInviteQuota: Number(e.target.value) })}
              />
              invitations par mois
            </label>
          </div>
        </Panel>
      )}
      <Panel title="Inviter quelqu’un sur Synapse">
        <div className="flex flex-wrap items-center gap-3">
          <input className="field !w-[220px]" placeholder="Pour qui ? (note pour toi)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} />
          <div className="seg">
            {[1, 5, 20, 0].map((n) => (
              <button key={n} data-on={uses === n ? '1' : '0'} onClick={() => setUses(n)}>
                {n ? plural(n, 'personne') : 'illimité'}
              </button>
            ))}
          </div>
          <div className="seg">
            {[
              [24, '24 h'],
              [24 * 7, '7 jours'],
              [24 * 30, '30 jours'],
              [0, 'sans limite'],
            ].map(([h, label]) => (
              <button key={h} data-on={ttl === h ? '1' : '0'} onClick={() => setTtl(Number(h))}>
                {label}
              </button>
            ))}
          </div>
          <button
            className="btn btn-primary"
            onClick={async () => {
              const r = await api<{ invite: { token: string }; signups: Signup[] }>('/api/admin/signups', { note, maxUses: uses, ttlHours: ttl }).catch(() => null);
              if (!r) return;
              setData({ signups: r.signups });
              setCreated(r.invite.token);
              setNote('');
            }}
          >
            Créer le lien
          </button>
        </div>
        {created && (
          <div className="glass p-3 mt-4 flex flex-col gap-2 anim-pop">
            {base ? (
              <div className="flex items-center gap-2">
                <input readOnly value={`${base.url}/#inscription=${created}`} className="field field-mono !text-[11px] !py-1.5 flex-1 min-w-0" onFocus={(e) => e.currentTarget.select()} />
                <CopyButton text={`${base.url}/#inscription=${created}`} label="Copier le lien" />
                <CopyButton text={`Viens essayer Synapse, mon second cerveau en 3D : crée ton compte ici ${base.url}/#inscription=${created}`} label="Copier un message" />
              </div>
            ) : (
              <div className="text-[12px] text-[rgb(var(--alert))]">Lien créé. Ouvre l’accès Internet (onglet Serveur) pour obtenir l’adresse à envoyer.</div>
            )}
            {base?.label === 'Internet' && <div className="text-[11px] text-white/38">Adresse temporaire : elle change à chaque redémarrage de Synapse (une adresse fixe se règle dans l’onglet Serveur).</div>}
          </div>
        )}
      </Panel>
      <Panel title={`Invitations à Synapse · ${data?.signups.length ?? 0}`}>
        {(data?.signups ?? []).length === 0 && <div className="text-[12px] text-white/38">Aucune pour l’instant.</div>}
        {(data?.signups ?? []).map((x) => (
          <div key={x.id} className="flex items-center gap-3 py-2 border-b border-white/[0.05] last:border-0">
            <span className={`mono text-[9px] w-[70px] uppercase ${x.state === 'ok' ? 'text-white/70' : 'text-white/30'}`}>
              {x.state === 'ok' ? '● valable' : x.state === 'used' ? 'utilisée' : x.state === 'expired' ? 'expirée' : 'annulée'}
            </span>
            <span className="text-[12px] text-white/75 flex-1 truncate">
              {x.note || 'Sans note'} <span className="text-white/35">· par {x.createdByName} · {x.maxUses ? `${x.uses}/${x.maxUses}` : `${x.uses} utilisation${x.uses > 1 ? 's' : ''}`}</span>
              {x.usedBy.length > 0 && <span className="text-white/45"> · {x.usedBy.join(', ')}</span>}
            </span>
            <span className="mono text-[9.5px] text-white/35">{x.expiresAt ? (x.state === 'ok' ? `expire ${fmtRelative(x.expiresAt - Date.now())}` : '') : 'sans limite'}</span>
            {x.state === 'ok' && base && <CopyButton text={`${base.url}/#inscription=${x.token}`} label="Lien" />}
            {x.state === 'ok' && (
              <button
                className="btn btn-ghost btn-danger !px-2 !text-[9.5px]"
                onClick={async () => {
                  const r = await api<{ signups: Signup[] }>('/api/admin/signups/revoke', { id: x.id }).catch(() => null);
                  if (r) setData(r);
                }}
              >
                Annuler
              </button>
            )}
          </div>
        ))}
      </Panel>
    </div>
  );
}

// ───────────────────────── retours, erreurs, journal
const FB_KIND: Record<Feedback['kind'], string> = { idee: 'Idée', probleme: 'Problème', autre: 'Autre' };

function FeedbackTab() {
  const { data, setData } = useApi<{ items: Feedback[] }>('/api/admin/feedback', 20000);
  const [filter, setFilter] = useState<'tous' | Feedback['status']>('tous');
  const items = (data?.items ?? []).filter((f) => filter === 'tous' || f.status === filter);
  const update = async (id: string, status: Feedback['status']) => {
    const r = await api<{ items: Feedback[] }>('/api/admin/feedback/update', { id, status }).catch(() => null);
    if (r) setData(r);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="seg w-fit">
        {(['tous', 'nouveau', 'lu', 'traite'] as const).map((k) => (
          <button key={k} data-on={filter === k ? '1' : '0'} onClick={() => setFilter(k)}>
            {k === 'tous' ? 'Tous' : k === 'nouveau' ? 'Nouveaux' : k === 'lu' ? 'Lus' : 'Traités'}
          </button>
        ))}
      </div>
      {items.length === 0 && <div className="text-[12px] text-white/38">Aucun retour {filter !== 'tous' ? 'ici' : 'pour l’instant'}. Chacun peut t’écrire depuis son menu (ou Ctrl K).</div>}
      {items.map((f) => (
        <div key={f.id} className={`glass p-4 ${f.status === 'nouveau' ? 'neon' : ''}`}>
          <div className="flex items-center gap-3">
            <span className={`hud text-[9px] ${f.kind === 'probleme' ? 'text-[rgb(var(--alert))]' : 'text-white/70'}`}>{FB_KIND[f.kind]}</span>
            <span className="text-[12px] text-white/60">
              {f.from?.name ?? '?'} <span className="text-white/35">· {f.from?.account ? f.from.role : 'invité sans compte'}</span>
            </span>
            <span className="mono text-[9.5px] text-white/35 ml-auto">
              {fmtDateTime(f.at)} · {f.view ? VIEW_LABEL[f.view] : '—'} · {device(f.ua)}
            </span>
          </div>
          <div className="text-[13px] text-white/80 mt-2 leading-relaxed whitespace-pre-wrap">{f.text}</div>
          <div className="flex gap-2 mt-3">
            {(['nouveau', 'lu', 'traite'] as const).map((st) => (
              <button key={st} className="facet" data-on={f.status === st ? '1' : '0'} onClick={() => void update(f.id, st)}>
                {st === 'nouveau' ? 'Nouveau' : st === 'lu' ? 'Lu' : 'Traité'}
              </button>
            ))}
            <button
              className="btn btn-ghost btn-danger !px-2 !text-[9.5px] ml-auto"
              onClick={async () => {
                const r = await api<{ items: Feedback[] }>('/api/admin/feedback/delete', { id: f.id }).catch(() => null);
                if (r) setData(r);
              }}
            >
              Supprimer
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ErrorsTab() {
  const { data, setData, reload } = useApi<{ items: ErrorGroup[] }>('/api/admin/errors', 30000);
  const [open, setOpen] = useState<string | null>(null);
  const items = data?.items ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="text-[12px] text-white/50">
          Les erreurs techniques de l’application (chez tout le monde) et du serveur, regroupées. Jamais de contenu de cerveau.
        </span>
        <button className="btn btn-ghost !text-[9.5px] ml-auto" onClick={reload}>
          ↻ Actualiser
        </button>
        {items.length > 0 && (
          <button
            className="btn btn-ghost btn-danger !text-[9.5px]"
            onClick={async () => {
              const r = await api<{ items: ErrorGroup[] }>('/api/admin/errors/clear', {}).catch(() => null);
              if (r) setData(r);
            }}
          >
            Tout effacer
          </button>
        )}
      </div>
      {items.length === 0 && <div className="text-[12px] text-white/38">Aucune erreur. ✓</div>}
      {items.map((g) => (
        <div key={g.sig} className="glass px-4 py-3">
          <button className="w-full flex items-center gap-3 text-left" onClick={() => setOpen(open === g.sig ? null : g.sig)}>
            <span className={`mono text-[9px] w-[54px] uppercase ${g.source === 'serveur' ? 'text-[rgb(var(--alert))]' : 'text-white/55'}`}>{g.source}</span>
            <span className="text-[12.5px] text-white/80 flex-1 truncate">{g.message}</span>
            <span className="mono text-[9.5px] text-white/45 tabular-nums">
              ×{g.count} · {plural(g.people, 'compte')} · {ago(g.last)}
            </span>
          </button>
          {open === g.sig && (
            <div className="mt-3 flex flex-col gap-2">
              <div className="mono text-[9.5px] text-white/40">
                première fois {fmtDateTime(g.first)} · version {g.version || '?'} · {g.where || '—'} · {device(g.ua)}
              </div>
              {g.stack && <pre className="mono text-[10px] text-white/55 whitespace-pre-wrap break-all max-h-[200px] overflow-y-auto scroll-thin bg-black/30 p-2">{g.stack}</pre>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const JOURNAL_TYPES: [string, string][] = [
  ['', 'Tout'],
  ['inscription', 'Inscriptions'],
  ['connexion', 'Connexions'],
  ['echec', 'Échecs'],
  ['compte', 'Comptes'],
  ['cerveau', 'Cerveaux'],
  ['partage', 'Accès'],
  ['admin', 'Équipe'],
  ['serveur', 'Serveur'],
];

function JournalTab() {
  const [type, setType] = useState('');
  const { data } = useApi<{ items: JournalItem[] }>(`/api/admin/journal${type ? `?type=${type}` : ''}`, 20000);
  return (
    <div className="flex flex-col gap-3">
      <div className="seg w-fit">
        {JOURNAL_TYPES.map(([k, label]) => (
          <button key={k} data-on={type === k ? '1' : '0'} onClick={() => setType(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="glass px-4 py-1">
        {(data?.items ?? []).length === 0 && <div className="text-[12px] text-white/38 py-3">Rien pour l’instant.</div>}
        {(data?.items ?? []).map((j) => (
          <div key={j.id} className="flex items-center gap-3 py-1.5 border-b border-white/[0.04] last:border-0">
            <span className="mono text-[9.5px] text-white/35 w-[118px] flex-none">{fmtDateTime(j.at)}</span>
            <span className={`mono text-[9px] w-[80px] flex-none uppercase ${j.type === 'echec' ? 'text-[rgb(var(--alert))]' : 'text-white/50'}`}>{j.type}</span>
            <span className="text-[12px] text-white/75 flex-1 truncate">{j.text}</span>
            {j.ip && <span className="mono text-[9.5px] text-white/30">{j.ip}</span>}
          </div>
        ))}
      </div>
      <div className="text-[11px] text-white/35">Les adresses IP sont raccourcies (ex. 81.23.x.x) : assez pour repérer des tentatives répétées, pas pour localiser quelqu’un.</div>
    </div>
  );
}

// ───────────────────────── réglages
function SettingsTab() {
  const account = useSession((s) => s.account)!;
  const isCreator = account.role === 'createur';
  const { data: s, setData } = useApi<Settings>('/api/admin/settings');
  const [announce, setAnnounce] = useState<string | null>(null);
  const [level, setLevel] = useState<'info' | 'important'>('info');
  const [maint, setMaint] = useState<string | null>(null);
  const [terms, setTerms] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  if (!s) return <div className="mono text-[11px] text-white/40">Chargement…</div>;
  const save = async (patch: Partial<Settings>, what: string) => {
    const r = await api<Settings>('/api/admin/settings', patch).catch(() => null);
    if (r) {
      setData(r);
      setSaved(what);
      window.setTimeout(() => setSaved(null), 2000);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Annonce à tout le monde">
        <div className="text-[12px] text-white/50 mb-3">Un bandeau discret chez chaque personne connectée (en direct), jusqu’à ce que tu le retires.</div>
        <div className="flex gap-2 items-center flex-wrap">
          <input className="field flex-1 min-w-[280px]" maxLength={280} value={announce ?? s.announcement.text} onChange={(e) => setAnnounce(e.target.value)} placeholder="Ex. Nouvelle version ce soir : la vue agenda change !" />
          <div className="seg">
            <button data-on={level === 'info' ? '1' : '0'} onClick={() => setLevel('info')}>
              Info
            </button>
            <button data-on={level === 'important' ? '1' : '0'} onClick={() => setLevel('important')}>
              Important
            </button>
          </div>
          <button
            className="btn btn-primary"
            onClick={async () => {
              const r = await api<Settings>('/api/admin/announce', { text: announce ?? s.announcement.text, level }).catch(() => null);
              if (r) setData(r);
            }}
          >
            Publier
          </button>
          {s.announcement.text && (
            <button
              className="btn btn-ghost"
              onClick={async () => {
                const r = await api<Settings>('/api/admin/announce', { text: '' }).catch(() => null);
                if (r) {
                  setData(r);
                  setAnnounce('');
                }
              }}
            >
              Retirer
            </button>
          )}
        </div>
      </Panel>

      <Panel title="Maintenance">
        <div className="flex items-center gap-3 flex-wrap">
          <button
            className="facet"
            data-on={s.maintenance.on ? '1' : '0'}
            disabled={!isCreator}
            onClick={async () => {
              if (!s.maintenance.on && !window.confirm('Activer la maintenance ? Tous les membres sont déconnectés jusqu’à la fin (l’équipe reste).')) return;
              const r = await api<Settings>('/api/admin/maintenance', { on: !s.maintenance.on, message: maint ?? s.maintenance.message }).catch(() => null);
              if (r) setData(r);
            }}
          >
            {s.maintenance.on ? '● En maintenance' : '○ Synapse ouvert'}
          </button>
          <input className="field flex-1 min-w-[260px]" maxLength={300} disabled={!isCreator} value={maint ?? s.maintenance.message} onChange={(e) => setMaint(e.target.value)} placeholder="Message affiché (ex. On revient vers 21 h)" />
        </div>
      </Panel>

      <Panel title="Généralités et limites">
        <div className="grid grid-cols-3 gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="xs-label">Nom affiché</span>
            <input className="field" disabled={!isCreator} defaultValue={s.appName} maxLength={40} onBlur={(e) => e.target.value !== s.appName && void save({ appName: e.target.value }, 'Nom enregistré')} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="xs-label">Comptes au maximum (0 = sans limite)</span>
            <input className="field" type="number" min={0} disabled={!isCreator} defaultValue={s.maxAccounts} onBlur={(e) => void save({ maxAccounts: Number(e.target.value) }, 'Limite enregistrée')} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="xs-label">Neurones par cerveau (0 = sans limite)</span>
            <input className="field" type="number" min={0} disabled={!isCreator} defaultValue={s.maxNeurons} onBlur={(e) => void save({ maxNeurons: Number(e.target.value) }, 'Limite enregistrée')} />
          </label>
        </div>
        {saved && <div className="text-[11.5px] text-white/55 mt-2">✓ {saved}</div>}
      </Panel>

      <Panel title="Conditions & confidentialité (montrées à l’inscription)">
        <textarea
          className="field !h-[220px] resize-y !text-[12.5px] leading-relaxed"
          disabled={!isCreator}
          value={terms ?? s.terms}
          maxLength={8000}
          onChange={(e) => setTerms(e.target.value)}
        />
        <div className="flex gap-2 mt-3 items-center">
          <button className="btn" disabled={!isCreator || terms === null} onClick={() => void save({ terms: terms ?? s.terms }, 'Texte enregistré').then(() => setTerms(null))}>
            Enregistrer
          </button>
          <button className="btn btn-ghost" disabled={!isCreator} onClick={() => setTerms(s.defaultTerms)}>
            Texte proposé
          </button>
          <span className="text-[11px] text-white/35 ml-2">« {'{createur}'} » est remplacé par ton prénom. Vide = pas de case à cocher.</span>
        </div>
      </Panel>
      
    </div>
  );
}

// ───────────────────────── serveur
/**
 * L'adresse du Synapse central, publiée sur GitHub : les applications (Android, PC Windows) la retrouvent toutes
 * seules, même quand l'adresse Internet gratuite change (à chaque redémarrage de Synapse).
 */
function PublicationPanel({ initial }: { initial: Publication }) {
  const [p, setP] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => setP(initial), [initial]);
  if (!p.eligible) {
    return (
      <Panel title="Adresse pour les applications">
        <div className="text-[12px] text-white/50 leading-relaxed">
          Les applications (Android, PC) trouvent le Synapse central grâce au dépôt GitHub <span className="mono text-white/70">{p.depot || '—'}</span>. L’adresse y est publiée
          automatiquement par le PC du créateur (celui qui a la copie git du dépôt).
          {p.fixe ? (
            <>
              {' '}
              Adresse fixe indiquée : <span className="mono text-white/70">{p.fixe}</span>.
            </>
          ) : null}
        </div>
      </Panel>
    );
  }
  const status = p.busy
    ? 'Publication en cours…'
    : p.error
      ? `Échec : ${p.error}`
      : p.url
        ? p.url === p.current
          ? `À jour · ${p.url}`
          : `Publiée : ${p.url}${p.current ? ` · nouvelle adresse ${p.current} bientôt publiée` : ''}`
        : p.current
          ? 'Pas encore publiée'
          : 'Ouvre l’accès Internet : son adresse sera publiée automatiquement';
  return (
    <Panel title="Adresse pour les applications">
      <div className="text-[12px] text-white/55 leading-relaxed">
        Les applications Synapse (téléphones Android, PC Windows de tes amis) se connectent à ce serveur. Son adresse Internet est publiée sur ton GitHub (
        <span className="mono text-white/75">{p.depot}</span>, branche <span className="mono text-white/75">{p.branche}</span>) dès qu’elle change : elles la retrouvent
        toutes seules, sans se déconnecter. La publication utilise la connexion GitHub déjà enregistrée sur ce PC.
      </div>
      <div className="flex items-center gap-3 mt-3 flex-wrap">
        <span className={`w-2 h-2 rounded-full ${p.error ? 'bg-[rgb(var(--alert))]' : p.url && p.url === p.current ? 'bg-[#39ff88] shadow-[0_0_8px_#39ff88]' : 'bg-white/30'}`} />
        <span className={`mono text-[11px] break-all ${p.error ? 'text-[rgb(var(--alert))]' : 'text-white/70'}`} data-publication-status>
          {p.enabled ? status : 'Publication coupée'}
        </span>
        {p.at > 0 && !p.busy && <span className="mono text-[10px] text-white/35">{fmtDateTime(p.at)}</span>}
      </div>
      <div className="flex gap-2 mt-3 flex-wrap">
        <button
          className="btn"
          disabled={busy || !p.current}
          onClick={async () => {
            setBusy(true);
            const r = await api<Publication>('/api/admin/publication/now', {}).catch(() => null);
            if (r) setP(r);
            setBusy(false);
          }}
        >
          {busy ? 'Publication…' : 'Publier maintenant'}
        </button>
        <button
          className="btn btn-ghost"
          onClick={async () => {
            const r = await api<Publication>('/api/admin/publication', { on: !p.enabled }).catch(() => null);
            if (r) setP(r);
          }}
        >
          {p.enabled ? 'Couper la publication automatique' : 'Activer la publication automatique'}
        </button>
      </div>
      {p.error && (
        <div className="text-[11.5px] text-white/45 mt-2 leading-relaxed">
          Si GitHub refuse : publie une fois Synapse depuis ce PC (git push) pour enregistrer ta connexion GitHub, puis « Publier maintenant ».
        </div>
      )}
    </Panel>
  );
}

function ServerTab() {
  const account = useSession((s) => s.account)!;
  const local = useSession((s) => s.local);
  const share = useSession((s) => s.share);
  const isCreator = account.role === 'createur';
  const { data: d } = useApi<ServerDetails>('/api/admin/server', 10000);
  const settings = useApi<Settings>('/api/admin/settings');
  const [url, setUrl] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (local && !share) api('/api/share').then((s) => useSession.setState({ share: s as never })).catch(() => {});
  }, [local, share]);
  if (!d) return <div className="mono text-[11px] text-white/40">Chargement…</div>;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-4 max-md:grid-cols-2 gap-3">
        <Tile label="Mode" value={d.hosted ? 'En ligne' : 'Sur ton PC'} sub={d.hosted ? 'hébergeur' : 'tant que le PC est allumé'} />
        <Tile label="Allumé depuis" value={fmtUptime(d.uptime)} sub={`depuis ${fmtDateTime(d.started)}`} />
        <Tile label="Mémoire" value={fmtBytes(d.memory)} sub={`${d.brainsLoaded} cerveaux chargés · ${d.windows} fenêtres`} />
        <Tile label="Données" value={fmtBytes(d.storage)} sub="sauvegarde quotidienne (14 j)" />
      </div>

      {!d.hosted && (
        <Panel title="Accès à ton serveur">
          {local && share?.manageAccess ? (
            <AccessCards s={share} />
          ) : (
            <div className="text-[12px] text-white/50">Les accès Wi-Fi et Internet s’ouvrent depuis le PC qui fait tourner Synapse.</div>
          )}
        </Panel>
      )}

      {d.publication && <PublicationPanel initial={d.publication} />}

      {!d.hosted && settings.data && (
        <Panel title="Adresse fixe (avancé)">
          <div className="text-[12px] text-white/55 leading-relaxed">
            L’adresse Internet gratuite change à chaque redémarrage. Pour une adresse qui ne change jamais (ex. <span className="mono text-white/75">https://synapse.ton-domaine.fr</span>) :
            un compte Cloudflare gratuit et un nom de domaine (~10 €/an). Dans Cloudflare : Zero Trust → Networks → Tunnels → « Create a tunnel » (Cloudflared), puis
            « Public hostname » vers <span className="mono text-white/75">http://localhost:5173</span>. Colle ici le jeton du tunnel et l’adresse, puis rouvre l’accès Internet.
          </div>
          <div className="grid grid-cols-[1fr_1fr_auto] max-md:grid-cols-1 gap-3 mt-4 items-end">
            <label className="flex flex-col gap-1.5">
              <span className="xs-label">Adresse publique</span>
              <input
                className="field field-mono !text-[11.5px]"
                disabled={!isCreator}
                placeholder="https://synapse.ton-domaine.fr"
                value={url ?? settings.data.publicUrl}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="xs-label">Jeton du tunnel {settings.data.tunnelTokenSet ? '(enregistré)' : ''}</span>
              <input
                className="field field-mono !text-[11.5px]"
                type="password"
                disabled={!isCreator}
                placeholder={settings.data.tunnelTokenSet ? '•••••••• (laisser vide pour garder)' : 'eyJhIjoi…'}
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </label>
            <button
              className="btn"
              disabled={!isCreator}
              onClick={async () => {
                const r = await api<Settings>('/api/admin/settings', { publicUrl: url ?? settings.data!.publicUrl, ...(token ? { tunnelToken: token } : {}) }).catch(() => null);
                if (r) {
                  settings.setData(r);
                  setToken('');
                  setMsg('Enregistré. Ferme puis rouvre l’accès Internet pour l’utiliser.');
                }
              }}
            >
              Enregistrer
            </button>
          </div>
          {settings.data.tunnelTokenSet && (
            <button
              className="btn btn-ghost btn-danger !text-[9.5px] mt-3"
              disabled={!isCreator}
              onClick={async () => {
                const r = await api<Settings>('/api/admin/settings', { tunnelToken: '' }).catch(() => null);
                if (r) settings.setData(r);
              }}
            >
              Revenir à l’adresse gratuite
            </button>
          )}
          {msg && <div className="text-[11.5px] text-white/55 mt-2">{msg}</div>}
        </Panel>
      )}

      <Panel title="Rendre Synapse public">
        <div className="text-[12px] text-white/55 leading-relaxed flex flex-col gap-2">
          <span>
            <span className="text-white/80">1 · Depuis ce PC</span> : ouvre l’accès Internet (ou une adresse fixe ci-dessus), choisis qui peut s’inscrire (onglet Inscriptions),
            relis le texte de confidentialité (onglet Réglages). Le PC doit rester allumé.
          </span>
          <span>
            <span className="text-white/80">2 · Chez un hébergeur</span> (toujours en ligne, sans ton PC) : suis le guide{' '}
            <span className="mono text-white/75">METTRE-EN-LIGNE.txt</span>, à côté de « Lancer Synapse » (un <span className="mono text-white/75">Dockerfile</span> est prêt
            dans <span className="mono text-white/75">app</span>). Au premier démarrage, un lien « INSTALLATION » crée ton compte créateur.
          </span>
          <span className="text-white/40">
            Version {d.build || '?'} · protocole {d.proto} · Node {d.node} · {d.platform}
            {d.dataDir ? ` · données : ${d.dataDir}` : ''}
          </span>
        </div>
        {local && d.dataDir && (
          <button className="btn mt-3" onClick={() => void api('/api/data-folder', {})}>
            Ouvrir le dossier des données
          </button>
        )}
      </Panel>
    </div>
  );
}

// ───────────────────────── fenêtre
type Tab = 'vue' | 'personnes' | 'inscriptions' | 'retours' | 'erreurs' | 'journal' | 'reglages' | 'serveur';
const TABS: { id: Tab; label: string }[] = [
  { id: 'vue', label: 'Vue d’ensemble' },
  { id: 'personnes', label: 'Personnes' },
  { id: 'inscriptions', label: 'Inscriptions' },
  { id: 'retours', label: 'Retours' },
  { id: 'erreurs', label: 'Erreurs' },
  { id: 'journal', label: 'Journal' },
  { id: 'reglages', label: 'Réglages' },
  { id: 'serveur', label: 'Serveur' },
];

export function AdminPanel() {
  const open = useSession((s) => s.adminOpen);
  const account = useSession((s) => s.account);
  const staff = useSession((s) => s.staff);
  const name = useSession((s) => s.server?.name);
  const [tab, setTab] = useState<Tab>('vue');
  if (!open || !account?.staff) return null;
  const close = () => useSession.setState({ adminOpen: false });
  const badge = (t: Tab) => (t === 'retours' ? staff?.feedback : t === 'erreurs' ? staff?.errors : 0) || 0;
  return (
    <div className="fixed inset-0 z-50 anim-fade" data-ui>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={close} />
      <div className="absolute inset-4 max-md:inset-0 glass neon flex flex-col anim-pop overflow-hidden">
        <Corners />
        <div className="flex items-center gap-4 max-md:gap-2 flex-wrap px-7 max-md:px-3 pt-6 max-md:pt-3 pb-4 max-md:pb-2 border-b border-white/[0.06]">
          <div className="w-2 h-2 rotate-45 bg-[rgb(var(--pearl))] shadow-[0_0_10px_rgb(var(--pearl)/0.7)]" />
          <div>
            <div className="hud text-[11px] text-white/85">Espace admin · {name || 'Synapse'}</div>
            <div className="text-[12px] text-white/40 mt-0.5">
              {account.name || 'Créateur'} · {SERVER_ROLE_LABEL[account.role]}
            </div>
          </div>
          <div className="seg ml-6 max-md:ml-0 max-md:order-last max-md:w-full min-w-0 overflow-x-auto scroll-thin">
            {TABS.map((t) => (
              <button key={t.id} data-on={tab === t.id ? '1' : '0'} onClick={() => setTab(t.id)}>
                {t.label}
                {badge(t.id) > 0 && <span className="ml-1.5 text-[rgb(var(--alert))]">{badge(t.id)}</span>}
              </button>
            ))}
          </div>
          <button className="btn btn-ghost ml-auto" onClick={close}>
            ✕ <span className="text-white/35 ml-1">Échap</span>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto overflow-x-hidden scroll-thin px-7 max-md:px-3 py-6 max-md:py-4">
          {tab === 'vue' && <OverviewTab />}
          {tab === 'personnes' && <PeopleTab />}
          {tab === 'inscriptions' && <SignupsTab />}
          {tab === 'retours' && <FeedbackTab />}
          {tab === 'erreurs' && <ErrorsTab />}
          {tab === 'journal' && <JournalTab />}
          {tab === 'reglages' && <SettingsTab />}
          {tab === 'serveur' && <ServerTab />}
        </div>
        <div className="px-7 py-2.5 border-t border-white/[0.06] flex items-center gap-4 hud text-[9px] text-white/28">
          <span>
            <Kbd>Échap</Kbd> fermer
          </span>
          <span className="ml-auto" style={cvar(ALERT_HEX)}>
            Des chiffres, jamais le contenu des cerveaux
          </span>
        </div>
      </div>
    </div>
  );
}
