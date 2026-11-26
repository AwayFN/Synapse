import { useEffect, useState, type ReactNode } from 'react';
import type { Hello, InviteInfo, SignupInfo } from '../sync/boot';
import { api, ApiError, retrySync } from '../sync/client';
import { deName, ROLE_HINT_GUEST, ROLE_LABEL, useSession } from '../sync/session';
import { android, androidDownloadUrl, appInfo, isAndroidApp, openExternal } from '../sync/native';
import { PROTO, apiUrl, setApiBase, standalone } from '../sync/remote';
import { cleanAddress, findCentral, healthy, manualCentral, setManualCentral } from '../sync/central';
import { createPending } from '../sync/pending';
import { LEVEL, useBackLayer } from '../lib/back';
import { Corners, cvar } from './common';

/** Cet appareil s'est déjà connecté à Synapse (sinon, le premier écran propose de créer son compte) */
const KNOWN_KEY = 'synapse-appareil-connu';
const deviceKnown = () => {
  try {
    return localStorage.getItem(KNOWN_KEY) === '1';
  } catch {
    return false;
  }
};
export const rememberDevice = () => {
  try {
    localStorage.setItem(KNOWN_KEY, '1');
  } catch {
    /* pas grave */
  }
};

/** Écrans d'entrée : chargement, connexion, inscription, invitation, installation, maintenance… */
function Frame({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center p-6 overflow-y-auto">
      <div className="absolute inset-0 opacity-70 pointer-events-none" style={{ background: 'radial-gradient(ellipse at 50% 40%, rgb(255 46 136 / 0.06), transparent 60%)' }} />
      <div className={`relative ${wide ? 'w-[min(600px,100%)]' : 'w-[min(520px,100%)]'} glass neon p-8 anim-pop my-auto`}>
        <Corners />
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rotate-45 bg-[#ff2e88] shadow-[0_0_12px_#ff2e88]" />
          <span className="hud text-[14px] font-semibold tracking-[0.42em] text-white">Synapse</span>
        </div>
        {children}
      </div>
    </div>
  );
}

export function BootScreen() {
  return (
    <div className="fixed inset-0 bg-black flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-2.5 h-2.5 rotate-45 bg-[rgb(var(--pearl))] breathe shadow-[0_0_14px_rgb(var(--pearl)/0.7)]" />
        <span className="hud text-[10px] text-white/40">connexion au cerveau…</span>
      </div>
    </div>
  );
}

const errorOf = (e: unknown) => (e instanceof ApiError ? ((e.data as { error?: string; message?: string; minutes?: number; reason?: string }) ?? {}) : { error: 'network' });

function authMessage(e: unknown, creator: string): string {
  const d = errorOf(e) as { error?: string; message?: string; minutes?: number; reason?: string };
  switch (d.error) {
    case 'invalid':
      return 'Adresse e-mail ou mot de passe incorrect.';
    case 'locked':
      return `Trop d’essais : ce compte est bloqué ${d.minutes ?? 15} min.`;
    case 'suspended':
      return `Ce compte est suspendu. Contacte ${creator}.`;
    case 'maintenance':
      return 'Synapse est en maintenance : réessaie un peu plus tard.';
    case 'name':
      return 'Indique ton prénom.';
    case 'email':
      return 'Cette adresse e-mail n’est pas valable.';
    case 'password':
      return d.message || 'Mot de passe trop court (8 caractères au moins).';
    case 'terms':
      return 'Accepte les conditions pour continuer.';
    case 'exists':
      return 'Un compte existe déjà avec cette adresse. Connecte-toi plutôt.';
    case 'invitation':
      return `Pour créer un compte, il faut une invitation de ${creator}.`;
    case 'code':
      return d.reason === 'used' ? 'Cette invitation a déjà servi.' : d.reason === 'expired' ? 'Cette invitation a expiré.' : 'Cette invitation n’est pas valable.';
    case 'invite':
      return 'Ce lien d’invitation n’est plus valable.';
    case 'closed':
      return 'Les inscriptions sont fermées pour l’instant.';
    case 'full':
      return 'Ce serveur Synapse est complet pour l’instant.';
    case 'trop de tentatives':
      return 'Trop de tentatives : patiente quelques minutes.';
    case 'network':
      return 'Le serveur ne répond pas. Vérifie ta connexion.';
    default:
      return 'Ça n’a pas marché. Réessaie.';
  }
}

/** Conditions d'utilisation et confidentialité (texte choisi par le créateur) */
function Terms({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  useBackLayer(true, onClose, LEVEL.terms);
  useEffect(() => {
    api<{ text: string }>('/api/terms')
      .then((r) => setText(r.text))
      .catch(() => setText('Impossible de charger le texte.'));
  }, []);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-6 bg-black/70 backdrop-blur-sm anim-fade" onClick={onClose}>
      <div className="relative glass neon p-7 w-[min(620px,100%)] max-h-[80vh] overflow-y-auto scroll-thin" onClick={(e) => e.stopPropagation()}>
        <Corners />
        <div className="hud text-[10.5px] text-white/80">Conditions & confidentialité</div>
        <div className="text-[13px] text-white/70 mt-4 leading-relaxed whitespace-pre-wrap">{text ?? 'Chargement…'}</div>
        <button type="button" className="btn mt-6" onClick={onClose}>
          Fermer
        </button>
      </div>
    </div>
  );
}

/** Formulaire de connexion ou de création de compte (partagé par plusieurs écrans) */
function AccountForm({
  mode,
  hello,
  extra,
  onDone,
  submitLabel,
  offline = false,
}: {
  mode: 'login' | 'signup';
  hello: Hello;
  extra?: Record<string, unknown>;
  onDone: () => void | Promise<void>;
  submitLabel?: string;
  /** application Android sans Synapse central : le compte est créé ici, et enregistré dès qu'il répond */
  offline?: boolean;
}) {
  const creator = hello.server.creatorName || 'le créateur de Synapse';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [terms, setTerms] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  const signup = mode === 'signup';
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (signup && offline) {
        // mêmes règles que le serveur : il les vérifiera de nouveau à l'enregistrement
        if (!name.trim()) throw new ApiError(400, { error: 'name' });
        if (!/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/.test(email.trim().toLowerCase())) throw new ApiError(400, { error: 'email' });
        if (password.length < 8 || password.length > 200) throw new ApiError(400, { error: 'password' });
        createPending({ name, email, password });
      } else if (signup) await api('/api/auth/signup', { name, email, password, terms, ...extra });
      else await api('/api/auth/login', { email, password });
      rememberDevice();
      await onDone();
    } catch (e) {
      setError(authMessage(e, creator));
      setBusy(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {signup && (
        <label className="flex flex-col gap-1.5">
          <span className="xs-label">Ton prénom (les autres le verront)</span>
          <input className="field !text-[14px] !py-2" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="given-name" autoFocus />
        </label>
      )}
      <label className="flex flex-col gap-1.5">
        <span className="xs-label">Adresse e-mail</span>
        <input className="field !text-[14px] !py-2" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} autoComplete="email" autoFocus={!signup} />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="xs-label">Mot de passe{signup ? ' (8 caractères au moins)' : ''}</span>
        <input
          className="field !text-[14px] !py-2"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          maxLength={200}
          autoComplete={signup ? 'new-password' : 'current-password'}
        />
      </label>
      {signup && hello.server.terms && (
        <label className="flex items-start gap-2 text-[12px] text-white/60 cursor-pointer">
          <input type="checkbox" className="mt-[3px]" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
          <span>
            J’accepte les{' '}
            <button type="button" className="underline decoration-white/30 hover:text-white" onClick={() => setShowTerms(true)}>
              conditions et la confidentialité
            </button>{' '}
            de Synapse.
          </span>
        </label>
      )}
      {error && <div className="text-[12.5px] text-[rgb(var(--alert))]">{error}</div>}
      <button type="submit" className="btn btn-primary !py-2.5 !text-[11px] mt-1" disabled={busy || !email.trim() || !password || (signup && !name.trim())}>
        {busy ? 'Un instant…' : submitLabel || (signup ? 'Créer mon compte →' : 'Se connecter →')}
      </button>
      {!signup && (
        <button type="button" className="text-[11.5px] text-white/40 hover:text-white/70 text-left w-fit" onClick={() => setForgot((x) => !x)}>
          Mot de passe oublié ?
        </button>
      )}
      {forgot && (
        <div className="text-[12px] text-white/55 leading-relaxed">
          Demande à <span className="text-white/80">{creator}</span> un lien pour en choisir un nouveau : il le crée en un clic depuis l’espace admin.
        </div>
      )}
      {showTerms && <Terms onClose={() => setShowTerms(false)} />}
    </form>
  );
}

