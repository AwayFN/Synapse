import { useEffect, useState } from 'react';
import { dropPending, loginInstead, retryPending, updatePending, usePending } from '../sync/pending';
import { initialsOf } from '../sync/session';
import { apiUrl } from '../sync/remote';
import { LEVEL, useBackLayer } from '../lib/back';
import { fmtRelative } from '../lib/time';
import { Corners, cvar } from './common';
import { ServerAddress } from './Gate';

/**
 * Application Android : le compte créé sans réseau attend d'être enregistré sur le Synapse central. En haut à droite,
 * une pastille le dit (point orange) ; en la touchant : où on en est, et ce qu'il faut faire si le serveur a dit non
 * (adresse déjà utilisée, conditions à accepter…).
 */
export function PendingChip() {
  const pending = usePending((s) => s.pending);
  const state = usePending((s) => s.state);
  const error = usePending((s) => s.error);
  const [open, setOpen] = useState(false);
  // le Synapse central a répondu mais il faut faire quelque chose (accepter ses conditions, autre adresse…) :
  // on l'ouvre de soi-même, une fois par demande
  const action = state === 'error' && !!error && error !== 'maintenance' && error !== 'version';
  useEffect(() => {
    if (!action) return;
    const key = `synapse-attente-vu-${error}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch {
      /* pas grave */
    }
    setOpen(true);
  }, [action, error]);
  if (!pending) return null;
  const color = action ? '#ff4d6d' : '#ffb020';
  return (
    <>
      <button
        className="glass flex items-center gap-2 pl-1.5 pr-3 py-1 max-md:pr-2 hover:border-white/20 pointer-events-auto"
        title={action ? 'Ton compte attend une réponse de ta part' : 'Ton compte attend d’être enregistré sur le Synapse central'}
        onClick={() => setOpen(true)}
        data-ui
        data-pending-chip={action ? 'action' : 'attente'}
      >
        <span className="w-6 h-6 rounded-full border border-white/50 flex items-center justify-center mono text-[9px] text-white/85">{initialsOf(pending.name || '?')}</span>
        <span className="text-[11.5px] text-white/80 max-w-[140px] truncate max-md:hidden">{pending.name}</span>
        <span className="w-2 h-2 rounded-full flex-none breathe" style={{ background: color, boxShadow: `0 0 6px ${color}` }} />
        <span className="hud text-[9px] max-md:hidden" style={{ color }}>
          {action ? 'À compléter' : 'En attente'}
        </span>
      </button>
      {open && <PendingPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

function PendingPanel({ onClose }: { onClose: () => void }) {
  const { pending, state, error, next, central, message } = usePending();
  const now = useNow(1000);
  useBackLayer(true, onClose, LEVEL.dialog);
  if (!pending) return null;
  const status =
    state === 'trying'
      ? 'Enregistrement en cours…'
      : state === 'waiting'
        ? `Le Synapse central ne répond pas pour l’instant (l’ordinateur qui l’héberge est peut-être éteint, ou le téléphone n’a pas de réseau). Nouvel essai ${next > now ? fmtRelative(next - now) : 'dans un instant'}.`
        : '';
  return (
    <div className="fixed inset-0 z-50 anim-fade" data-ui>
      <div className="absolute inset-0 bg-black/55 backdrop-blur-sm" onClick={onClose} />
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(560px,calc(100vw-24px))] max-h-[calc(100vh-24px)] overflow-y-auto scroll-thin glass neon p-6 anim-pop" data-pending-panel>
        <Corners />
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="hud text-[11px] text-white/80">Ton compte</div>
            <div className="text-[13px] text-white/45 mt-1">
              {pending.name} · {pending.email}
            </div>
          </div>
          <button className="btn btn-ghost" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="glass p-3 mt-5 flex flex-col gap-2" style={cvar('#ffb020')}>
          <span className="hud text-[10px] text-[#ffb020]">{pending.registered ? 'Envoi de ton cerveau' : 'Compte en attente'}</span>
          <span className="text-[12.5px] text-white/65 leading-relaxed">
            Tu peux utiliser Synapse normalement : tout est gardé sur ce téléphone. {pending.registered ? 'Ton compte est créé ; ' : 'Ton compte sera créé sur le Synapse central '}
            {pending.registered ? 'ton cerveau partira ' : ''}dès qu’il répond, tout seul, avec tout ce que tu as fait ici. Ensuite, tu le retrouves sur ton PC en te connectant
            avec {pending.email}.
          </span>
          {status && <span className="text-[12px] text-white/50 leading-relaxed">{status}</span>}
          {state !== 'trying' && state !== 'error' && (
            <button className="btn w-fit !py-1 !text-[9.5px]" onClick={() => retryPending()}>
              Réessayer maintenant
            </button>
          )}
        </div>
        {state === 'error' && error && <Problem error={error} message={message} central={central} email={pending.email} />}
        <ServerAddress onSaved={() => retryPending()} />
        <div className="mt-6 pt-4 border-t border-white/[0.06]">
          <button
            className="text-[11.5px] text-white/35 hover:text-[rgb(var(--alert))]"
            onClick={() => {
              if (window.confirm('Abandonner ce compte en attente ? Tout ce que tu as fait sur ce téléphone depuis sera effacé, et tu reviendras à l’écran de création de compte.'))
                dropPending();
            }}
          >
            Abandonner ce compte et tout effacer…
          </button>
        </div>
      </div>
    </div>
  );
}

/** Le Synapse central a répondu, mais il a dit non : ce qu'il faut faire */
function Problem({ error, message, central, email }: { error: string; message: string; central: string | null; email: string }) {
  const [password, setPassword] = useState('');
  const [newEmail, setNewEmail] = useState(email);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [terms, setTerms] = useState<string | null>(null);
  // les conditions du Synapse central : affichées tout de suite (il répond, puisqu'il les demande)
  useEffect(() => {
    if (error !== 'terms' || !central) return;
    fetch(apiUrl('/api/terms'), { cache: 'no-store', credentials: 'omit', mode: 'cors' })
      .then((r) => r.json())
      .then((j: { text?: string }) => setTerms(j.text || ''))
      .catch(() => setTerms(null));
  }, [error, central]);
  const box = (title: string, children: React.ReactNode) => (
    <div className="glass p-4 mt-4 flex flex-col gap-2.5 anim-pop" data-pending-problem={error}>
      <span className="hud text-[10px] text-[rgb(var(--alert))]">{title}</span>
      {children}
      {msg && <span className="text-[12px] text-[rgb(var(--alert))]">{msg}</span>}
    </div>
  );
  if (error === 'exists') {
    return box(
      'Cette adresse a déjà un compte',
      <>
        <span className="text-[12.5px] text-white/65 leading-relaxed">
          Un compte existe déjà avec {email} sur le Synapse central. Si c’est le tien, connecte-toi : ce que tu as fait sur ce téléphone s’ajoutera à ton cerveau. Sinon,
          choisis une autre adresse.
        </span>
        <form
          className="flex gap-2 flex-wrap"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setMsg(await loginInstead(email, password));
            setBusy(false);
          }}
        >
          <input className="field !w-[200px] max-w-full" type="password" placeholder="Ton mot de passe" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          <button className="btn btn-primary" disabled={busy || !password}>
            {busy ? 'Un instant…' : 'Me connecter'}
          </button>
        </form>
        <form
          className="flex gap-2 flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (newEmail.trim() && newEmail.trim().toLowerCase() !== email) updatePending({ email: newEmail.trim().toLowerCase() });
          }}
        >
          <input className="field !w-[200px] max-w-full" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} autoComplete="email" />
          <button className="btn" disabled={!newEmail.trim() || newEmail.trim().toLowerCase() === email}>
            Utiliser cette adresse
          </button>
        </form>
      </>,
    );
  }
  if (error === 'terms') {
    return box(
      'Conditions à accepter',
      <>
        <span className="text-[12.5px] text-white/65 leading-relaxed">Le Synapse central demande d’accepter ses conditions d’utilisation et de confidentialité.</span>
        {terms !== null && <div className="text-[12px] text-white/60 leading-relaxed whitespace-pre-wrap max-h-[220px] overflow-y-auto scroll-thin border border-white/[0.07] p-2.5">{terms}</div>}
        <div className="flex gap-2 flex-wrap">
          {terms === null && central && (
            <button
              className="btn"
              onClick={async () => {
                try {
                  const r = await fetch(apiUrl('/api/terms'), { cache: 'no-store', credentials: 'omit', mode: 'cors' });
                  setTerms(((await r.json()) as { text?: string }).text || '');
                } catch {
                  setTerms('Impossible de charger le texte pour l’instant.');
                }
              }}
            >
              Lire les conditions
            </button>
          )}
          <button className="btn btn-primary" onClick={() => updatePending({ terms: true })}>
            J’accepte, créer mon compte
          </button>
        </div>
      </>,
    );
  }
  if (error === 'email' || error === 'name') {
    return box(
      error === 'email' ? 'Adresse e-mail refusée' : 'Prénom refusé',
      <form
        className="flex gap-2 flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (error === 'email') updatePending({ email: newEmail.trim().toLowerCase() });
        }}
      >
        {error === 'email' ? (
          <>
            <input className="field !w-[220px] max-w-full" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
            <button className="btn btn-primary">Réessayer avec cette adresse</button>
          </>
        ) : (
          <span className="text-[12.5px] text-white/65">Abandonne ce compte et recrée-le avec un autre prénom.</span>
        )}
      </form>,
    );
  }
  const text: Record<string, string> = {
    closed: 'Les inscriptions sont fermées sur ce Synapse central pour l’instant. Tout reste sur ce téléphone : demande au créateur de les rouvrir, puis réessaie.',
    invitation: 'Sur ce Synapse central, il faut une invitation pour créer un compte. Demande un lien d’inscription au créateur (ou à un ami), puis recrée ton compte avec ce lien.',
    full: 'Ce Synapse central est complet pour l’instant. Tout reste sur ce téléphone : réessaie plus tard.',
    maintenance: 'Le Synapse central est en maintenance : nouvel essai automatique dans une minute.',
    password: 'Le mot de passe n’a pas pu être gardé sur ce téléphone. Abandonne ce compte en attente et recrée-le (8 caractères au moins).',
    version:
      message === 'app'
        ? 'Le Synapse central a une version plus récente : installe la nouvelle version de l’application, puis tout repart.'
        : 'Le Synapse central n’est pas encore à jour (sur le PC du créateur : « Lancer Synapse »). Nouvel essai automatique.',
    other: message || 'Le Synapse central a refusé l’enregistrement. Réessaie plus tard.',
  };
  return box(
    'Le Synapse central a répondu',
    <>
      <span className="text-[12.5px] text-white/65 leading-relaxed">{text[error] ?? text.other}</span>
      {error !== 'password' && (
        <button className="btn w-fit !py-1 !text-[9.5px]" onClick={() => retryPending()}>
          Réessayer
        </button>
      )}
    </>,
  );
}
