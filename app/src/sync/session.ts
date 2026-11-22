import { create } from 'zustand';

/**
 * Session de partage : qui je suis dans ce cerveau, avec quels droits, qui d'autre est là.
 * En mode « local » (pas de serveur, ou serveur d'une ancienne version) tout est permis, comme avant.
 */
export type Role = 'owner' | 'edition' | 'contribution' | 'lecture';
export type Mode = 'local' | 'connecting' | 'online' | 'offline' | 'closed' | 'revoked' | 'suspended' | 'deleted' | 'loggedout' | 'maintenance';

/** Rôle sur le serveur Synapse (pas dans un cerveau) */
export type ServerRole = 'createur' | 'admin' | 'membre';

export interface Account {
  id: string;
  name: string;
  email: string;
  role: ServerRole;
  hasPassword: boolean;
  brainId: string;
  createdAt: number;
  local: boolean;
  staff: boolean;
}

export interface BrainCard {
  id: string;
  name: string;
  ownerName: string;
  role: Role;
  mine: boolean;
}

export interface Announcement {
  id: string;
  text: string;
  level: 'info' | 'important';
}

export interface ServerInfo {
  hosted: boolean;
  name: string;
  registration: 'ouverte' | 'invitation' | 'fermee';
  setup: boolean;
  creatorName: string;
  maintenance: string | null;
  announcement: Announcement | null;
  terms: boolean;
  invite: { left: number | null } | null;
  publicUrl: string | null;
  internetUrl: string | null;
}

export const SERVER_ROLE_LABEL: Record<ServerRole, string> = { createur: 'créateur', admin: 'admin', membre: 'membre' };

export interface Scope {
  all: boolean;
  tags: string[];
}

export interface Member {
  id: string;
  name: string;
  initials: string;
  role: Role;
  scope?: Scope;
  revoked?: boolean;
  /** a rejoint avec son compte Synapse */
  account?: boolean;
}

export interface Presence {
  id: string;
  name: string;
  initials: string;
  role: Role;
  view: string;
  focus: string | null;
  editing: string | null;
  at: number;
}

export interface Invite {
  id: string;
  token: string;
  name: string;
  role: Role;
  scope: Scope;
  multi: boolean;
  uses: number;
  createdAt: number;
  expiresAt: number | null;
}

export interface MemberDetail extends Member {
  createdAt: number;
  lastSeen: number | null;
  inviteId: string | null;
}

export type NetState = 'off' | 'needs-consent' | 'downloading' | 'starting' | 'on' | 'error';

export interface ShareStatus {
  lan: { on: boolean; urls: string[]; error: string | null };
  internet: { state: NetState; url: string | null; error: string | null; progress: number; toolReady: boolean; fixed?: boolean };
  /** les accès Wi-Fi / Internet se règlent depuis ce cerveau (celui du PC qui fait tourner Synapse) */
  manageAccess?: boolean;
  brainId?: string;
  publicUrl?: string | null;
  invites: Invite[];
  members: MemberDetail[];
  ownerName: string;
  ownerNameSet: boolean;
  brainName: string;
  dataDir: string;
  online: string[];
}

export interface SessionState {
  mode: Mode;
  role: Role;
  me: { id: string; name: string; initials: string };
  scope: Scope;
  ownerName: string;
  brainName: string;
  members: Record<string, Member>;
  online: Presence[];
  share: ShareStatus | null;
  shareOpen: boolean;
  /** suivre la caméra d'un participant */
  following: string | null;
  /** propriétaire : voir le réseau comme le voit un invité */
  previewAs: string | null;
  /** neurone dont je suis en train d'écrire le texte (annoncé aux autres) */
  editing: string | null;
  /** V4 : mon compte Synapse, mes cerveaux, le serveur */
  account: Account | null;
  brains: BrainCard[];
  brainId: string | null;
  server: ServerInfo | null;
  /** ouvert sur le PC qui fait tourner Synapse */
  local: boolean;
  announcement: Announcement | null;
  /** espace créateur : ce qui attend (retours non lus, erreurs du jour) */
  staff: { feedback: number; errors: number; accounts: number } | null;
  adminOpen: boolean;
  accountOpen: boolean;
  feedbackOpen: boolean;
}

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'propriétaire',
  edition: 'édition',
  contribution: 'contribution',
  lecture: 'lecture',
};

export const ROLE_HINT: Record<Exclude<Role, 'owner'>, string> = {
  lecture: 'explore, cherche et lit tout ce que tu partages, sans rien modifier',
  contribution: 'ajoute ses propres pensées et les relie aux tiennes ; ne touche pas aux tiennes',
  edition: 'modifie, relie et range tout ce qu’il voit, comme toi (sauf le partage)',
};

/** Les mêmes rôles, expliqués à l'invité lui-même */
export const ROLE_HINT_GUEST: Record<Exclude<Role, 'owner'>, string> = {
  lecture: 'tu explores, cherches et lis tout ce qui est partagé, sans rien modifier',
  contribution: 'tu ajoutes tes propres pensées et tu les relies aux siennes ; tu ne modifies pas les siennes',
  edition: 'tu modifies, relies et ranges tout ce que tu vois, comme lui',
};

export const useSession = create<SessionState>(() => ({
  mode: 'local',
  role: 'owner',
  me: { id: 'owner', name: 'Moi', initials: 'MO' },
  scope: { all: true, tags: [] },
  ownerName: '',
  brainName: '',
  members: {},
  online: [],
  share: null,
  shareOpen: false,
  following: null,
  previewAs: null,
  editing: null,
  account: null,
  brains: [],
  brainId: null,
  server: null,
  local: false,
  announcement: null,
  staff: null,
  adminOpen: false,
  accountOpen: false,
  feedbackOpen: false,
}));

/** Adresse publique pour les liens (invitations, nouveau mot de passe) */
export function linkBases(): { label: string; url: string }[] {
  const s = useSession.getState();
  const out: { label: string; url: string }[] = [];
  const add = (label: string, url: string | null | undefined) => {
    if (url && !out.some((x) => x.url === url)) out.push({ label, url: url.replace(/\/+$/, '') });
  };
  if (s.local) {
    // sur le PC du créateur : les adresses des accès ouverts
    add('Adresse fixe', s.share?.internet.state === 'on' && s.share.internet.fixed ? s.share.internet.url : null);
    add('Internet', s.share?.internet.state === 'on' ? s.share.internet.url : s.server?.internetUrl);
    add('Adresse fixe', s.server?.publicUrl);
    for (const u of s.share?.lan.urls ?? []) add('Même Wi-Fi', u);
  } else add('Lien', location.origin);
  return out;
}

export const sessionMode = () => useSession.getState().mode;
export const isShared = () => useSession.getState().mode !== 'local';
export const meId = () => useSession.getState().me.id;
export const myRole = () => useSession.getState().role;

/** Nom d'un participant pour l'affichage (« moi » pour soi-même) */
export function memberName(id: string | undefined | null, opts?: { me?: boolean }): string {
  const s = useSession.getState();
  const who = id || 'owner';
  if (opts?.me !== false && who === s.me.id) return 'moi';
  if (who === 'owner') return s.ownerName || 'le propriétaire';
  return s.members[who]?.name || 'quelqu’un';
}

/** « de Léa », « d’Arthur » */
export function deName(name: string): string {
  return /^[aeiouyhàâäéèêëîïôöùûüœ]/i.test(name) ? `d’${name}` : `de ${name}`;
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2);
  return s.toUpperCase();
}
