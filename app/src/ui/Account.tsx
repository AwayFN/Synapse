import { useState } from 'react';
import { api, ApiError, clientId, openBrain, pendingChanges } from '../sync/client';
import { deName, initialsOf, linkBases, ROLE_LABEL, SERVER_ROLE_LABEL, useSession } from '../sync/session';
import { android, androidDownloadUrl, isAndroidApp, openExternal, releasesUrl } from '../sync/native';
import { useUI } from '../store/ui';
import { ALERT_HEX } from '../lib/color';
import { Corners, cvar, Kbd } from './common';
import { QrCode } from './Qr';
import { JoinFriend, ReachButton, ShareSheetButton } from './Reach';

/** Se déconnecter (sur ce PC aussi) : il faudra se reconnecter avec son e-mail et son mot de passe */
export async function logout() {
  if (pendingChanges() > 0 && !window.confirm('Des modifications n’ont pas encore pu partir (connexion coupée). Se déconnecter quand même ? Elles seraient perdues.')) return;
  await api('/api/auth/logout', {}).catch(() => {});
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('synapse-attente-')) localStorage.removeItem(k);
  } catch {
    /* pas grave */
  }
  location.replace('/');
}

function copy(text: string) {
  return navigator.clipboard.writeText(text).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  });
}

export function CopyButton({ text, label = 'Copier' }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="btn !py-1 !px-2 !text-[9.5px] flex-none"
      onClick={async () => {
        await copy(text);
        setOk(true);
        window.setTimeout(() => setOk(false), 1600);
      }}
    >
      {ok ? '✓ Copié' : label}
    </button>
  );
}

const errText = (e: unknown, map: Record<string, string>) => {
  const code = e instanceof ApiError ? (e.data as { error?: string; message?: string })?.error : 'network';
  const msg = e instanceof ApiError ? (e.data as { message?: string })?.message : undefined;
  return msg || map[code ?? ''] || 'Ça n’a pas marché. Réessaie.';
};

/** HUD : mon compte (initiales), et l'espace admin (créateur et admins seulement) */
export function AccountChip() {
  const mode = useSession((s) => s.mode);
  const account = useSession((s) => s.account);
  const me = useSession((s) => s.me);
  const staff = useSession((s) => s.staff);
  if (mode === 'local') return null;
  const name = account ? account.name || 'Créateur' : me.name;
  const pending = (staff?.feedback ?? 0) + (staff?.errors ?? 0);
  return (
    <div className="flex items-center gap-2 pointer-events-auto" data-ui>
      {account?.staff && (
        <button
          className="glass neon hud text-[10px] text-white/80 hover:text-white px-3 py-2 flex items-center gap-2"
          title="Espace admin : utilisateurs, statistiques, retours, réglages"
          onClick={() => useSession.setState({ adminOpen: true })}
        >
          <span className="text-white">◈</span> <span className="max-md:hidden">Espace admin</span>
          {pending > 0 && <span className="mono text-[9px] px-1.5 rounded-full bg-[rgb(var(--alert)/0.25)] text-white">{pending}</span>}
        </button>
      )}
      <button className="glass flex items-center gap-2 pl-1.5 pr-3 py-1 max-md:pr-1.5 hover:border-white/20" title="Mon compte, mes cerveaux" onClick={() => useSession.setState({ accountOpen: true })}>
        <span className="w-6 h-6 rounded-full border border-white/50 flex items-center justify-center mono text-[9px] text-white/85">{initialsOf(name || '?')}</span>
        <span className="text-[11.5px] text-white/80 max-w-[140px] truncate max-md:hidden">{name}</span>
        <span className="text-white/35 text-[9px] max-md:hidden">▾</span>
      </button>
    </div>
  );
}