/** Lien complet collé, ou juste le code */
const codeFrom = (s: string) => {
  const m = s.match(/inscription=([A-Za-z0-9_-]+)/);
  return (m ? m[1] : s).trim();
};

/**
 * Application Android : le Synapse central ne répond pas (encore). On cherche en arrière-plan ; dès qu'il répond, on
 * le dit (et on peut continuer en ligne).
 */
function useCentralBack(active: boolean) {
  const [back, setBack] = useState(false);
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const tick = async () => {
      const url = await findCentral();
      if (stop) return;
      if (url && (await healthy(url)) === PROTO) setBack(true);
      else window.setTimeout(() => void tick(), 8000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [active]);
  return back;
}

/** Avancé : l'adresse d'un autre serveur Synapse (le sien, sur le même Wi-Fi ou chez un hébergeur) */
export function ServerAddress({ onSaved }: { onSaved?: () => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(manualCentral() || '');
  const [msg, setMsg] = useState<string | null>(null);
  if (!standalone()) return null;
  if (!open)
    return (
      <button type="button" className="text-[11.5px] text-white/35 hover:text-white/65 text-left w-fit mt-4" onClick={() => setOpen(true)}>
        Adresse du serveur (avancé)
      </button>
    );
  return (
    <form
      className="flex flex-col gap-2 mt-4 anim-pop"
      onSubmit={async (e) => {
        e.preventDefault();
        const v = value.trim();
        if (v && !cleanAddress(v)) return setMsg('Une adresse ressemble à https://synapse.exemple.fr ou http://192.168.1.20:5173');
        setMsg('Vérification…');
        if (v && !(await healthy(cleanAddress(v)!))) return setMsg('Aucun serveur Synapse ne répond à cette adresse.');
        setManualCentral(v || null);
        setMsg(v ? 'Enregistré.' : 'Retour au Synapse central (adresse publiée).');
        onSaved?.();
      }}
    >
      <span className="xs-label">Adresse du serveur Synapse</span>
      <div className="flex gap-2">
        <input className="field field-mono !text-[12px] flex-1 min-w-0" value={value} inputMode="url" autoCapitalize="off" spellCheck={false} placeholder="https://…" onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="btn flex-none">
          OK
        </button>
      </div>
      <span className="text-[11px] text-white/38 leading-relaxed">
        Laisse vide pour le Synapse central (recommandé : son adresse est retrouvée toute seule). Sur le même Wi-Fi, elle ressemble à http://192.168.1.20:5173.
      </span>
      {msg && <span className="text-[11.5px] text-white/60">{msg}</span>}
    </form>
  );
}

export function AuthScreen({
  hello,
  code: initialCode,
  codeInfo,
  linkError,
  offline = false,
}: {
  hello: Hello;
  code?: string;
  codeInfo?: SignupInfo;
  linkError?: boolean;
  /** application Android, Synapse central injoignable : on peut quand même créer son compte et commencer */
  offline?: boolean;
}) {
  const reg = hello.server.registration;
  const creator = hello.server.creatorName || 'le créateur';
  // un appareil qui n'est encore jamais venu : la première chose à faire, c'est créer son compte
  const fresh = !deviceKnown();
  const [tab, setTab] = useState<'login' | 'signup'>(initialCode || ((fresh || offline) && reg !== 'fermee') ? 'signup' : 'login');
  const [code, setCode] = useState(initialCode ?? '');
  const [info, setInfo] = useState<SignupInfo | undefined>(codeInfo);
  const back = useCentralBack(offline);
  const needCode = reg === 'invitation';
  const checkCode = async (raw: string) => {
    const c = codeFrom(raw);
    setCode(c);
    if (c.length < 10) return setInfo(undefined);
    setInfo(await api<SignupInfo>('/api/signup/info', { code: c }).catch(() => undefined));
  };
  const done = () => location.replace('/');
  const phoneBrowser = !isAndroidApp() && /Android/i.test(navigator.userAgent) && !!hello.server.depot;
  // sans réseau, la connexion à un compte existant attend le retour du Synapse central (il vérifie le mot de passe)
  useEffect(() => {
    if (back && tab === 'login') location.reload();
  }, [back, tab]);
  return (
    <Frame>
      <div className="hud text-[10px] text-[#00e5ff] mt-7">{fresh ? 'Bienvenue sur Synapse' : hello.server.name !== 'Synapse' ? hello.server.name : 'Ton second cerveau, en 3D'}</div>
      <div className="text-[22px] font-semibold tracking-tight text-white mt-1.5">{tab === 'signup' ? 'Crée ton compte' : 'Connecte-toi'}</div>
      <div className="text-[13.5px] text-white/60 mt-2 leading-relaxed">
        {tab === 'signup'
          ? 'Ton réseau personnel en 3D : projets, tâches, notes et emploi du temps, tous reliés. Avec ton compte, tu retrouves tout sur ton PC et ton téléphone, en direct.'
          : 'Avec ton e-mail et ton mot de passe : tu retrouves ton cerveau tel que tu l’as laissé, sur tous tes appareils.'}
      </div>
      {offline && !back && (
        <div className="glass p-3 mt-4 text-[12.5px] text-white/70 leading-relaxed border-[#ffb020]/35" data-offline-signup>
          <span className="hud text-[9.5px] text-[#ffb020]">Sans connexion au Synapse central</span>
          <br />
          {tab === 'signup'
            ? 'Il ne répond pas pour l’instant (l’ordinateur qui l’héberge est peut-être éteint, ou le téléphone n’a pas de réseau). Crée quand même ton compte : Synapse s’ouvre tout de suite, sur ce téléphone, et ton compte sera enregistré tout seul dès qu’il répond, avec tout ce que tu auras fait.'
            : 'Pour te connecter à un compte qui existe déjà, il faut que le Synapse central réponde (il vérifie ton mot de passe). Nouvel essai automatique toutes les quelques secondes.'}
        </div>
      )}
      {offline && back && (
        <div className="glass p-3 mt-4 text-[12.5px] text-white/70 leading-relaxed flex items-center gap-3 flex-wrap anim-pop">
          <span className="flex-1 min-w-[180px]">Le Synapse central répond de nouveau.</span>
          <button className="btn btn-primary" onClick={() => location.reload()}>
            Continuer en ligne →
          </button>
        </div>
      )}
      {linkError && (
        <div className="text-[12.5px] text-[rgb(var(--alert))] mt-4 leading-relaxed">
          Ce QR code a expiré ou a déjà servi (il ne marche qu’une fois, 10 minutes). Affiches-en un nouveau sur ton ordinateur : ton prénom en haut à droite, puis « Sur ton téléphone ».
        </div>
      )}
      <div className="seg w-fit mt-6">
        <button data-on={tab === 'signup' ? '1' : '0'} onClick={() => setTab('signup')}>
          Créer un compte
        </button>
        <button data-on={tab === 'login' ? '1' : '0'} onClick={() => setTab('login')}>
          J’ai déjà un compte
        </button>
      </div>
      <div className="mt-5">
        {offline && tab === 'login' ? (
          <div className="flex flex-col gap-3">
            <div className="text-[13px] text-white/55 leading-relaxed">Tu n’as pas encore de compte ? Crée-le dans l’onglet d’à côté : ça marche même sans réseau.</div>
            <div className="flex gap-2 flex-wrap">
              <button className="btn btn-primary" onClick={() => location.reload()}>
                Réessayer maintenant
              </button>
            </div>
            <ServerAddress onSaved={() => location.reload()} />
          </div>
        ) : offline && tab === 'signup' ? (
          <AccountForm mode="signup" hello={hello} offline onDone={done} submitLabel="Créer mon compte et commencer →" />
        ) : tab === 'login' ? (
          <AccountForm mode="login" hello={hello} onDone={done} />
        ) : reg === 'fermee' ? (
          <div className="text-[13px] text-white/60 leading-relaxed">Les inscriptions sont fermées pour l’instant. Reviens plus tard, ou demande à {creator}.</div>
        ) : (
          <div className="flex flex-col gap-4">
            {(needCode || initialCode) && (
              <div className="flex flex-col gap-1.5">
                <span className="xs-label">Invitation {needCode ? '(obligatoire)' : ''}</span>
                <input
                  className="field field-mono !text-[12px]"
                  value={code}
                  placeholder="Colle ici le lien d’invitation reçu"
                  onChange={(e) => void checkCode(e.target.value)}
                />
                {info?.ok ? (
                  <span className="text-[12px] text-white/60">
                    ✓ Invitation valable
                    {info.from && (
                      <>
                        {' '}
                        de <span className="text-white/85">{info.from}</span>
                      </>
                    )}
                    {info.note ? ` pour ${info.note}` : ''}
                  </span>
                ) : code && info ? (
                  <span className="text-[12px] text-[rgb(var(--alert))]">
                    {info.reason === 'used' ? 'Cette invitation a déjà servi.' : info.reason === 'expired' ? 'Cette invitation a expiré.' : info.reason === 'closed' ? 'Les inscriptions sont fermées.' : 'Invitation inconnue.'}
                  </span>
                ) : (
                  needCode && <span className="text-[11.5px] text-white/40">Pas d’invitation ? Demande-la à {creator}, ou à un ami qui a déjà Synapse.</span>
                )}
              </div>
            )}
            <AccountForm mode="signup" hello={hello} extra={code ? { code } : {}} onDone={done} />
          </div>
        )}
      </div>
      {phoneBrowser && (
        <a
          className="btn btn-primary mt-6 inline-flex"
          href={androidDownloadUrl(hello.server.depot!)}
          rel="noopener noreferrer"
          style={cvar('#39ff88')}
        >
          ↓ Télécharger l’application Android
        </a>
      )}
      {standalone() ? (
        <>
          {!offline && <ServerAddress onSaved={() => location.reload()} />}
          <div className="text-[11px] text-white/32 mt-6 leading-relaxed">
            Synapse marche sur ce téléphone, même sans réseau : ton cerveau y est gardé, et synchronisé avec ton compte sur le Synapse central
            {hello.server.creatorName ? <> {deName(hello.server.creatorName)}</> : null}{' '}
            dès qu’il répond. Avec ton compte, tu le retrouves aussi sur ton PC. Tu restes connecté jusqu’à « Se déconnecter ».
          </div>
        </>
      ) : (
        <div className="text-[11px] text-white/32 mt-6 leading-relaxed">
          Serveur Synapse de <span className="text-white/55">{hello.server.creatorName || 'son créateur'}</span>. Ton cerveau y est enregistré ; tu restes connecté sur cet
          appareil jusqu’à « Se déconnecter ». Tu peux exporter tes données ou supprimer ton compte quand tu veux.
        </div>
      )}
    </Frame>
  );
}

/**
 * L'ancien compte de ce PC (reconnu sans mot de passe dans les premières versions) choisit son e-mail et son mot
 * de passe, une seule fois : ensuite on se connecte comme partout, et on le retrouve sur son téléphone.
 */
export function ClaimScreen({ hello }: { hello: Hello }) {
  const [name, setName] = useState(hello.server.creatorName || '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/claim', { name, email, password });
      rememberDevice();
      location.replace('/');
    } catch (e) {
      setError(authMessage(e, 'le créateur'));
      setBusy(false);
    }
  };
  return (
    <Frame wide>
      <div className="hud text-[10px] text-[#00e5ff] mt-7">Nouvelle version · ton compte</div>
      <div className="text-[22px] font-semibold tracking-tight text-white mt-1.5">Choisis ton e-mail et ton mot de passe</div>
      <div className="text-[13.5px] text-white/60 mt-2 leading-relaxed">
        Ton cerveau reste tel quel. Désormais, on se connecte avec un compte, sur ce PC comme sur ton téléphone : tu restes connecté jusqu’à « Se déconnecter ».
      </div>
      <form
        className="mt-6 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="xs-label">Ton prénom</span>
          <input className="field !text-[14px] !py-2" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="given-name" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="xs-label">Adresse e-mail</span>
          <input className="field !text-[14px] !py-2" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} autoComplete="email" autoFocus />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="xs-label">Mot de passe (8 caractères au moins)</span>
          <input className="field !text-[14px] !py-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={200} autoComplete="new-password" />
        </label>
        {error && <div className="text-[12.5px] text-[rgb(var(--alert))]">{error}</div>}
        <button type="submit" className="btn btn-primary !py-2.5 !text-[11px] mt-1" disabled={busy || !name.trim() || !email.trim() || password.length < 8}>
          {busy ? 'Un instant…' : 'Enregistrer et continuer →'}
        </button>
      </form>
    </Frame>
  );
}

