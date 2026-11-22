import { useState } from 'react';
import { api, ApiError, clientId, openBrain } from '../sync/client';
import { deName, initialsOf, linkBases, ROLE_LABEL, SERVER_ROLE_LABEL, useSession } from '../sync/session';
import { useUI } from '../store/ui';
import { ALERT_HEX } from '../lib/kinds';
import { Corners, cvar, Kbd } from './common';

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

/** HUD : mon compte (initiales), et l'espace créateur pour l'équipe */
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
          title="Espace créateur : comptes, statistiques, retours, réglages"
          onClick={() => useSession.setState({ adminOpen: true })}
        >
          <span className="text-white">◈</span> Espace créateur
          {pending > 0 && <span className="mono text-[9px] px-1.5 rounded-full bg-[rgb(var(--alert)/0.25)] text-white">{pending}</span>}
        </button>
      )}
      <button className="glass flex items-center gap-2 pl-1.5 pr-3 py-1 hover:border-white/20" title="Mon compte, mes cerveaux" onClick={() => useSession.setState({ accountOpen: true })}>
        <span className="w-6 h-6 rounded-full border border-white/50 flex items-center justify-center mono text-[9px] text-white/85">{initialsOf(name || '?')}</span>
        <span className="text-[11.5px] text-white/80 max-w-[140px] truncate">{name}</span>
        <span className="text-white/35 text-[9px]">▾</span>
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
      <div className="text-[11px] text-white/35 mt-2">Pour rejoindre le cerveau de quelqu’un, ouvre le lien d’invitation qu’il t’envoie.</div>
    </div>
  );
}

function InviteFriend() {
  const invite = useSession((s) => s.server?.invite);
  const account = useSession((s) => s.account);
  const [note, setNote] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [left, setLeft] = useState<number | null | undefined>(invite?.left);
  const [error, setError] = useState<string | null>(null);
  if (!invite) return <div className="text-[12px] text-white/40">Les invitations à Synapse sont fermées sur ce serveur.</div>;
  const base = linkBases()[0];
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[12px] text-white/50 leading-relaxed">
        Ton ami crée son compte avec ce lien et a aussitôt son propre cerveau. Rien à installer : un navigateur suffit.
        {left != null && ` Il te reste ${left} invitation${left > 1 ? 's' : ''} ce mois-ci.`}
      </div>
      <div className="flex gap-2">
        <input className="field !w-[220px]" placeholder="Pour qui ? (facultatif)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={60} />
        <button
          className="btn btn-primary"
          disabled={left === 0}
          onClick={async () => {
            setError(null);
            // pas d'adresse joignable par les autres : inutile de créer (et de dépenser) une invitation
            if (!base) return setError('Aucune adresse publique pour l’instant : ouvre d’abord l’accès Internet (bouton Partager, ou espace créateur → Serveur).');
            try {
              const r = await api<{ token: string; left: number | null }>('/api/signup/invite', { note });
              setLeft(r.left);
              setLink(`${base.url}/#inscription=${r.token}`);
            } catch (e) {
              setError(errText(e, { quota: 'Tu as utilisé toutes tes invitations du mois.', closed: 'Les inscriptions sont fermées.', invite: 'Seule l’équipe peut inviter sur ce serveur.' }));
            }
          }}
        >
          Créer le lien
        </button>
      </div>
      {error && <div className="text-[12px] text-[rgb(var(--alert))]">{error}</div>}
      {link && (
        <div className="glass p-3 flex flex-col gap-2 anim-pop">
          <div className="hud text-[9.5px] text-white/70">Lien prêt · valable 7 jours, pour une personne</div>
          <div className="flex items-center gap-2">
            <input readOnly value={link} className="field field-mono !text-[11px] !py-1.5 flex-1 min-w-0" onFocus={(e) => e.currentTarget.select()} />
            <CopyButton text={link} label="Copier le lien" />
            <CopyButton
              text={`${note ? `${note}, ` : ''}viens essayer Synapse, mon second cerveau en 3D : crée ton compte ici ${link}\n— ${account?.name || ''}`}
              label="Copier un message"
            />
          </div>
          {base?.label === 'Internet' && <div className="text-[11px] text-white/38">Adresse temporaire : elle change si Synapse redémarre sur ton PC.</div>}
        </div>
      )}
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
        {account.hasPassword && !account.local && (
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
      {account.local && !account.hasPassword && (
        <div className="text-[11.5px] text-white/40 leading-relaxed">
          Sur ce PC, tu es reconnu automatiquement. Ajoute un e-mail et un mot de passe pour te connecter aussi depuis ton téléphone ou un autre ordinateur (par
          l’adresse Internet).
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
        {!account.local && (
          <button
            className="btn"
            onClick={() =>
              void api('/api/auth/logout', {})
                .catch(() => {})
                .then(() => location.replace('/'))
            }
          >
            Se déconnecter
          </button>
        )}
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
            {account.hasPassword && !account.local && (
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
                  setError(errText(e, { 'last-creator': 'Tu es le seul créateur : nomme d’abord un autre créateur dans l’espace créateur.', current: 'Mot de passe incorrect.' }));
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

        {account && (
          <>
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
            <div className="text-[14px] text-white/70 mt-4 leading-relaxed">Merci ! Ton message est arrivé dans l’espace créateur.</div>
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