/** Annonce du créateur (bandeau discret, refermable) */
export function AnnouncementBar() {
  const a = useSession((s) => s.announcement);
  const [hidden, setHidden] = useState<string | null>(() => {
    try {
      return localStorage.getItem('synapse-annonce-vue');
    } catch {
      return null;
    }
  });
  if (!a || !a.text || hidden === a.id) return null;
  return (
    <div
      className={`fixed left-1/2 -translate-x-1/2 bottom-[118px] z-[60] glass ${a.level === 'important' ? 'neon' : ''} px-4 py-2 flex items-center gap-3 max-w-[min(680px,calc(100vw-32px))] anim-pop`}
      data-ui
    >
      <span className={`hud text-[9px] flex-none ${a.level === 'important' ? 'text-[rgb(var(--alert))]' : 'text-white/45'}`}>{a.level === 'important' ? 'Important' : 'Annonce'}</span>
      <span className="text-[12.5px] text-white/80">{a.text}</span>
      <button
        className="text-white/40 hover:text-white text-[12px] flex-none"
        onClick={() => {
          setHidden(a.id);
          try {
            localStorage.setItem('synapse-annonce-vue', a.id);
          } catch {
            /* pas grave */
          }
        }}
      >
        ✕
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-7">
      <div className="xs-label mb-3">{title}</div>
      {children}
    </div>
  );
}

