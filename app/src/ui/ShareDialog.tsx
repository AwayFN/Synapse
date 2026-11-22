import { useEffect, useMemo, useState } from 'react';
import { api } from '../sync/client';
import { linkBases, ROLE_HINT, ROLE_LABEL, useSession, type Invite, type MemberDetail, type Role, type Scope, type ShareStatus } from '../sync/session';
import { fmtRelative } from '../lib/time';
import { ALERT_HEX } from '../lib/kinds';
import { Corners, cvar, Kbd } from './common';
import { useAllTags } from './TagBar';

type GuestRole = Exclude<Role, 'owner'>;
const ROLES: GuestRole[] = ['lecture', 'contribution', 'edition'];
const TTLS: { h: number; label: string }[] = [
  { h: 24, label: '24 h' },
  { h: 24 * 7, label: '7 jours' },
  { h: 24 * 30, label: '30 jours' },
  { h: 0, label: 'sans limite' },
];

async function post(path: string, body: unknown) {
  const s = await api<ShareStatus>(path, body);
  if (s && 'lan' in s)
    useSession.setState((st) => ({
      share: s,
      ownerName: s.ownerName,
      brainName: s.brainName,
      // le prénom du propriétaire est celui de son compte
      account: st.account && s.ownerNameSet ? { ...st.account, name: s.ownerName } : st.account,
    }));
  return s;
}

/** Adresses où l'invitation fonctionne : celles des accès ouverts sur le PC du créateur, sinon l'adresse actuelle */
function bases(s: ShareStatus | null): { label: string; url: string }[] {
  if (!s) return [];
  return linkBases();
}

function CopyButton({ text, label = 'Copier' }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="btn !py-1 !px-2 !text-[9.5px] flex-none"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setOk(true);
        window.setTimeout(() => setOk(false), 1600);
      }}
    >
      {ok ? '✓ Copié' : label}
    </button>
  );
}

function LinkRow({ base, token, name }: { base: { label: string; url: string }; token: string; name?: string }) {
  const link = `${base.url}/#invite=${token}`;
  const owner = useSession((s) => s.ownerName);
  const message = `${name ? `${name}, ` : ''}rejoins mon second cerveau Synapse : ${link}\n— ${owner}`;
  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="xs-label w-[78px] flex-none">{base.label}</span>
      <input readOnly value={link} className="field field-mono !text-[11px] !py-1.5 flex-1 min-w-0" onFocus={(e) => e.currentTarget.select()} />
      <CopyButton text={link} label="Copier le lien" />
      <CopyButton text={message} label="Copier un message" />
    </div>
  );
}