/**
 * Le serveur ne répond pas (Synapse central éteint, réseau coupé), ou c'est une autre version : on attend, et on
 * réessaie tout seul. Dans l'application Android, elle cherche aussi la nouvelle adresse du serveur.
 */
export function UnreachableScreen({ reason }: { reason: 'server' | 'version' | 'old-server' }) {
  const [tries, setTries] = useState(0);
  const inApp = standalone();
  useEffect(() => {
    // dans l'application Android, « version » veut dire : c'est l'application qu'il faut mettre à jour
    if (reason === 'version' && !inApp) return;
    // le serveur revient (ou le PC a relancé Synapse dans sa nouvelle version) : la page s'ouvre toute seule
    const t = window.setInterval(async () => {
      setTries((n) => n + 1);
      try {
        if (inApp) {
          const url = await findCentral();
          if (url && (await healthy(url)) === PROTO) location.reload();
          return;
        }
        const r = await fetch(apiUrl('/api/health'), { cache: 'no-store' });
        const j = r.ok ? ((await r.json()) as { proto?: number }) : null;
        if (j && (reason === 'server' || j.proto === PROTO)) location.reload();
      } catch {
        /* toujours pas */
      }
    }, inApp ? 8000 : 5000);
    return () => window.clearInterval(t);
  }, [reason, inApp]);
  const app = android();
  const depot = appInfo().depot;
  return (
    <Frame>
      <div className="hud text-[10px] text-[rgb(var(--alert))] mt-7">{reason === 'server' ? 'Connexion' : 'Mise à jour'}</div>
      <div className="text-[15px] text-white/75 mt-2 leading-relaxed">
        {reason === 'version'
          ? inApp
            ? 'Le Synapse central a été mis à jour : installe la nouvelle version de l’application (ton compte et tes données ne bougent pas).'
            : 'Le serveur Synapse vient d’être mis à jour : recharge la page pour utiliser la nouvelle version.'
          : reason === 'old-server'
            ? inApp
              ? 'Cette application est plus récente que le Synapse central : il doit être mis à jour (sur le PC du créateur, double-clic sur « Lancer Synapse »). Synapse s’ouvrira tout seul ensuite.'
              : 'Synapse a été mis à jour, mais l’ancienne version tourne encore sur l’ordinateur qui l’héberge. Sur ce PC : double-clique sur « Lancer Synapse » (la nouvelle version remplace l’ancienne). Cette page s’ouvrira toute seule.'
            : inApp
              ? 'Le Synapse central ne répond pas pour l’instant (l’ordinateur qui l’héberge est peut-être éteint, ou le téléphone n’a pas de réseau), et ton cerveau n’est pas encore sur ce téléphone. Nouvel essai automatique : Synapse s’ouvrira tout seul.'
              : 'Le serveur Synapse ne répond pas pour l’instant : l’ordinateur qui l’héberge est peut-être éteint, ou la connexion est coupée. Nouvel essai automatique toutes les 5 secondes.'}
      </div>
      {reason !== 'version' && tries > 0 && <div className="mono text-[10px] text-white/35 mt-3">Essai n° {tries + 1}…</div>}
      <div className="flex gap-2 mt-6 flex-wrap">
        {inApp && reason === 'version' && depot ? (
          <button className="btn btn-primary" onClick={() => openExternal(androidDownloadUrl(depot))}>
            ↓ Télécharger la nouvelle version
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => location.reload()}>
            {reason === 'version' ? 'Recharger' : 'Réessayer maintenant'}
          </button>
        )}
        {!inApp && app?.changeServer && (
          <button className="btn btn-ghost" onClick={() => app.changeServer?.()}>
            Changer de serveur
          </button>
        )}
      </div>
      <ServerAddress onSaved={() => location.reload()} />
    </Frame>
  );
}