function Brains() {
  const brains = useSession((s) => s.brains);
  const current = useSession((s) => s.brainId);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="flex flex-col">
      {brains.map((b) => (
        <div key={b.id} className="flex items-center gap-3 py-2 border-b border-white/[0.05] last:border-0">
          <span className={`w-2 h-2 rotate-45 flex-none ${b.id === current ? 'bg-[rgb(var(--pearl))] shadow-[0_0_8px_rgb(var(--pearl)/0.7)]' : 'border border-white/30'}`} />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-white/85 truncate">{b.mine ? 'Mon cerveau' : b.name}</div>
            <div className="mono text-[9.5px] tracking-[0.08em] text-white/35 uppercase">
              {b.mine ? b.name : `${deName(b.ownerName)} · ${ROLE_LABEL[b.role]}`}
              {b.id === current ? ' · ouvert' : ''}
            </div>
          </div>
          {b.id !== current && (
            <button className="btn !py-1 !px-2.5 !text-[9.5px]" onClick={() => void openBrain(b.id, b.mine)}>
              Ouvrir
            </button>
          )}
          {!b.mine && (
            <button
              className="btn btn-ghost btn-danger !px-2 !text-[9.5px]"
              disabled={busy === b.id}
              onClick={async () => {
                if (!window.confirm(`Quitter le cerveau ${deName(b.ownerName)} ? Il faudra une nouvelle invitation pour y revenir.`)) return;
                setBusy(b.id);
                await api('/api/account/leave', { b: b.id }).catch(() => {});
                if (b.id === current) location.replace('/');
                else useSession.setState((s) => ({ brains: s.brains.filter((x) => x.id !== b.id) }));
                setBusy(null);
              }}
            >
              Quitter
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function InviteFriend() {
  const invite = useSession((s) => s.server?.invite);
  const account = useSession((s) => s.account);
  const [note, setNote] = useState('');
  const [link, setLink] = useState<{ url: string; label: string } | null>(null);
  const [left, setLeft] = useState<number | null | undefined>(invite?.left);
  const [error, setError] = useState<string | null>(null);
  if (!invite) return <div className="text-[12px] text-white/40">Les invitations à Synapse sont fermées sur ce serveur.</div>;
  const message = link
    ? `${note ? `${note}, ` : ''}viens essayer Synapse, mon second cerveau en 3D : crée ton compte ici ${link.url}\nRien à installer, ça s’ouvre dans le navigateur (ordinateur ou téléphone).\n— ${account?.name || ''}`
    : '';
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12px] text-white/50 leading-relaxed">
        Ton ami crée son compte sur ton Synapse avec ce lien, et a aussitôt son propre cerveau (tu ne vois jamais ce qu’il écrit). Rien à installer : un
        navigateur suffit. Tu le vois dans la liste des utilisateurs (espace admin).
        {left != null && ` Il te reste ${left} invitation${left > 1 ? 's' : ''} ce mois-ci.`}
      </div>
      <input className="field !w-[260px] max-w-full" placeholder="Pour qui ? (facultatif)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} />
      <ReachButton
        label="Créer le lien d’inscription"
        kind="internet"
        disabled={left === 0}
        onReady={async (base) => {
          setError(null);
          try {
            const r = await api<{ token: string; left: number | null }>('/api/signup/invite', { note });
            setLeft(r.left);
            setLink({ url: `${base.url}/#inscription=${r.token}`, label: base.label });
          } catch (e) {
            setError(errText(e, { quota: 'Tu as utilisé toutes tes invitations du mois.', closed: 'Les inscriptions sont fermées.', invite: 'Seule l’équipe peut inviter sur ce serveur.' }));
          }
        }}
      />
      {error && <div className="text-[12px] text-[rgb(var(--alert))]">{error}</div>}
      {link && (
        <div className="glass p-3 flex flex-col gap-2 anim-pop" data-signup-ready>
          <div className="hud text-[9.5px] text-white/70">Lien prêt · valable 7 jours, pour une personne</div>
          <div className="flex items-center gap-2 flex-wrap">
            <input readOnly value={link.url} className="field field-mono !text-[11px] !py-1.5 flex-1 min-w-[160px]" onFocus={(e) => e.currentTarget.select()} />
            <CopyButton text={link.url} label="Copier le lien" />
            <CopyButton text={message} label="Copier un message" />
            <ShareSheetButton text={message} />
          </div>
          {link.label === 'Internet' && (
            <div className="text-[11px] text-white/38">Adresse gratuite : elle change quand Synapse redémarre sur ton PC. Ton ami garde son compte : il se reconnecte à la nouvelle adresse.</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * L'application Android : un QR code qui la télécharge (dernière version publiée sur GitHub). On l'installe, on
 * se connecte avec son e-mail et son mot de passe, et tout est synchronisé en direct avec le PC.
 */
function AndroidApp() {
  const depot = useSession((s) => s.server?.depot);
  const [show, setShow] = useState(false);
  if (isAndroidApp()) {
    const v = android()?.version?.();
    return (
      <div className="flex flex-col gap-2 text-[12px] text-white/55 leading-relaxed">
        <span>
          Tu es dans l’application Android{v ? ` (version ${v})` : ''}. Tout ce que tu fais ici apparaît en direct sur ton PC, et l’inverse.
        </span>
        {depot && (
          <button className="btn w-fit" onClick={() => openExternal(releasesUrl(depot))}>
            Voir les nouvelles versions
          </button>
        )}
      </div>
    );
  }
  if (!depot) return null;
  const url = androidDownloadUrl(depot);
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12px] text-white/50 leading-relaxed">
        Installe l’application Synapse sur ton téléphone Android, puis connecte-toi avec ton e-mail et ton mot de passe : tu retrouves tout, et ce que tu fais sur l’un
        apparaît aussitôt sur l’autre.
      </div>
      {!show ? (
        <button className="btn btn-primary w-fit" style={cvar('#39ff88')} onClick={() => setShow(true)}>
          ↓ Télécharger l’application Android
        </button>
      ) : (
        <div className="flex gap-5 items-start flex-wrap anim-pop">
          <QrCode text={url} size={168} label="QR code de téléchargement de l’application Android" />
          <div className="flex-1 min-w-[220px] flex flex-col gap-2 text-[12.5px] text-white/65 leading-relaxed">
            <span>1. Vise ce code avec l’appareil photo du téléphone, et touche le lien : le fichier « Synapse.apk » se télécharge.</span>
            <span>2. Ouvre-le. Android demande d’autoriser l’installation (« sources inconnues ») : autorise ton navigateur, puis Installer.</span>
            <span>3. Ouvre Synapse et connecte-toi avec ton compte.</span>
            <span className="mono text-[10px] text-white/35 break-all">{url}</span>
            <div className="flex gap-2 flex-wrap">
              <CopyButton text={url} label="Copier le lien" />
              <button className="btn btn-ghost !py-1 !px-2 !text-[9.5px]" onClick={() => openExternal(releasesUrl(depot))}>
                Page GitHub
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Ouvrir son propre Synapse sur son téléphone : un QR code à viser, valable 10 minutes, une seule fois */
function PhoneLink() {
  const [url, setUrl] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const make = async (base = linkBases()[0]) => {
    setError(null);
    if (!base) return;
    try {
      const r = await api<{ token: string }>('/api/account/device-link', {});
      setUrl(`${base.url}/#connexion=${r.token}`);
      setLabel(base.label);
    } catch {
      setError('Impossible pour l’instant. Réessaie.');
    }
  };
  if (isAndroidApp()) return null;
  if (!url) {
    return (
      <div className="flex flex-col gap-3">
        <div className="text-[12px] text-white/50 leading-relaxed">
          Sans installer l’application : un QR code à viser avec l’appareil photo, et ton cerveau s’ouvre dans le navigateur du téléphone, déjà connecté.
        </div>
        <ReachButton label="Afficher le QR code de connexion" kind="any" lanChoice primary={false} onReady={(base) => make(base)} />
        {error && <div className="text-[12px] text-[rgb(var(--alert))]">{error}</div>}
      </div>
    );
  }
  return (
    <div className="flex gap-5 items-start flex-wrap anim-pop">
      <QrCode text={url} size={188} label="QR code de connexion pour ton téléphone" />
      <div className="flex-1 min-w-[220px] flex flex-col gap-2.5 text-[12.5px] text-white/65 leading-relaxed">
        <span>
          Vise ce code avec l’appareil photo de ton téléphone, puis touche le lien qui apparaît : Synapse s’ouvre, déjà connecté à ton compte.
        </span>
        <span className="text-white/45">
          {label === 'Même Wi-Fi'
            ? 'Ton téléphone doit être connecté au même Wi-Fi que cet ordinateur.'
            : label === 'Internet'
              ? 'Marche partout (4G, autre Wi-Fi) tant que ton ordinateur est allumé.'
              : 'Marche partout où cette adresse est joignable.'}{' '}
          Valable 10 minutes, une seule fois. Ne l’envoie à personne : il ouvre ton compte.
        </span>
        <span className="text-white/40">Mieux : l’application Android (ci-dessus), qui garde ta connexion même quand l’adresse du serveur change.</span>
        <span className="mono text-[10px] text-white/35 break-all" data-qr-url>
          {url}
        </span>
        <div className="flex gap-2">
          <CopyButton text={url} label="Copier le lien" />
          <button className="btn btn-ghost !py-1 !px-2 !text-[9.5px]" onClick={() => void make()}>
            Nouveau code
          </button>
        </div>
      </div>
    </div>
  );
}

function Profile() {
  const account = useSession((s) => s.account)!;
  const [name, setName] = useState(account.name);
  const [email, setEmail] = useState(account.email);
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (body: Record<string, unknown>, okText: string) => {
    setMsg(null);
    try {
      const r = await api<{ account: typeof account }>('/api/account/update', body);
      useSession.setState({ account: r.account });
      setMsg({ ok: true, text: okText });
      setCurrent('');
      setPassword('');
    } catch (e) {
      setMsg({
        ok: false,
        text: errText(e, {
          name: 'Indique un prénom.',
          email: 'Adresse e-mail non valable (elle est nécessaire pour se connecter).',
          exists: 'Cette adresse est déjà utilisée par un autre compte.',
          current: 'Mot de passe actuel incorrect.',
          'email-first': 'Ajoute d’abord ton adresse e-mail.',
        }),
      });
    }
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="xs-label">Prénom</span>
          <input className="field" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onBlur={() => name !== account.name && void save({ name }, 'Prénom enregistré.')} />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="xs-label">E-mail (pour te connecter)</span>
          <input className="field" type="email" value={email} maxLength={120} onChange={(e) => setEmail(e.target.value)} onBlur={() => email !== account.email && void save({ email }, 'Adresse enregistrée.')} />
        </label>
      </div>
      <div className="flex items-end gap-2 flex-wrap">
        {account.hasPassword && (
          <label className="flex flex-col gap-1.5">
            <span className="xs-label">Mot de passe actuel</span>
            <input className="field !w-[190px]" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </label>
        )}
        <label className="flex flex-col gap-1.5">
          <span className="xs-label">{account.hasPassword ? 'Nouveau mot de passe' : 'Choisir un mot de passe'}</span>
          <input className="field !w-[190px]" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </label>
        <button className="btn" disabled={password.length < 8} onClick={() => void save({ password, current }, 'Mot de passe enregistré. Tes autres appareils sont déconnectés.')}>
          Enregistrer
        </button>
      </div>
      {!account.hasPassword && (
        <div className="text-[11.5px] text-white/40 leading-relaxed">
          Ajoute un e-mail et un mot de passe : ils servent à te reconnecter (après « Se déconnecter ») et à retrouver ton cerveau sur ton téléphone.
        </div>
      )}
      {msg && <div className={`text-[12px] ${msg.ok ? 'text-white/60' : 'text-[rgb(var(--alert))]'}`}>{msg.text}</div>}
    </div>
  );
}

function DangerZone() {
  const account = useSession((s) => s.account)!;
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2 flex-wrap">
        <button className="btn" data-logout onClick={() => void logout()}>
          Se déconnecter
        </button>
        <button
          className="btn btn-ghost"
          onClick={async () => {
            const r = await api<{ sessions: number }>('/api/account/logout-all', { clientId }).catch(() => null);
            if (r) useUI.getState().toast({ text: `${r.sessions} AUTRE${r.sessions > 1 ? 'S' : ''} SESSION${r.sessions > 1 ? 'S' : ''} FERMÉE${r.sessions > 1 ? 'S' : ''}` });
          }}
        >
          Déconnecter mes autres appareils
        </button>
        <button className="btn btn-ghost btn-danger" onClick={() => setOpen((x) => !x)}>
          Supprimer mon compte…
        </button>
      </div>
      {open && (
        <div className="glass p-4 flex flex-col gap-2.5 anim-pop">
          <div className="text-[12.5px] text-white/70 leading-relaxed">
            Ton compte et ton cerveau seront supprimés (effacement définitif sous 30 jours). Pense à exporter tes données avant (Ctrl K puis « Exporter »). Écris{' '}
            <span className="mono text-white">SUPPRIMER</span> pour confirmer.
          </div>
          <div className="flex gap-2 flex-wrap">
            <input className="field !w-[150px] field-mono" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="SUPPRIMER" />
            {account.hasPassword && (
              <input className="field !w-[190px]" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Ton mot de passe" />
            )}
            <button
              className="btn btn-danger"
              style={cvar(ALERT_HEX)}
              disabled={confirm !== 'SUPPRIMER'}
              onClick={async () => {
                setError(null);
                try {
                  await api('/api/account/delete', { confirm, password });
                  location.replace('/');
                } catch (e) {
                  setError(errText(e, { 'last-creator': 'Tu es le dernier admin : nomme d’abord un autre admin dans l’espace admin.', current: 'Mot de passe incorrect.' }));
                }
              }}
            >
              Supprimer définitivement
            </button>
          </div>
          {error && <div className="text-[12px] text-[rgb(var(--alert))]">{error}</div>}
        </div>
      )}
    </div>
  );
}

export function AccountPanel() {
  const open = useSession((s) => s.accountOpen);
  const account = useSession((s) => s.account);
  const server = useSession((s) => s.server);
  const ownerName = useSession((s) => s.ownerName);
  if (!open) return null;
  const close = () => useSession.setState({ accountOpen: false });
  return (
    <div className="fixed inset-0 z-50 anim-fade" data-ui>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={close} />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(760px,calc(100vw-32px))] max-h-[calc(100vh-32px)] overflow-y-auto overflow-x-hidden scroll-thin glass neon p-7 anim-pop">
        <Corners />
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="hud text-[11px] text-white/80">{account ? 'Mon compte' : 'Invité'}</div>
            <div className="text-[13px] text-white/45 mt-1">
              {account
                ? `${account.name || 'Créateur'}${account.email ? ` · ${account.email}` : ''} · ${SERVER_ROLE_LABEL[account.role]} de ${server?.name || 'Synapse'}`
                : `Tu explores le cerveau ${deName(ownerName || 'ton hôte')} sans compte.`}
            </div>
          </div>
          <button className="btn btn-ghost" onClick={close}>
            ✕ <span className="text-white/35 ml-1">Échap</span>
          </button>
        </div>

        <Section title={account ? 'Mes cerveaux' : 'Cerveaux ouverts'}>
          <Brains />
        </Section>

        <Section title="Rejoindre le cerveau d’un ami">
          <JoinFriend />
        </Section>

        {account && (
          <>
            <Section title={isAndroidApp() ? 'Application Android' : 'Sur ton téléphone'}>
              <div className="flex flex-col gap-6">
                <AndroidApp />
                <PhoneLink />
              </div>
            </Section>
            <Section title="Inviter un ami sur Synapse">
              <InviteFriend />
            </Section>
            <Section title="Profil">
              <Profile />
            </Section>
          </>
        )}

        <Section title="Un avis, une idée, un problème ?">
          <button className="btn" onClick={() => useSession.setState({ accountOpen: false, feedbackOpen: true })}>
            Écrire à l’équipe de Synapse
          </button>
        </Section>

        {account && (
          <Section title="Session">
            <DangerZone />
          </Section>
        )}
        <div className="hud text-[9px] text-white/25 mt-6">
          <Kbd>Échap</Kbd> fermer
        </div>
      </div>
    </div>
  );
}

const KINDS: { k: 'idee' | 'probleme' | 'autre'; label: string }[] = [
  { k: 'idee', label: 'Une idée' },
  { k: 'probleme', label: 'Un problème' },
  { k: 'autre', label: 'Autre chose' },
];

export function FeedbackDialog() {
  const open = useSession((s) => s.feedbackOpen);
  const [kind, setKind] = useState<'idee' | 'probleme' | 'autre'>('idee');
  const [text, setText] = useState('');
  const [state, setState] = useState<'edit' | 'sending' | 'sent' | 'error'>('edit');
  if (!open) return null;
  const close = () => {
    useSession.setState({ feedbackOpen: false });
    if (state === 'sent') {
      setText('');
      setState('edit');
    }
  };
  return (
    <div className="fixed inset-0 z-[55] anim-fade" data-ui>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={close} />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(560px,calc(100vw-32px))] glass neon p-7 anim-pop">
        <Corners />
        <div className="hud text-[11px] text-white/80">Écrire à l’équipe de Synapse</div>
        {state === 'sent' ? (
          <>
            <div className="text-[14px] text-white/70 mt-4 leading-relaxed">Merci ! Ton message est arrivé chez les admins de Synapse.</div>
            <button className="btn mt-6" onClick={close}>
              Fermer
            </button>
          </>
        ) : (
          <>
            <div className="seg w-fit mt-5">
              {KINDS.map((x) => (
                <button key={x.k} data-on={kind === x.k ? '1' : '0'} onClick={() => setKind(x.k)}>
                  {x.label}
                </button>
              ))}
            </div>
            <textarea
              className="field mt-4 !h-[140px] resize-none !text-[13px] leading-relaxed"
              value={text}
              maxLength={3000}
              autoFocus
              placeholder={kind === 'probleme' ? 'Que s’est-il passé ? Qu’attendais-tu ?' : kind === 'idee' ? 'Ce qui rendrait Synapse encore mieux…' : 'Ton message'}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="text-[11px] text-white/35 mt-2">Ton prénom et la vue ouverte accompagnent le message ; jamais le contenu de ton cerveau.</div>
            {state === 'error' && <div className="text-[12px] text-[rgb(var(--alert))] mt-2">Envoi impossible pour l’instant. Réessaie.</div>}
            <div className="flex gap-2 mt-5">
              <button
                className="btn btn-primary"
                disabled={text.trim().length < 3 || state === 'sending'}
                onClick={async () => {
                  setState('sending');
                  try {
                    await api('/api/feedback', { kind, text, view: useUI.getState().view });
                    setState('sent');
                  } catch {
                    setState('error');
                  }
                }}
              >
                Envoyer
              </button>
              <button className="btn btn-ghost" onClick={close}>
                Annuler
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
