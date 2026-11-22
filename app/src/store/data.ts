import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Activity, Entity, Link, LinkOrigin, Nature, Status } from '../types';
import { STATUS_LABEL } from '../types';
import { uid } from '../lib/random';
import { builtinKind, isHubKind, kindKey, kindLabel, natureOfKind, type KindRegistry } from '../lib/kinds';
import { displayTitle } from '../lib/entity';
import { debouncedStorage } from './storage';
import { fx } from './fx';
import { buildSeed } from './seed';
import { migrateV1, V1_BACKUP_KEY } from './migrate';
import { findLink } from './graph';
import { meId } from '../sync/session';

export { displayTitle } from '../lib/entity';

export interface Snapshot {
  entity: Entity;
  links: Link[];
}

export interface CreateOpts {
  /** neurones à relier au nouveau */
  linkTo?: string[];
  /** où le faire naître dans l'espace */
  near?: string | null;
  origin?: LinkOrigin;
  strength?: number;
  /** pas d'entrée dans le journal */
  quiet?: boolean;
}

export type Patch = Partial<Omit<Entity, 'id' | 'createdAt'>>;

export interface DataState {
  entities: Record<string, Entity>;
  links: Link[];
  activity: Activity[];
  /** genres inventés par l'utilisateur, ou nature changée d'un genre prédéfini */
  kinds: KindRegistry;

  create: (input?: Patch, opts?: CreateOpts) => Entity;
  update: (id: string, patch: Patch) => void;
  /** a été vu / traversé : ravive sa vitalité sans le marquer modifié */
  touch: (id: string) => void;
  setStatus: (id: string, status: Status | null) => void;
  /** Kanban : poser dans la colonne `status`, avant `beforeId` (ou à la fin) */
  moveCard: (id: string, status: Status, beforeId: string | null) => void;
  remove: (id: string, opts?: { silent?: boolean }) => Snapshot | null;
  restore: (snap: Snapshot) => void;
  link: (a: string, b: string, opts?: { origin?: LinkOrigin; strength?: number; quiet?: boolean }) => boolean;
  unlink: (a: string, b: string) => void;
  /** une connexion empruntée se renforce (apprentissage hebbien) */
  strengthen: (a: string, b: string, amount?: number) => void;
  setKindNature: (kind: string, nature: Nature) => void;
  clearSeed: () => number;
  replaceAll: (data: { entities: Record<string, Entity>; links: Link[]; kinds: KindRegistry }) => void;
  /** `refs` : les neurones concernés (le journal n'en montre rien aux invités qui ne les voient pas) */
  log: (text: string, tone: Activity['tone'], refs?: Entity | (Entity | undefined)[]) => void;
}

const now = () => Date.now();

function nextOrder(entities: Record<string, Entity>, status: Status): number {
  let max = 0;
  for (const e of Object.values(entities)) if (e.status === status) max = Math.max(max, e.order);
  return max + 1;
}

/** Un genre inventé entre dans le registre (nature « pensée » tant qu'on ne la change pas) */
function withKind(reg: KindRegistry, kind: string): KindRegistry {
  if (!kind || builtinKind(kind) || reg[kindKey(kind)]) return reg;
  return { ...reg, [kindKey(kind)]: { label: kind, nature: 'pensee' } };
}