/**
 * Nouvelle installation : avant tout, la personne crée son compte. C'est un compte normal (elle n'a pas
 * l'espace admin) ; sur cet ordinateur, elle est ensuite reconnue sans retaper son mot de passe.
 */
export function FirstRunScreen({ hello }: { hello: Hello }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('/api/auth/first', { name, email, password });
      rememberDevice();
      location.replace('/');
    } catch (e) {
      setError(authMessage(e, hello.server.creatorName || 'le créateur'));
      setBusy(false);
    }
  };
  return (
    <Frame wide>
      <div className="hud text-[10px] text-[#00e5ff] mt-7">Bienvenue · première ouverture</div>
      <div className="text-[24px] font-semibold tracking-tight text-white mt-1.5">Crée ton compte Synapse</div>
      <div className="text-[13.5px] text-white/60 mt-2 leading-relaxed">
        Synapse, c’est ton réseau personnel en 3D : tes projets, tes tâches, tes notes et ton emploi du temps, tous reliés. Ton cerveau est enregistré sur cet
        ordinateur. Ton compte te sert aussi à le retrouver sur ton téléphone, et à rejoindre le cerveau d’un ami. Tu restes connecté jusqu’à « Se déconnecter ».
      </div>
      <form
        className="mt-6 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="xs-label">Ton prénom (les autres le verront)</span>
          <input className="field !text-[14px] !py-2" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="given-name" autoFocus />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="xs-label">Adresse e-mail</span>
          <input className="field !text-[14px] !py-2" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={120} autoComplete="email" />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="xs-label">Mot de passe (8 caractères au moins)</span>
          <input className="field !text-[14px] !py-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={200} autoComplete="new-password" />
        </label>
        {error && <div className="text-[12.5px] text-[rgb(var(--alert))]">{error}</div>}
        <button type="submit" className="btn btn-primary !py-2.5 !text-[11px] mt-1" disabled={busy || !name.trim() || !email.trim() || password.length < 8}>
          {busy ? 'Un instant…' : 'Créer mon compte et commencer →'}
        </button>
      </form>
      <div className="text-[11px] text-white/35 mt-5 leading-relaxed">
        Un ami t’a envoyé un lien d’invitation ? Ouvre-le directement : il te mènera à son cerveau. Ton mot de passe n’est jamais enregistré en clair.
      </div>
    </Frame>
  );
}

