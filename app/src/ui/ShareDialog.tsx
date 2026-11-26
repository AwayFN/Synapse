import { useEffect, useMemo, useState } from 'react';
import { api } from '../sync/client';
import { linkBases, ROLE_HINT, ROLE_LABEL, useSession, type Invite, type MemberDetail, type Role, type Scope, type ShareStatus } from '../sync/session';
import { fmtRelative } from '../lib/time';
import { ALERT_HEX } from '../lib/color';
import { Corners, cvar, Kbd } from './common';
import { QrCode } from './Qr';
import { useAllTags } from './TagBar';
import { ReachButton, ShareSheetButton } from './Reach';
import { copyText } from '../sync/native';

type GuestRole = Exclude<Role, 'owner'>;
const ROLES: GuestRole[] = ['edition', 'lecture'];
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
  const [ok, setOk] = useState<boolean | null>(null);
  return (
    <button
      className="btn !py-1 !px-2 !text-[9.5px] flex-none"
      onClick={async () => {
        // dans l'application Android, le presse-papiers du téléphone (fiable) ; sinon celui du navigateur
        setOk(await copyText(text));
        window.setTimeout(() => setOk(null), 1600);
      }}
    >
      {ok === true ? '✓ Copié' : ok === false ? 'Copie impossible' : label}
    </button>
  );
}

function LinkRow({ base, token, name, back }: { base: { label: string; url: string }; token: string; name?: string; back?: boolean }) {
  const link = `${base.url}/#invite=${token}`;
  const owner = useSession((s) => s.ownerName);
  const [qr, setQr] = useState(false);
  const message = back
    ? `${name ? `${name}, ` : ''}voici ton lien pour revenir dans mon cerveau Synapse (mon adresse a changé) : ${link}\n— ${owner}`
    : `${name ? `${name}, ` : ''}rejoins mon second cerveau Synapse : ${link}\nRien à installer, ça s’ouvre dans le navigateur (ordinateur ou téléphone).\n— ${owner}`;
  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-2 min-w-0 flex-wrap">
        <span className="xs-label w-[78px] flex-none">{base.label}</span>
        <input readOnly value={link} className="field field-mono !text-[11px] !py-1.5 flex-1 min-w-[160px]" onFocus={(e) => e.currentTarget.select()} />
        <CopyButton text={link} label="Copier le lien" />
        <CopyButton text={message} label="Copier un message" />
        <ShareSheetButton text={message} />
        <button className={`btn !py-1 !px-2 !text-[9.5px] flex-none ${qr ? '!text-white' : ''}`} title="Pour un téléphone : viser le code avec l'appareil photo" onClick={() => setQr((x) => !x)}>
          QR
        </button>
      </div>
      {qr && (
        <div className="flex items-center gap-4 pl-[86px] max-md:pl-0 anim-pop">
          <QrCode text={link} size={168} label="QR code de l'invitation" />
          <span className="text-[11.5px] text-white/50 leading-relaxed max-w-[260px]">
            La personne vise ce code avec l’appareil photo de son téléphone et touche le lien : elle entre dans ton cerveau.
          </span>
        </div>
      )}
    </div>
  );
}

/** Le choix demandé pour chaque invité : il peut modifier, ou seulement regarder */
function RoleSeg({ value, onChange }: { value: GuestRole; onChange: (r: GuestRole) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="seg w-fit" data-role-choice>
        {ROLES.map((r) => (
          <button key={r} data-on={value === r ? '1' : '0'} style={cvar(r === 'edition' ? '#39ff88' : '#00e5ff')} onClick={() => onChange(r)}>
            {r === 'edition' ? '✎ Peut modifier' : '◉ Peut seulement regarder'}
          </button>
        ))}
      </div>
      <div className="text-[11.5px] text-white/45">Il {ROLE_HINT[value]}.</div>
    </div>
  );
}