export const useData = create<DataState>()(
  persist(
    (set, get) => {
      const log = (text: string, tone: Activity['tone'], refs?: Entity | (Entity | undefined)[]) => {
        const list = (Array.isArray(refs) ? refs : refs ? [refs] : []).filter((x): x is Entity => !!x);
        const item: Activity = { id: uid(), at: now(), text, tone, by: meId() };
        if (list.length) {
          item.entityId = list[0].id;
          item.refs = list.map((x) => x.id);
          if (list.some((x) => x.private)) item.priv = true;
          const tags = [...new Set(list.flatMap((x) => x.tags))];
          if (tags.length) item.tags = tags;
        }
        set((s) => ({ activity: [item, ...s.activity].slice(0, 60) }));
      };
      const toneOf = (e: Entity) => natureOfKind(e.kind, get().kinds);
      const initial = buildSeed();

      return {
        entities: initial.entities,
        links: initial.links,
        activity: [{ id: uid(), at: now(), text: 'SECOND CERVEAU INITIALISÉ', tone: 'system' }],
        kinds: {},
        log,

        create: (input = {}, opts) => {
          const t = now();
          const e: Entity = {
            id: uid(),
            title: '',
            body: '',
            kind: '',
            tags: [],
            status: null,
            when: null,
            due: null,
            pinned: false,
            order: 0,
            createdAt: t,
            updatedAt: t,
            touchedAt: t,
            doneAt: null,
            createdBy: meId(),
            updatedBy: meId(),
            ...input,
          };
          if (e.status && input.order === undefined) e.order = nextOrder(get().entities, e.status);
          if (e.status === 'done' && !e.doneAt) e.doneAt = t;
          const linkTo = [...new Set(opts?.linkTo ?? [])].filter((id) => id !== e.id);
          set((s) => {
            const links = [...s.links];
            for (const other of linkTo) {
              if (!s.entities[other]) continue;
              links.push({ id: uid(), a: e.id, b: other, createdAt: t, strength: opts?.strength ?? 0.5, usedAt: t, origin: opts?.origin ?? 'manuel', createdBy: meId() });
            }
            return { entities: { ...s.entities, [e.id]: e }, links, kinds: withKind(s.kinds, e.kind) };
          });
          fx.emit({ kind: 'birth', id: e.id, near: opts?.near ?? linkTo[0] ?? null });
          if (!opts?.quiet) log(`+ ${kindLabel(e.kind).toUpperCase()}  ${displayTitle(e)}`, toneOf(e), e);
          return e;
        },

        update: (id, patch) => {
          const s = get();
          const e = s.entities[id];
          if (!e) return;
          const t = now();
          const next: Entity = { ...e, ...patch, updatedAt: t, touchedAt: t, updatedBy: meId() };
          if ('kind' in patch && patch.kind !== e.kind) {
            const def = builtinKind(next.kind);
            if (def?.status && !next.status) next.status = def.hub ? 'doing' : 'todo';
          }
          const statusChanged = next.status !== e.status;
          if (statusChanged) {
            if (next.status && !('order' in patch)) next.order = nextOrder(s.entities, next.status);
            next.doneAt = next.status === 'done' ? t : null;
          }
          set((st) => ({ entities: { ...st.entities, [id]: next }, kinds: withKind(st.kinds, next.kind) }));
          if (statusChanged && next.status === 'done') {
            fx.emit({ kind: 'celebrate', id });
            log(`✓ ACCOMPLI  ${displayTitle(next)}`, toneOf(next), next);
          } else if (statusChanged && next.status) {
            fx.emit({ kind: 'touch', id });
            log(`→ ${STATUS_LABEL[next.status].toUpperCase()}  ${displayTitle(next)}`, toneOf(next), next);
          } else {
            fx.emit({ kind: 'touch', id });
          }
        },

        touch: (id) => {
          const e = get().entities[id];
          if (!e || now() - e.touchedAt < 20000) return;
          set((s) => ({ entities: { ...s.entities, [id]: { ...e, touchedAt: now() } } }));
        },

        setStatus: (id, status) => get().update(id, { status }),

        moveCard: (id, status, beforeId) => {
          const t = get().entities[id];
          if (!t) return;
          const col = Object.values(get().entities)
            .filter((e) => e.status === status && e.id !== id && !isHubKind(e.kind))
            .sort((a, b) => a.order - b.order);
          let order: number;
          const idx = beforeId ? col.findIndex((x) => x.id === beforeId) : -1;
          if (idx === -1) order = (col[col.length - 1]?.order ?? 0) + 1;
          else if (idx === 0) order = col[0].order - 1;
          else order = (col[idx - 1].order + col[idx].order) / 2;
          get().update(id, { status, order });
        },

        remove: (id, opts) => {
          const s = get();
          const e = s.entities[id];
          if (!e) return null;
          const links = s.links.filter((l) => l.a === id || l.b === id);
          fx.emit({ kind: 'death', id });
          const entities = { ...s.entities };
          delete entities[id];
          set({ entities, links: s.links.filter((l) => l.a !== id && l.b !== id) });
          if (opts?.silent) {
            // brouillon vide abandonné : aucune trace dans le journal
            set((st) => ({ activity: st.activity.filter((a) => a.entityId !== id) }));
          } else {
            log(`− SUPPRIMÉ  ${displayTitle(e)}`, 'alert', e);
          }
          return { entity: e, links };
        },

        restore: (snap) => {
          set((s) => {
            const entities = { ...s.entities, [snap.entity.id]: snap.entity };
            const links = [
              ...s.links,
              ...snap.links.filter((l) => entities[l.a] && entities[l.b] && !s.links.some((x) => x.id === l.id)),
            ];
            return { entities, links };
          });
          fx.emit({ kind: 'birth', id: snap.entity.id });
          log(`↺ RESTAURÉ  ${displayTitle(snap.entity)}`, toneOf(snap.entity), snap.entity);
        },

        link: (a, b, opts) => {
          const s = get();
          const ea = s.entities[a];
          const eb = s.entities[b];
          if (!ea || !eb || a === b) return false;
          if (findLink(s.links, a, b)) return false;
          const t = now();
          set({
            links: [...s.links, { id: uid(), a, b, createdAt: t, strength: opts?.strength ?? 0.5, usedAt: t, origin: opts?.origin ?? 'manuel', createdBy: meId() }],
            entities: { ...s.entities, [a]: { ...ea, touchedAt: t }, [b]: { ...eb, touchedAt: t } },
          });
          fx.emit({ kind: 'link', a, b });
          if (!opts?.quiet) log(`⟷ RELIÉ  ${displayTitle(ea)} ↔ ${displayTitle(eb)}`, toneOf(ea), [ea, eb]);
          return true;
        },

        unlink: (a, b) => {
          const s = get();
          const ea = s.entities[a];
          const eb = s.entities[b];
          set({ links: s.links.filter((l) => !((l.a === a && l.b === b) || (l.a === b && l.b === a))) });
          if (ea && eb) log(`✕ DÉLIÉ  ${displayTitle(ea)} ↔ ${displayTitle(eb)}`, 'system', [ea, eb]);
        },

        strengthen: (a, b, amount = 0.08) => {
          const s = get();
          const l = findLink(s.links, a, b);
          if (!l) return;
          const t = now();
          const strength = Math.min(1, l.strength + amount * (1 - l.strength) + 0.01);
          set({ links: s.links.map((x) => (x === l ? { ...x, strength, usedAt: t } : x)) });
          fx.emit({ kind: 'strengthen', a, b });
        },

        setKindNature: (kind, nature) => {
          if (!kind) return;
          set((s) => ({ kinds: { ...s.kinds, [kindKey(kind)]: { label: kind, nature } } }));
          log(`◇ GENRE « ${kind.toUpperCase()} » → ${nature.toUpperCase()}`, nature);
        },

        clearSeed: () => {
          const s = get();
          const seedIds = new Set(Object.values(s.entities).filter((e) => e.seed).map((e) => e.id));
          if (!seedIds.size) return 0;
          for (const id of seedIds) fx.emit({ kind: 'death', id });
          const entities: Record<string, Entity> = {};
          for (const e of Object.values(s.entities)) if (!seedIds.has(e.id)) entities[e.id] = e;
          set({ entities, links: s.links.filter((l) => !seedIds.has(l.a) && !seedIds.has(l.b)) });
          log(`− ${seedIds.size} EXEMPLES SUPPRIMÉS`, 'alert');
          return seedIds.size;
        },

        replaceAll: (data) => {
          set({ entities: data.entities, links: data.links, kinds: data.kinds });
          log(`↓ IMPORT  ${Object.keys(data.entities).length} NEURONES`, 'system');
        },
      };
    },
    {
      name: 'synapse-data',
      version: 2,
      storage: createJSONStorage(() => debouncedStorage),
      partialize: (s) => ({ entities: s.entities, links: s.links, activity: s.activity, kinds: s.kinds }),
      migrate: (persisted, version) => {
        if (version < 2) {
          // copie de sécurité des données V1 avant toute conversion
          try {
            if (!localStorage.getItem(V1_BACKUP_KEY)) localStorage.setItem(V1_BACKUP_KEY, JSON.stringify(persisted));
          } catch {
            /* stockage plein : la migration continue quand même */
          }
          const v2 = migrateV1((persisted ?? {}) as Parameters<typeof migrateV1>[0]);
          const first: Activity = { id: uid(), at: now(), text: 'SYNAPSE V2 · RÉSEAU CONVERTI EN SECOND CERVEAU', tone: 'system' };
          const activity: Activity[] = [first, ...(v2.activity ?? [])].slice(0, 60);
          return { entities: v2.entities, links: v2.links, kinds: v2.kinds, activity } as unknown as DataState;
        }
        return persisted as DataState;
      },
    },
  ),
);