const REASON: Record<string, string> = {
  used: 'Ce lien a déjà servi. Demande un nouveau lien à',
  expired: 'Ce lien a expiré. Demande un nouveau lien à',
  revoked: 'Ce lien a été annulé par',
  unknown: "Ce lien d'invitation n'est pas valable. Vérifie-le, ou demande-en un autre à",
  closed: "Ce cerveau n'est pas encore prêt à recevoir des invités. Réessaie dans un instant, ou contacte",
  maintenance: 'Synapse est en maintenance. Réessaie un peu plus tard, ou contacte',
};

/** Invitation à un cerveau : avec son compte Synapse (recommandé), ou juste un prénom */
export function JoinScreen({ token, info, hello }: { token: string; info: InviteInfo; hello: Hello }) {
  const [name, setName] = useState(info.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(info.ok ? null : info.reason ?? 'unknown');
  const [path, setPath] = useState<'choose' | 'signup' | 'login'>(info.back === 'account' && !hello.account ? 'login' : 'choose');
  useBackLayer(path !== 'choose', () => setPath('choose'), LEVEL.dialog);
  const owner = info.ownerName || 'son propriétaire';
  const account = hello.account;
  const go = () => location.replace(`/?cerveau=${encodeURIComponent(info.brainId || '')}`);
  const joinAsAccount = async () => {
    await api('/api/join', { token, asAccount: true });
    go();
  };
  const joinAsGuest = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api('/api/join', { token, name: name.trim() });
      rememberDevice();
      go();
    } catch (e) {
      const reason = (errorOf(e) as { error?: string }).error ?? 'unknown';
      setError(reason === 'trop de tentatives' ? 'unknown' : reason);
      setBusy(false);
    }
  };
  if (error) {
    return (
      <Frame>
        <div className="hud text-[10px] text-[rgb(var(--alert))] mt-7">Invitation</div>
        <div className="text-[15px] text-white/80 mt-2 leading-relaxed">
          {REASON[error] ?? REASON.unknown} <span className="text-white">{owner}</span>.
        </div>
      </Frame>
    );
  }
  // dans l'application Android, on entre avec son compte (une place « sans compte » vit dans un navigateur)
  const inApp = standalone();
  // il revient avec son lien (après un changement d'adresse, ou sur un autre appareil) : un seul bouton
  if (info.back === 'guest' && !account && !inApp) {
    return (
      <Frame>
        <div className="hud text-[10px] text-white/45 mt-7">Te revoilà</div>
        <div className="text-[22px] font-semibold tracking-tight text-white mt-1.5">{info.name || 'Bonjour'} !</div>
        <div className="text-[14px] text-white/60 mt-2 leading-relaxed">
          Tu reviens dans « {info.brainName} », le cerveau {deName(owner)}. Tu retrouves ta place : {ROLE_HINT_GUEST[info.role ?? 'lecture']}.
        </div>
        <button className="btn btn-primary !py-2.5 !text-[11px] mt-6" disabled={busy} onClick={() => void joinAsGuest()}>
          {busy ? 'Connexion…' : 'Revenir dans le cerveau →'}
        </button>
      </Frame>
    );
  }
  return (
    <Frame wide>
      <div className="hud text-[10px] text-white/45 mt-7">Invitation</div>
      <div className="text-[24px] font-semibold tracking-tight text-white mt-1.5">« {info.brainName} »</div>
      <div className="text-[14px] text-white/60 mt-2 leading-relaxed">
        <span className="text-white">{owner}</span> t’invite dans son second cerveau : ses projets, ses tâches, ses notes et son emploi du temps, reliés en un réseau 3D
        que tu explores en direct. Rien à installer.
      </div>
      <div className="mt-5 flex flex-col gap-2 text-[12.5px]">
        <div className="flex gap-3">
          <span className="xs-label w-[64px] pt-[2px] flex-none">Tu</span>
          <span className="text-white/75">
            <span className="hud text-[10px] text-white">{ROLE_LABEL[info.role ?? 'lecture']}</span> — {ROLE_HINT_GUEST[info.role ?? 'lecture']}.
          </span>
        </div>
      </div>
      {info.back === 'account' && !account && (
        <div className="text-[12.5px] text-white/60 mt-4">Tu as déjà ta place dans ce cerveau : connecte-toi avec ton compte pour la retrouver.</div>
      )}

      {account ? (
        <div className="mt-7 flex flex-col gap-3">
          <div className="text-[12.5px] text-white/55">
            Connecté en tant que <span className="text-white/85">{account.name || 'créateur'}</span>
            {account.email ? ` (${account.email})` : ''}.
          </div>
          <button className="btn btn-primary !py-2.5 !text-[11px]" onClick={() => void joinAsAccount().catch((e) => setError((errorOf(e) as { error?: string }).error ?? 'unknown'))}>
            Rejoindre avec mon compte →
          </button>
        </div>
      ) : path === 'choose' ? (
        <div className={`mt-7 grid gap-3 ${inApp ? 'grid-cols-1' : 'grid-cols-2 max-md:grid-cols-1'}`}>
          <div className="glass p-4 flex flex-col gap-2.5">
            <span className="hud text-[10px] text-white/85">Avec un compte Synapse</span>
            <span className="text-[12px] text-white/50 leading-relaxed flex-1">
              Recommandé : tu retrouves ce cerveau depuis n’importe quel appareil, et tu as aussi le tien.
            </span>
            {info.signup && (
              <button className="btn btn-primary !text-[10px]" onClick={() => setPath('signup')}>
                Créer mon compte
              </button>
            )}
            <button className="btn !text-[10px]" onClick={() => setPath('login')}>
              J’ai déjà un compte
            </button>
          </div>
          {!inApp && (
            <form
              className="glass p-4 flex flex-col gap-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                void joinAsGuest();
              }}
            >
              <span className="hud text-[10px] text-white/85">Juste entrer</span>
              <span className="text-[12px] text-white/50 leading-relaxed">Sans compte, avec ton prénom. Rien n’est enregistré sur ton appareil.</span>
              <input className="field !py-2" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Ton prénom" />
              <button type="submit" className="btn !text-[10px]" disabled={!name.trim() || busy}>
                {busy ? 'Connexion…' : 'Entrer →'}
              </button>
            </form>
          )}
        </div>
      ) : (
        <div className="mt-6">
          <AccountForm
            mode={path}
            hello={hello}
            extra={{ invite: token }}
            submitLabel={path === 'signup' ? 'Créer mon compte et entrer →' : 'Me connecter et entrer →'}
            onDone={async () => {
              if (path === 'login') await api('/api/join', { token, asAccount: true });
              go();
            }}
          />
          <button className="text-[11.5px] text-white/40 hover:text-white/70 mt-3" onClick={() => setPath('choose')}>
            ← autres façons d’entrer
          </button>
        </div>
      )}
      <div className="text-[11px] text-white/32 mt-6 leading-relaxed">
        Tu explores le cerveau {deName(owner)} en direct, tant qu’il le partage. Il peut retirer ton accès à tout moment.
      </div>
    </Frame>
  );
}