function ScopePicker({ value, onChange }: { value: Scope; onChange: (s: Scope) => void }) {
  const tags = useAllTags();
  return (
    <div className="flex flex-col gap-2">
      <div className="seg w-fit">
        <button data-on={value.all ? '1' : '0'} onClick={() => onChange({ all: true, tags: [] })}>
          Tout le cerveau
        </button>
        <button data-on={!value.all ? '1' : '0'} onClick={() => onChange({ all: false, tags: value.tags.length ? value.tags : tags.slice(0, 1).map(([t]) => t) })}>
          Seulement des tags
        </button>
      </div>
      {!value.all && (
        <div className="flex flex-wrap gap-1.5">
          {tags.length === 0 && <span className="text-[12px] text-white/40">Aucun tag pour l’instant : ajoute des #tags à tes neurones.</span>}
          {tags.map(([t, n]) => {
            const on = value.tags.includes(t);
            return (
              <button
                key={t}
                className="chip"
                data-on={on ? '1' : '0'}
                onClick={() => {
                  const next = on ? value.tags.filter((x) => x !== t) : [...value.tags, t];
                  onChange(next.length ? { all: false, tags: next } : { all: true, tags: [] });
                }}
              >
                #{t} <span className="opacity-45">{n}</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="text-[11px] text-white/38">
        Les neurones marqués 🔒 privés ne sont jamais partagés.{!value.all && ' Ce que l’invité capture reçoit automatiquement un de ces tags.'}
      </div>
    </div>
  );
}

function RoleSeg({ value, onChange }: { value: GuestRole; onChange: (r: GuestRole) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="seg w-fit">
        {ROLES.map((r) => (
          <button key={r} data-on={value === r ? '1' : '0'} onClick={() => onChange(r)}>
            {ROLE_LABEL[r]}
          </button>
        ))}
      </div>
      <div className="text-[11.5px] text-white/45">Il {ROLE_HINT[value]}.</div>
    </div>
  );
}

/** Ouvrir le serveur aux autres : même Wi-Fi, ou Internet (aussi dans l'espace créateur) */
export function AccessCards({ s }: { s: ShareStatus }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const net = s.internet;
  const run = async (key: string, path: string, body: unknown) => {
    setBusy(key);
    try {
      await post(path, body);
    } catch {
      /* l'état affiché reste celui du serveur */
    }
    setBusy(null);
  };
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="glass p-4 flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="hud text-[10.5px] text-white/85">Même Wi-Fi</span>
          <button className="facet" data-on={s.lan.on ? '1' : '0'} disabled={busy === 'lan'} onClick={() => run('lan', '/api/share/lan', { on: !s.lan.on })}>
            {s.lan.on ? '● Ouvert' : '○ Fermé'}
          </button>
        </div>
        <div className="text-[11.5px] text-white/48 leading-relaxed">
          Pour quelqu’un chez toi ou au bureau, sur le même réseau. Rien à installer. Windows peut te demander d’autoriser « Node.js » : choisis{' '}
          <span className="text-white/70">Autoriser</span> (réseaux privés).
        </div>
        {s.lan.error && <div className="text-[11.5px] text-[rgb(var(--alert))]">{s.lan.error}</div>}
        {s.lan.on && s.lan.urls.map((u) => <div key={u} className="mono text-[11px] text-white/70">{u}</div>)}
      </div>

      <div className="glass p-4 flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="hud text-[10.5px] text-white/85">Depuis n’importe où</span>
          {net.state === 'on' ? (
            <button className="facet" data-on="1" onClick={() => run('net', '/api/share/internet', { on: false })}>
              ● Ouvert
            </button>
          ) : net.state === 'starting' || net.state === 'downloading' ? (
            <span className="mono text-[9.5px] text-white/55 breathe">{net.state === 'downloading' ? `TÉLÉCHARGEMENT ${net.progress} %` : 'OUVERTURE…'}</span>
          ) : (
            <button
              className="facet"
              data-on="0"
              disabled={busy === 'net' || (!net.toolReady && !consent)}
              onClick={() => run('net', '/api/share/internet', { on: true, consent })}
            >
              ○ Fermé
            </button>
          )}
        </div>
        <div className="text-[11.5px] text-white/48 leading-relaxed">
          {net.fixed
            ? 'Ton adresse fixe, par ton tunnel Cloudflare (réglée dans l’espace créateur, onglet Serveur).'
            : 'Une adresse sécurisée (https) créée par Cloudflare, sans compte ni réglage de box. Les échanges passent chiffrés par Cloudflare. L’adresse change à chaque redémarrage de Synapse : renvoie alors le nouveau lien (les accès et les comptes restent valables).'}
        </div>
        {!net.toolReady && net.state !== 'on' && (
          <label className="flex items-start gap-2 text-[11.5px] text-white/60 cursor-pointer">
            <input type="checkbox" className="mt-[3px]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              J’accepte que Synapse télécharge une fois l’outil gratuit <span className="mono text-white/75">cloudflared</span> (~40 Mo, signé par Cloudflare,
              vérifié avant usage).
            </span>
          </label>
        )}
        {net.error && <div className="text-[11.5px] text-[rgb(var(--alert))]">{net.error}</div>}
        {net.state === 'on' && net.url && <div className="mono text-[11px] text-white/70 break-all">{net.url}</div>}
      </div>
    </div>
  );
}

function InviteForm({ s }: { s: ShareStatus }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<GuestRole>('contribution');
  const [scope, setScope] = useState<Scope>({ all: true, tags: [] });
  const [ttl, setTtl] = useState(24 * 7);
  const [multi, setMulti] = useState(false);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const b = bases(s);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-4 items-start">
        <span className="xs-label pt-2">Pour qui</span>
        <input className="field !w-[260px]" placeholder="Prénom (facultatif)" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        <span className="xs-label pt-2">Rôle</span>
        <RoleSeg value={role} onChange={setRole} />
        <span className="xs-label pt-2">Zone</span>
        <ScopePicker value={scope} onChange={setScope} />
        <span className="xs-label pt-2">Validité</span>
        <div className="flex flex-col gap-2">
          <div className="seg w-fit">
            {TTLS.map((x) => (
              <button key={x.h} data-on={ttl === x.h ? '1' : '0'} onClick={() => setTtl(x.h)}>
                {x.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[12px] text-white/60 cursor-pointer">
            <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} />
            Lien utilisable par plusieurs personnes (sinon : une seule)
          </label>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ invite: { token: string } } & ShareStatus>('/api/invites', { name, role, scope, ttlHours: ttl, multi });
              useSession.setState({ share: r });
              setCreated({ token: r.invite.token, name });
            } catch {
              /* rien */
            }
            setBusy(false);
          }}
        >
          Créer le lien d’invitation
        </button>
        {!b.length && <span className="text-[11.5px] text-[rgb(var(--alert))]">Ouvre d’abord un accès ci-dessus (Internet, ou Wi-Fi) pour que le lien fonctionne chez les autres.</span>}
        {b.length > 0 && !s.ownerNameSet && <span className="text-[11.5px] text-white/45">Astuce : indique ton prénom tout en haut, tes invités le verront.</span>}
      </div>
      {created && (
        <div className="glass p-3 flex flex-col gap-2 anim-pop">
          <div className="hud text-[9.5px] text-white/70">Lien prêt · envoie-le{created.name ? ` à ${created.name}` : ''} (SMS, WhatsApp, e-mail…)</div>
          {b.length ? b.map((x) => <LinkRow key={x.url} base={x} token={created.token} name={created.name} />) : <div className="text-[12px] text-white/45">Ouvre un accès pour obtenir l’adresse du lien.</div>}
        </div>
      )}
    </div>
  );
}

function scopeLabel(sc?: Scope) {
  return !sc || sc.all ? 'tout' : sc.tags.map((t) => `#${t}`).join(' ');
}

function MemberRow({ m, online }: { m: MemberDetail; online: boolean }) {
  const [editScope, setEditScope] = useState(false);
  const previewAs = useSession((s) => s.previewAs);
  return (
    <div className="py-2.5 border-b border-white/[0.05] last:border-0">
      <div className="flex items-center gap-3">
        <span className={`w-7 h-7 rounded-full border flex items-center justify-center mono text-[9.5px] flex-none ${online ? 'border-white/60 text-white' : 'border-white/15 text-white/45'}`}>
          {m.initials}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-white/85 truncate">
            {m.name}
            {m.account && <span className="mono text-[9px] text-white/40 ml-2">COMPTE SYNAPSE</span>}
            {online && <span className="mono text-[9px] text-white/50 ml-2">● EN LIGNE</span>}
          </div>
          <div className="mono text-[9.5px] tracking-[0.08em] text-white/35">
            ZONE {scopeLabel(m.scope).toUpperCase()} · {m.lastSeen ? `VU ${fmtRelative(m.lastSeen - Date.now()).toUpperCase()}` : 'JAMAIS VU'}
          </div>
        </div>
        <select
          className="field !w-[130px] !py-1 !text-[11.5px]"
          value={m.role}
          onChange={(e) => void post('/api/members/update', { id: m.id, role: e.target.value })}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <button className="btn btn-ghost !px-2 !text-[9.5px]" onClick={() => setEditScope((x) => !x)}>
          Zone
        </button>
        <button
          className={`btn btn-ghost !px-2 !text-[9.5px] ${previewAs === m.id ? '!text-white' : ''}`}
          title="Le réseau n'affiche plus que ce que cette personne voit"
          onClick={() => useSession.setState({ previewAs: previewAs === m.id ? null : m.id, shareOpen: false })}
        >
          Voir comme
        </button>
        <button
          className="btn btn-danger btn-ghost !px-2 !text-[9.5px]"
          onClick={() => {
            if (window.confirm(`Retirer l’accès de ${m.name} ? Il sera déconnecté immédiatement.`)) void post('/api/members/revoke', { id: m.id });
          }}
        >
          Retirer
        </button>
      </div>
      {editScope && (
        <div className="pl-10 pt-3">
          <ScopePicker value={m.scope ?? { all: true, tags: [] }} onChange={(sc) => void post('/api/members/update', { id: m.id, scope: sc })} />
        </div>
      )}
    </div>
  );
}

function InviteRow({ inv, s }: { inv: Invite; s: ShareStatus }) {
  const [open, setOpen] = useState(false);
  const b = bases(s);
  return (
    <div className="py-2 border-b border-white/[0.05] last:border-0">
      <div className="flex items-center gap-3">
        <span className="mono text-[11px] text-white/70 flex-1 truncate">
          {inv.name || 'Sans nom'} · {ROLE_LABEL[inv.role]} · zone {scopeLabel(inv.scope)} · {inv.multi ? `${inv.uses} utilisation${inv.uses > 1 ? 's' : ''}` : 'usage unique'} ·{' '}
          {inv.expiresAt ? `expire ${fmtRelative(inv.expiresAt - Date.now())}` : 'sans limite'}
        </span>
        <button className="btn btn-ghost !px-2 !text-[9.5px]" onClick={() => setOpen((x) => !x)}>
          {open ? 'Masquer' : 'Lien'}
        </button>
        <button className="btn btn-danger btn-ghost !px-2 !text-[9.5px]" onClick={() => void post('/api/invites/revoke', { id: inv.id })}>
          Annuler
        </button>
      </div>
      {open && <div className="pt-2 flex flex-col gap-1.5">{b.length ? b.map((x) => <LinkRow key={x.url} base={x} token={inv.token} name={inv.name} />) : <span className="text-[11.5px] text-white/40">Aucun accès ouvert.</span>}</div>}
    </div>
  );
}

function Dialog() {
  const s = useSession((st) => st.share);
  const online = useSession((st) => st.online);
  const [ownerName, setOwnerName] = useState('');
  const [brainName, setBrainName] = useState('');
  useEffect(() => {
    api<ShareStatus>('/api/share')
      .then((st) => {
        useSession.setState({ share: st });
        setOwnerName(st.ownerNameSet ? st.ownerName : '');
        setBrainName(st.brainName);
      })
      .catch(() => {});
  }, []);
  const onlineIds = useMemo(() => new Set(online.map((p) => p.id)), [online]);
  const local = useSession((st) => st.local);
  const manage = !!s?.manageAccess && local;
  const close = () => useSession.setState({ shareOpen: false });
  return (
    <div className="fixed inset-0 z-50 anim-fade" data-ui>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={close} />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(900px,calc(100vw-32px))] max-h-[calc(100vh-32px)] overflow-y-auto overflow-x-hidden scroll-thin glass neon p-7 anim-pop">
        <Corners />
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="hud text-[11px] text-white/80">Partager ton cerveau</div>
            <div className="text-[13px] text-white/45 mt-1">Invite une ou plusieurs personnes : elles le voient en direct, et peuvent y contribuer si tu le veux.</div>
          </div>
          <button className="btn btn-ghost" onClick={close}>
            ✕ <span className="text-white/35 ml-1">Échap</span>
          </button>
        </div>
        {!s ? (
          <div className="mono text-[11px] text-white/40 mt-8">Chargement…</div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="xs-label">Ton prénom (vu par tes invités)</span>
                <input
                  className="field"
                  value={ownerName}
                  placeholder="Ton prénom"
                  maxLength={40}
                  onChange={(e) => setOwnerName(e.target.value)}
                  onBlur={() => void post('/api/share/settings', { ownerName })}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="xs-label">Nom du cerveau</span>
                <input
                  className="field"
                  value={brainName}
                  maxLength={60}
                  onChange={(e) => setBrainName(e.target.value)}
                  onBlur={() => void post('/api/share/settings', { brainName })}
                />
              </label>
            </div>

            {manage && (
              <>
                <div className="xs-label mt-7 mb-3">1 · Comment te rejoindre</div>
                <AccessCards s={s} />
                <div className="text-[11px] text-white/35 mt-2">
                  Tant qu’un accès est ouvert, Synapse reste allumé en arrière-plan même si tu fermes la fenêtre (il s’arrête après 6 h sans personne). Ton
                  ordinateur doit rester allumé et connecté. Tes invités n’ont rien à installer : un navigateur suffit.
                </div>
              </>
            )}

            <div className="xs-label mt-7 mb-3">{manage ? '2 · ' : ''}Inviter quelqu’un dans ton cerveau</div>
            <InviteForm s={s} />

            <div className="xs-label mt-7 mb-1">Personnes · {s.members.length}</div>
            {s.members.length === 0 ? (
              <div className="text-[12px] text-white/38 py-2">Personne pour l’instant.</div>
            ) : (
              s.members.map((m) => <MemberRow key={m.id} m={m} online={onlineIds.has(m.id)} />)
            )}

            {s.invites.length > 0 && (
              <>
                <div className="xs-label mt-6 mb-1">Invitations en attente · {s.invites.length}</div>
                {s.invites.map((inv) => (
                  <InviteRow key={inv.id} inv={inv} s={s} />
                ))}
              </>
            )}

            <div className="mt-7 pt-4 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-3">
              <div className="text-[11px] text-white/38 leading-relaxed max-w-[520px]">
                {manage ? (
                  <>
                    Ton cerveau est enregistré sur ce PC (dossier <span className="mono text-white/55">{s.dataDir}</span>), avec une sauvegarde par jour.
                  </>
                ) : (
                  'Ton cerveau est enregistré sur le serveur de Synapse, avec une sauvegarde par jour. Les personnes invitées le voient en direct.'
                )}
              </div>
              <div className={`flex gap-2 ${manage ? '' : 'hidden'}`}>
                <button className="btn" onClick={() => void api('/api/data-folder', {})}>
                  Ouvrir le dossier
                </button>
                <button
                  className="btn btn-danger"
                  style={cvar(ALERT_HEX)}
                  onClick={() => {
                    if (window.confirm('Fermer tous les accès et déconnecter tout le monde ? Les invitations et les membres restent, tu pourras rouvrir plus tard.'))
                      void post('/api/share/stop', {});
                  }}
                >
                  Arrêter tout partage
                </button>
              </div>
            </div>
            <div className="hud text-[9px] text-white/25 mt-4">
              <Kbd>Échap</Kbd> fermer
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function ShareDialog() {
  const open = useSession((s) => s.shareOpen);
  return open ? <Dialog /> : null;
}