/** Ouvrir le serveur aux autres : même Wi-Fi, ou Internet (aussi dans l'espace admin) */
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
    <div className="grid grid-cols-2 max-md:grid-cols-1 gap-3">
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
          ) : net.retrying ? (
            <button className="facet breathe" data-on="1" title="Coupure : Synapse réessaie tout seul. Clique pour fermer l’accès." onClick={() => run('net', '/api/share/internet', { on: false })}>
              ◌ Reconnexion…
            </button>
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
            ? 'Ton adresse fixe, par ton tunnel Cloudflare (réglée dans l’espace admin, onglet Serveur).'
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

function InviteForm({ s, manage }: { s: ShareStatus; manage: boolean }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<GuestRole>('edition');
  const [ttl, setTtl] = useState(24 * 7);
  const [multi, setMulti] = useState(false);
  const [options, setOptions] = useState(false);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const b = bases(s);
  const create = async () => {
    setError(null);
    try {
      const r = await api<{ invite: { token: string } } & ShareStatus>('/api/invites', { name, role, ttlHours: ttl, multi });
      useSession.setState({ share: r });
      setCreated({ token: r.invite.token, name });
    } catch {
      setError('Le lien n’a pas pu être créé. Réessaie.');
    }
  };
  const ttlLabel = TTLS.find((x) => x.h === ttl)?.label ?? '';
  return (
    <div className="flex flex-col gap-3.5">
      <label className="flex flex-col gap-1.5 w-fit max-w-full">
        <span className="xs-label">Pour qui (facultatif)</span>
        <input className="field !w-[260px] max-w-full" placeholder="Son prénom" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="xs-label">Ce qu’il peut faire</span>
        <RoleSeg value={role} onChange={setRole} />
      </div>
      <div className="text-[11.5px] text-white/45 leading-relaxed">
        Lien valable {ttl ? ttlLabel : 'sans limite'} · {multi ? 'plusieurs personnes' : 'une personne'}.{' '}
        <button className="underline decoration-white/25 hover:text-white/80" onClick={() => setOptions((x) => !x)}>
          {options ? 'Masquer' : 'Changer'}
        </button>
      </div>
      {options && (
        <div className="grid grid-cols-[90px_1fr] max-md:grid-cols-1 gap-x-4 gap-y-4 items-start glass p-4 anim-pop">
          <span className="xs-label pt-2">Validité</span>
          <div className="flex flex-col gap-2">
            <div className="seg w-fit flex-wrap">
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
      )}
      <ReachButton label="Créer le lien d’invitation" kind={manage ? 'internet' : 'any'} lanChoice={manage} onReady={create} />
      {error && <div className="text-[12px] text-[rgb(var(--alert))]">{error}</div>}
      {created && (
        <div className="glass p-3 flex flex-col gap-2 anim-pop" data-invite-ready>
          <div className="hud text-[9.5px] text-white/70">Lien prêt · envoie-le{created.name ? ` à ${created.name}` : ''} (SMS, WhatsApp, e-mail…)</div>
          {b.length ? (
            b.map((x) => <LinkRow key={x.url} base={x} token={created.token} name={created.name} />)
          ) : (
            <div className="text-[12px] text-white/45">Ouvre un accès (plus bas) pour obtenir l’adresse du lien.</div>
          )}
          {!multi && <div className="text-[11px] text-white/38">Ce lien est pour une seule personne : elle pourra le rouvrir pour revenir, même depuis un autre appareil.</div>}
        </div>
      )}
    </div>
  );
}

function MemberRow({ m, online, s }: { m: MemberDetail; online: boolean; s: ShareStatus }) {
  const [showLink, setShowLink] = useState(false);
  const b = bases(s);
  return (
    <div className="py-2.5 border-b border-white/[0.05] last:border-0">
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`w-7 h-7 rounded-full border flex items-center justify-center mono text-[9.5px] flex-none ${online ? 'border-white/60 text-white' : 'border-white/15 text-white/45'}`}>
          {m.initials}
        </span>
        <div className="min-w-[150px] flex-1">
          <div className="text-[13px] text-white/85 truncate">
            {m.name}
            {m.account && <span className="mono text-[9px] text-white/40 ml-2">COMPTE SYNAPSE</span>}
            {online && <span className="mono text-[9px] text-white/50 ml-2">● EN LIGNE</span>}
          </div>
          <div className="mono text-[9.5px] tracking-[0.08em] text-white/35">{m.lastSeen ? `VU ${fmtRelative(m.lastSeen - Date.now()).toUpperCase()}` : 'JAMAIS VU'}</div>
        </div>
        <select
          className="field !w-[150px] !py-1 !text-[11.5px]"
          value={m.role}
          title="Ce qu’il peut faire dans ton cerveau"
          onChange={(e) => void post('/api/members/update', { id: m.id, role: e.target.value })}
        >
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        {m.link && (
          <button
            className={`btn btn-ghost !px-2 !text-[9.5px] ${showLink ? '!text-white' : ''}`}
            title="Son lien pour revenir (autre appareil, ou après un changement de ton adresse Internet)"
            onClick={() => setShowLink((x) => !x)}
          >
            Lien
          </button>
        )}
        <button
          className="btn btn-danger btn-ghost !px-2 !text-[9.5px]"
          onClick={() => {
            if (window.confirm(`Retirer l’accès de ${m.name} ? Il sera déconnecté immédiatement.`)) void post('/api/members/revoke', { id: m.id });
          }}
        >
          Retirer
        </button>
      </div>
      {showLink && m.link && (
        <div className="pl-10 max-md:pl-0 pt-3 flex flex-col gap-1.5 anim-pop">
          <div className="text-[11px] text-white/45">
            {m.account
              ? `${m.name} rouvre ce lien puis se connecte avec son compte Synapse.`
              : `${m.name} rouvre ce lien pour revenir à sa place (sur un autre appareil, ou quand ton adresse Internet a changé).`}
          </div>
          {b.length ? b.map((x) => <LinkRow key={x.url} base={x} token={m.link!} name={m.name} back />) : <span className="text-[11.5px] text-white/40">Ouvre un accès pour obtenir l’adresse du lien.</span>}
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
          {inv.name || 'Sans nom'} · {ROLE_LABEL[inv.role]} · {inv.multi ? `${inv.uses} utilisation${inv.uses > 1 ? 's' : ''}` : 'usage unique'} ·{' '}
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

/** L'adresse Internet gratuite a changé depuis le dernier démarrage : les anciens liens ne marchent plus */
export function addressChanged(s: ShareStatus | null): boolean {
  const n = s?.internet;
  return !!n && n.state === 'on' && !n.fixed && !!n.previous && !!n.url && n.previous !== n.url;
}

function AddressChanged({ s }: { s: ShareStatus }) {
  if (!addressChanged(s) || (!s.members.length && !s.invites.length)) return null;
  return (
    <div className="mt-6 glass p-4 flex flex-col gap-1.5 border-[rgb(var(--alert)/0.35)]" data-address-changed>
      <div className="hud text-[10px] text-[rgb(var(--alert))]">Ton adresse Internet a changé</div>
      <div className="text-[12px] text-white/60 leading-relaxed">
        Synapse a redémarré : la nouvelle adresse est <span className="mono text-white/80 break-all">{s.internet.url}</span>. Les anciens liens ne marchent plus.
        Renvoie à chacun son lien : bouton <span className="text-white/80">Lien</span> à côté de son nom ci-dessous (il revient à sa place, rien n’est perdu).
      </div>
    </div>
  );
}

function Dialog() {
  const s = useSession((st) => st.share);
  const online = useSession((st) => st.online);
  const [ownerName, setOwnerName] = useState('');
  const [brainName, setBrainName] = useState('');
  const [failed, setFailed] = useState(false);
  const mode = useSession((st) => st.mode);
  useEffect(() => {
    api<ShareStatus>('/api/share')
      .then((st) => {
        setFailed(false);
        useSession.setState({ share: st });
        setOwnerName(st.ownerNameSet ? st.ownerName : '');
        setBrainName(st.brainName);
      })
      .catch(() => setFailed(true));
    // (de nouveau quand la connexion revient)
  }, [mode === 'online']);
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
        {(failed || mode !== 'online') && (
          <div className="glass p-3 mt-6 text-[12.5px] text-white/65 leading-relaxed" data-share-offline>
            {failed && !s
              ? 'Pour inviter quelqu’un, Synapse doit joindre le Synapse central, qui ne répond pas pour l’instant (ordinateur éteint, ou pas de réseau). Réessaie dans un moment : tout le reste marche en attendant.'
              : 'Hors ligne pour l’instant : ce qui est affiché ici peut dater un peu, et les nouveaux liens attendront le retour de la connexion.'}
          </div>
        )}
        {!s ? (
          !failed && <div className="mono text-[11px] text-white/40 mt-8">Chargement…</div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-2 max-md:grid-cols-1 gap-4">
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

            {manage && <AddressChanged s={s} />}

            <div className="xs-label mt-7 mb-3">Inviter quelqu’un dans ton cerveau</div>
            <InviteForm s={s} manage={manage} />

            <div className="xs-label mt-7 mb-1">Personnes · {s.members.length}</div>
            {s.members.length === 0 ? (
              <div className="text-[12px] text-white/38 py-2">Personne pour l’instant : crée un lien ci-dessus et envoie-le.</div>
            ) : (
              s.members.map((m) => <MemberRow key={m.id} m={m} s={s} online={onlineIds.has(m.id)} />)
            )}

            {s.invites.length > 0 && (
              <>
                <div className="xs-label mt-6 mb-1">Invitations en attente · {s.invites.length}</div>
                {s.invites.map((inv) => (
                  <InviteRow key={inv.id} inv={inv} s={s} />
                ))}
              </>
            )}

            {manage && (
              <>
                <div className="xs-label mt-8 mb-3">Comment on te rejoint</div>
                <AccessCards s={s} />
                <div className="text-[11px] text-white/35 mt-2 leading-relaxed">
                  Tant qu’un accès est ouvert, Synapse reste allumé en arrière-plan, même fenêtre fermée, jusqu’à ce que tu éteignes l’ordinateur ou que tu cliques
                  « Arrêter tout partage » : tes amis peuvent venir quand ils veulent. Tes invités n’ont rien à installer, un navigateur suffit (ordinateur ou
                  téléphone).
                </div>
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