/** Mode hébergé : premier démarrage, création du compte créateur */
export function SetupScreen({ token }: { token: string | null }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!token) {
    return (
      <Frame>
        <div className="hud text-[10px] text-white/45 mt-7">Installation</div>
        <div className="text-[14px] text-white/70 mt-2 leading-relaxed">
          Ce serveur Synapse n’est pas encore installé. Son créateur doit ouvrir le lien d’installation affiché dans le journal du serveur (ligne « INSTALLATION »).
        </div>
      </Frame>
    );
  }
  return (
    <Frame>
      <div className="hud text-[10px] text-white/45 mt-7">Installation · compte créateur</div>
      <div className="text-[13.5px] text-white/60 mt-2 leading-relaxed">
        Bienvenue ! Ce compte aura tous les droits sur ce serveur : espace admin, inscriptions, réglages.
      </div>
      <form
        className="mt-5 flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api('/api/auth/setup', { token, name, email, password });
            location.replace('/');
          } catch (err) {
            setError(authMessage(err, 'l’hébergeur'));
            setBusy(false);
          }
        }}
      >
        <input className="field" placeholder="Ton prénom" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus />
        <input className="field" type="email" placeholder="Adresse e-mail" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        <input className="field" type="password" placeholder="Mot de passe (8 caractères au moins)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        {error && <div className="text-[12.5px] text-[rgb(var(--alert))]">{error}</div>}
        <button className="btn btn-primary !py-2.5" disabled={busy || !name.trim() || !email.trim() || password.length < 8}>
          Créer le compte créateur →
        </button>
      </form>
    </Frame>
  );
}

