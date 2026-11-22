import { useState } from 'react';
import { useSession } from '../sync/session';
import { canNativeShare, ensureReach, linkFrom, nativeShare, openLink, reachNow, toolReady, type Base, type ReachKind } from '../sync/reach';

/**
 * Un bouton qui s'occupe de tout : s'il n'existe encore aucune adresse où les autres peuvent te joindre,
 * il ouvre l'accès Internet (avec ton accord pour l'outil gratuit, une seule fois), puis fait son action.
 */
export function ReachButton({
  label,
  kind = 'internet',
  onReady,
  primary = true,
  lanChoice = false,
  disabled = false,
}: {
  label: string;
  kind?: ReachKind;
  onReady: (base: Base) => void | Promise<void>;
  primary?: boolean;
  /** proposer aussi « seulement chez moi (même Wi-Fi) » */
  lanChoice?: boolean;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<ReachKind | null>(null);
  const [needConsent, setNeedConsent] = useState(false);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const net = useSession((s) => s.share?.internet);
  const local = useSession((s) => s.local);
  const run = async (k: ReachKind, withConsent = consent) => {
    setError(null);
    setBusy(k);
    try {
      const r = await ensureReach(k, withConsent);
      if (r.ok) {
        setNeedConsent(false);
        await onReady(r.base);
      } else if ('need' in r) setNeedConsent(true);
      else setError(r.error);
    } catch {
      setError('Ça n’a pas marché. Réessaie.');
    }
    setBusy(null);
  };
  const opening = busy && local && !reachNow(busy);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2 flex-wrap">
        <button className={`btn ${primary ? 'btn-primary' : ''}`} disabled={disabled || !!busy || (needConsent && !consent)} onClick={() => void run(kind)}>
          {busy === kind || (busy && kind === 'any') ? 'Un instant…' : label}
        </button>
        {/* tant que l'accès Internet n'est pas ouvert : un lien qui ne marche que chez soi, sans rien télécharger */}
        {lanChoice && local && !reachNow('internet') && (
          <button className="btn btn-ghost !text-[9.5px]" disabled={disabled || !!busy} onClick={() => void run('lan')} title="Seulement pour quelqu’un connecté à ta box (même Wi-Fi)">
            {busy === 'lan' ? 'Ouverture…' : reachNow('lan') ? 'Lien pour le même Wi-Fi' : 'Seulement chez moi (même Wi-Fi)'}
          </button>
        )}
      </div>
      {needConsent && !toolReady() && (
        <div className="glass p-3 flex flex-col gap-2 anim-pop">
          <div className="text-[12px] text-white/65 leading-relaxed">
            Pour qu’un lien marche chez quelqu’un qui n’est pas chez toi, Synapse ouvre une adresse Internet sécurisée (https), gratuite, grâce à Cloudflare : ni compte,
            ni réglage de box.
          </div>
          <label className="flex items-start gap-2 text-[12px] text-white/70 cursor-pointer">
            <input type="checkbox" className="mt-[3px]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>
              J’accepte que Synapse télécharge une fois l’outil gratuit <span className="mono text-white/80">cloudflared</span> (~40 Mo, signé par Cloudflare, vérifié
              avant usage).
            </span>
          </label>
          <button className="btn btn-primary w-fit" disabled={!consent || !!busy} onClick={() => void run(kind === 'lan' ? 'internet' : kind, true)}>
            {busy ? 'Un instant…' : 'Accepter et continuer'}
          </button>
        </div>
      )}
      {opening && (
        <div className="text-[11.5px] text-white/55 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-[rgb(var(--pearl))] breathe" />
          {busy === 'lan'
            ? 'Ouverture de l’accès Wi-Fi… (Windows peut demander d’autoriser « Node.js » : choisis Autoriser)'
            : net?.state === 'downloading'
              ? `Téléchargement de l’outil Cloudflare… ${net.progress} %`
              : 'Ouverture de ton adresse Internet… (quelques secondes)'}
        </div>
      )}
      {error && <div className="text-[12px] text-[rgb(var(--alert))] leading-relaxed">{error}</div>}
    </div>
  );
}

/** « Envoyer… » : le menu de partage du téléphone (WhatsApp, SMS, e-mail…) */
export function ShareSheetButton({ text }: { text: string }) {
  if (!canNativeShare()) return null;
  return (
    <button className="btn !py-1 !px-2 !text-[9.5px] flex-none" onClick={() => void nativeShare(text)}>
      Envoyer…
    </button>
  );
}

/** Rejoindre le Synapse d'un ami : coller le lien (ou le message entier) qu'il a envoyé */
export function JoinFriend({ hint = true }: { hint?: boolean }) {
  const [text, setText] = useState('');
  const link = linkFrom(text);
  const bad = text.trim().length > 0 && !link;
  return (
    <div className="flex flex-col gap-2">
      {hint && (
        <div className="text-[12px] text-white/50 leading-relaxed">
          Un ami utilise Synapse ? Il t’envoie son lien d’invitation (il commence par https://). Ouvre-le, ou colle-le ici : son cerveau s’ouvre dans une nouvelle
          fenêtre, le tien reste ouvert.
        </div>
      )}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (link && !link.problem) {
            openLink(link.url);
            setText('');
          }
        }}
      >
        <input
          className="field field-mono !text-[11.5px] flex-1 min-w-0"
          placeholder="Colle ici le lien reçu"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Lien d’invitation reçu"
        />
        <button type="submit" className="btn btn-primary flex-none" disabled={!link || !!link.problem}>
          Rejoindre
        </button>
      </form>
      {bad && <div className="text-[11.5px] text-[rgb(var(--alert))]">Ce n’est pas un lien : il doit commencer par https:// (ou http://).</div>}
      {link?.problem && <div className="text-[11.5px] text-[rgb(var(--alert))] leading-relaxed">{link.problem}</div>}
    </div>
  );
}