export function ResetScreen({ token, info }: { token: string; info: { ok: boolean; name?: string; email?: string } }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!info.ok) {
    return (
      <Frame>
        <div className="hud text-[10px] text-[rgb(var(--alert))] mt-7">Nouveau mot de passe</div>
        <div className="text-[14px] text-white/75 mt-2 leading-relaxed">Ce lien n’est plus valable (déjà utilisé, ou plus de 48 h). Demande-en un nouveau.</div>
        <button className="btn mt-6" onClick={() => location.replace('/')}>
          Aller à la connexion
        </button>
      </Frame>
    );
  }
  return (
    <Frame>
      <div className="hud text-[10px] text-white/45 mt-7">Nouveau mot de passe</div>
      <div className="text-[14px] text-white/65 mt-2">
        Pour <span className="text-white">{info.name}</span> <span className="text-white/40">({info.email})</span>
      </div>
      <form
        className="mt-5 flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (password !== again) return setError('Les deux mots de passe ne sont pas identiques.');
          setBusy(true);
          setError(null);
          try {
            await api('/api/auth/reset', { token, password });
            location.replace('/');
          } catch (err) {
            setError(authMessage(err, 'le créateur'));
            setBusy(false);
          }
        }}
      >
        <input className="field" type="password" placeholder="Nouveau mot de passe (8 caractères au moins)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus />
        <input className="field" type="password" placeholder="Encore une fois" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" />
        {error && <div className="text-[12.5px] text-[rgb(var(--alert))]">{error}</div>}
        <button className="btn btn-primary !py-2.5" disabled={busy || password.length < 8}>
          Enregistrer et entrer →
        </button>
      </form>
    </Frame>
  );
}

export function MaintenanceScreen({ hello }: { hello: Hello }) {
  const [login, setLogin] = useState(false);
  return (
    <Frame>
      <div className="hud text-[10px] text-white/45 mt-7">Maintenance</div>
      <div className="text-[15px] text-white/75 mt-2 leading-relaxed">
        Synapse fait une petite pause pour s’améliorer.{hello.server.maintenance ? ` ${hello.server.maintenance}` : ''}
      </div>
      <div className="flex gap-2 mt-6">
        <button className="btn" onClick={() => location.reload()}>
          Réessayer
        </button>
        {!hello.account && (
          <button className="btn btn-ghost" onClick={() => setLogin((x) => !x)}>
            Connexion de l’équipe
          </button>
        )}
      </div>
      {login && (
        <div className="mt-5">
          <AccountForm mode="login" hello={hello} onDone={() => location.replace('/')} />
        </div>
      )}
    </Frame>
  );
}

export function SuspendedScreen() {
  const creator = useSession.getState().server?.creatorName || 'le créateur de Synapse';
  return (
    <Frame>
      <div className="hud text-[10px] text-[rgb(var(--alert))] mt-7">Compte suspendu</div>
      <div className="text-[15px] text-white/75 mt-2 leading-relaxed">Ton compte est suspendu pour l’instant. Pour en savoir plus, contacte {creator}.</div>
      <button
        className="btn mt-6"
        onClick={() =>
          void api('/api/auth/logout', {})
            .catch(() => {})
            .then(() => location.replace('/'))
        }
      >
        Se déconnecter
      </button>
    </Frame>
  );
}

export function OfflineScreen({ ownerName }: { ownerName: string }) {
  return (
    <Frame>
      <div className="hud text-[10px] text-[rgb(var(--alert))] mt-7">Hors ligne</div>
      <div className="text-[15px] text-white/75 mt-2 leading-relaxed">
        Le cerveau <span className="text-white">{deName(ownerName || 'ton hôte')}</span> ne répond pas : son ordinateur est peut-être éteint, ou Synapse est fermé.
      </div>
      <button className="btn mt-6" onClick={() => location.reload()}>
        Réessayer
      </button>
    </Frame>
  );
}

function Blocker({ title, text, action, alert = true }: { title: string; text: string; action: ReactNode; alert?: boolean }) {
  return (
    <div className="fixed inset-0 z-[80] bg-black/85 backdrop-blur-md flex items-center justify-center p-6" data-ui>
      <div className="glass neon p-8 w-[min(480px,100%)] relative">
        <Corners />
        <div className={`hud text-[10px] ${alert ? 'text-[rgb(var(--alert))]' : 'text-white/60'}`}>{title}</div>
        <div className="text-[15px] text-white/75 mt-2 leading-relaxed">{text}</div>
        <div className="mt-6 flex gap-2">{action}</div>
      </div>
    </div>
  );
}

/** Application Android : le Synapse central a une autre version (pas de synchronisation tant que ce n'est pas réglé) */
function OutdatedBar() {
  const outdated = useSession((s) => s.outdated);
  const [hidden, setHidden] = useState(false);
  if (!outdated || hidden) return null;
  const depot = appInfo().depot;
  return (
    <div className="fixed left-1/2 -translate-x-1/2 top-[86px] max-md:top-[64px] z-[70] glass neon px-4 py-2.5 flex items-center gap-3 max-w-[min(620px,calc(100vw-24px))] anim-pop" data-ui style={cvar('#ffb020')}>
      <span className="text-[12px] text-white/80 leading-snug">
        {outdated === 'app'
          ? 'Une nouvelle version de Synapse est sortie : installe-la pour synchroniser de nouveau. Tout reste sur ce téléphone en attendant.'
          : 'Le Synapse central n’est pas encore à jour (sur le PC du créateur : « Lancer Synapse »). Tout reste sur ce téléphone en attendant.'}
      </span>
      {outdated === 'app' && depot && (
        <button className="btn btn-primary !py-1 !px-2 !text-[9.5px] flex-none" onClick={() => openExternal(androidDownloadUrl(depot))}>
          Télécharger
        </button>
      )}
      <button className="text-white/40 hover:text-white text-[12px] flex-none" onClick={() => setHidden(true)} aria-label="Fermer">
        ✕
      </button>
    </div>
  );
}

/** Bandeau et blocages dans l'application (connexion perdue, accès retiré, compte suspendu, maintenance…) */
export function SessionOverlay() {
  const mode = useSession((s) => s.mode);
  const role = useSession((s) => s.role);
  const ownerName = useSession((s) => s.ownerName);
  const account = useSession((s) => s.account);
  const message = useSession((s) => s.server?.maintenance);
  const home = (label = 'Retour à mon cerveau') => (
    <button className="btn" onClick={() => location.replace('/')}>
      {label}
    </button>
  );
  const inApp = standalone();
  if (mode === 'revoked' && role !== 'owner') {
    return (
      <Blocker
        title="Accès retiré"
        text={`${ownerName || 'Le propriétaire'} a retiré ton accès à ce cerveau (ou tu l’as quitté). Rien de son contenu n’est resté sur ${inApp ? 'ce téléphone' : 'ton ordinateur'}.`}
        action={home(account ? 'Retour à mon cerveau' : 'Fermer')}
      />
    );
  }
  if (mode === 'suspended') return <Blocker title="Compte suspendu" text="Ton compte vient d’être suspendu par l’équipe de Synapse." action={home('Fermer')} />;
  if (mode === 'deleted') return <Blocker title="Compte supprimé" text="Ce compte a été supprimé. Son cerveau sera effacé définitivement sous 30 jours." action={home('Fermer')} />;
  if (mode === 'loggedout')
    return <Blocker title="Déconnecté" text="Ta session s’est terminée (déconnexion depuis un autre appareil, ou nouveau mot de passe). Reconnecte-toi avec ton e-mail et ton mot de passe : tout est là." action={home('Se reconnecter')} alert={false} />;
  // application Android : Synapse continue sur le téléphone (maintenance, coupure) ; l'état est en haut à droite
  if (inApp) return <OutdatedBar />;
  if (mode === 'maintenance')
    return <Blocker title="Maintenance" text={`Synapse fait une petite pause pour s’améliorer.${message ? ` ${message}` : ''} La reconnexion se fera toute seule.`} action={home('Réessayer')} alert={false} />;
  if (mode !== 'offline' && mode !== 'closed' && mode !== 'connecting') return null;
  const text =
    mode === 'closed'
      ? `${ownerName || 'Le propriétaire'} a fermé le partage · nouvelle tentative régulière`
      : mode === 'connecting'
        ? 'Connexion au cerveau…'
        : role === 'owner'
          ? 'Reconnexion au serveur… · tes modifications sont gardées et partiront toutes seules'
          : `Connexion perdue avec le cerveau ${deName(ownerName || 'ton hôte')} · reconnexion…`;
  return (
    <div className="fixed left-1/2 -translate-x-1/2 top-[86px] z-[70] glass px-4 py-2 flex items-center gap-2.5 pointer-events-none" data-ui>
      <span className="w-1.5 h-1.5 rounded-full bg-[rgb(var(--alert))] breathe" />
      <span className="hud text-[9.5px] text-white/75">{text}</span>
    </div>
  );
}
