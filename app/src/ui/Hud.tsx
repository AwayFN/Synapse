import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { displayTitle, useData } from '../store/data';
import { useUI } from '../store/ui';
import { telemetry } from '../scene/telemetry';
import { toneHex } from '../lib/color';
import { natureOfKind, NATURE_ORDER, NATURES, PEARL_HEX, isHubKind } from '../lib/kinds';
import { fmtClock, fmtHours, fmtRelative, fromISODate, todayISO, whenEndTs, whenStartTs } from '../lib/time';
import type { Entity, Nature } from '../types';
import { cvar, Glyph, Kbd, natureVar } from './common';
import { TagBar } from './TagBar';
import { PresenceBar } from './Presence';
import { AccountChip } from './Account';
import { useCan } from '../sync/perm';
import { deName, ROLE_LABEL, useSession } from '../sync/session';

function Legend() {
  const counts = useData(
    useShallow((s) => {
      const c: Record<string, number> = { pensee: 0, action: 0, temps: 0, monde: 0, links: s.links.length, orphans: 0 };
      const linked = new Set<string>();
      for (const l of s.links) {
        linked.add(l.a);
        linked.add(l.b);
      }
      for (const e of Object.values(s.entities)) {
        c[natureOfKind(e.kind, s.kinds)]++;
        if (!linked.has(e.id)) c.orphans++;
      }
      return c;
    }),
  );
  const hidden = useUI((s) => s.hiddenNatures);
  const toggleNature = useUI((s) => s.toggleNature);
  const orphansOnly = useUI((s) => s.orphansOnly);
  const setOrphansOnly = useUI((s) => s.setOrphansOnly);
  return (
    <div className="mt-5 flex flex-col gap-[7px]" data-ui>
      {NATURE_ORDER.map((n: Nature) => {
        const off = hidden.includes(n);
        return (
          <button
            key={n}
            onClick={() => toggleNature(n)}
            className="hud flex items-center gap-2.5 text-[10.5px] text-left pointer-events-auto group"
            style={natureVar(n, { opacity: off ? 0.32 : 1 })}
            title={`${off ? 'Afficher' : 'Masquer'} · ${NATURES[n].hint}`}
          >
            <Glyph nature={n} size={10} done={off} />
            <span className="w-[96px] text-white/78 group-hover:text-white">{NATURES[n].plural}</span>
            <span className="text-white/42 tabular-nums">{String(counts[n]).padStart(3, '0')}</span>
          </button>
        );
      })}
      <div className="hud flex items-center gap-2.5 text-[10.5px] text-white/38">
        <span className="w-[10px] text-center">⟷</span>
        <span className="w-[96px]">Connexions</span>
        <span className="tabular-nums">{String(counts.links).padStart(3, '0')}</span>
      </div>
      {counts.orphans > 0 && (
        <button
          className={`hud flex items-center gap-2.5 text-[10.5px] text-left pointer-events-auto ${orphansOnly ? 'text-white' : 'text-white/38 hover:text-white/80'}`}
          onClick={() => setOrphansOnly(!orphansOnly)}
          title="Éclairer les pensées qui n'ont encore aucune connexion"
        >
          <span className="w-[10px] text-center">{orphansOnly ? '◉' : '○'}</span>
          <span className="w-[96px]">Sans lien</span>
          <span className="tabular-nums">{String(counts.orphans).padStart(3, '0')}</span>
        </button>
      )}
    </div>
  );
}

function ViewTabs() {
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  const tabs: { v: typeof view; label: string; key: string }[] = [
    { v: 'network', label: 'Réseau', key: 'ÉCHAP' },
    { v: 'flux', label: 'Flux', key: '2' },
    { v: 'agenda', label: 'Agenda', key: 'TAB' },
    { v: 'tasks', label: 'Tâches', key: '⇧TAB' },
  ];
  return (
    <div className="glass flex pointer-events-auto" data-ui>
      {tabs.map((t) => (
        <button
          key={t.v}
          onClick={() => setView(t.v)}
          className={`hud text-[10.5px] px-4 py-2 flex items-center gap-2 transition-colors ${
            view === t.v ? 'text-white bg-white/[0.06] shadow-[inset_0_-1px_0_rgb(var(--pearl)/0.8)]' : 'text-white/45 hover:text-white'
          }`}
        >
          {t.label}
          <span className="text-[8.5px] text-white/28">{t.key}</span>
        </button>
      ))}
    </div>
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

function NowWidget() {
  const now = useNow(20000);
  const moments = useData(useShallow((s) => Object.values(s.entities).filter((e) => !!e.when && e.when.start != null)));
  const today = todayISO();
  const dayStart = fromISODate(today).getTime();
  const capturedToday = useData((s) => {
    let n = 0;
    for (const e of Object.values(s.entities)) if (e.createdAt >= dayStart) n++;
    return n;
  });
  const dueToday = useData((s) => {
    let n = 0;
    for (const e of Object.values(s.entities)) {
      if (!e.status || e.status === 'done' || isHubKind(e.kind)) continue;
      if (e.when?.date === today || e.due === today) n++;
    }
    return n;
  });
  const openEntity = useUI((s) => s.openEntity);
  const clockRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (clockRef.current) clockRef.current.textContent = new Date().toLocaleTimeString('fr-FR');
    }, 500);
    return () => window.clearInterval(id);
  }, []);
  const { current, next } = useMemo(() => {
    let current: Entity | null = null;
    let next: Entity | null = null;
    for (const m of moments) {
      if (!m.when || m.status === 'done') continue;
      const a = whenStartTs(m.when);
      const b = whenEndTs(m.when);
      if (a <= now && now < b) {
        if (!current || a > whenStartTs(current.when!)) current = m;
      } else if (a > now && (!next || a < whenStartTs(next.when!))) next = m;
    }
    return { current, next };
  }, [moments, now]);
  const show = current ?? next;

  return (
    <div className="glass neon w-[290px] pointer-events-auto" data-ui>
      <div className="flex justify-between items-center px-3 pt-2.5 hud text-[9.5px] text-white/42">
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[rgb(var(--pearl))] breathe" /> Live · synapse
        </span>
        <span ref={clockRef} className="text-white/70 tabular-nums">
          --:--:--
        </span>
      </div>
      <div className="px-3 pt-1 pb-2 flex items-baseline gap-2">
        <span className="mono text-[26px] font-light text-white tabular-nums">{capturedToday}</span>
        <span className="hud text-[9.5px] text-white/40">capturé{capturedToday > 1 ? 's' : ''} aujourd'hui</span>
        {dueToday > 0 && (
          <span className="hud text-[9px] ml-auto" style={{ color: NATURES.action.hex }}>
            ◆ {dueToday} à faire
          </span>
        )}
      </div>
      {show?.when && (
        <button
          onClick={() => openEntity(show.id)}
          className="w-full text-left border-t border-white/[0.06] px-3 py-2 hover:bg-white/[0.03] transition-colors"
          style={natureVar('temps')}
        >
          <div className="hud text-[9px]" style={{ color: current ? 'rgb(var(--alert))' : 'rgb(var(--c))' }}>
            {current ? '● Maintenant' : '○ Ensuite'} · {fmtHours(show.when)}
          </div>
          <div className="text-[12.5px] text-white/90 truncate mt-0.5">{displayTitle(show)}</div>
          <div className="hud text-[9px] text-white/38 mt-0.5">
            {current ? `fin ${fmtRelative(whenEndTs(current.when!) - now)}` : fmtRelative(whenStartTs(show.when) - now)}
          </div>
        </button>
      )}
    </div>
  );
}

function Counter() {
  const { neurons, links, done, total } = useData(
    useShallow((s) => {
      let done = 0;
      let total = 0;
      for (const e of Object.values(s.entities)) {
        if (!e.status || isHubKind(e.kind)) continue;
        total++;
        if (e.status === 'done') done++;
      }
      return { neurons: Object.keys(s.entities).length, links: s.links.length, done, total };
    }),
  );
  const telRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!telRef.current) return;
      const t = telemetry;
      telRef.current.textContent = `CAP ${t.heading.toFixed(1).padStart(5, '0')}° · INC ${t.pitch >= 0 ? '+' : ''}${t.pitch.toFixed(0)}° · VIT ${t.speed.toFixed(1)} · ONDES ${Math.round(t.pulsesPerMin)}/MIN · ${Math.round(t.fps)} FPS`;
    }, 250);
    return () => window.clearInterval(id);
  }, []);
  const pct = total ? done / total : 0;
  return (
    <div className="pointer-events-none">
      <div className="flex items-baseline gap-2">
        <span className="mono text-[44px] font-extralight text-white leading-none tabular-nums">{neurons}</span>
        <span className="hud text-[10px] text-white/40">neurones</span>
        <span className="mono text-[16px] text-white/35 tabular-nums ml-2">{links}</span>
        <span className="hud text-[10px] text-white/30">connexions</span>
      </div>
      <div className="w-[240px] h-px bg-white/10 mt-2.5 relative">
        <div className="absolute left-0 top-0 h-px transition-all duration-700" style={{ width: `${pct * 100}%`, background: NATURES.action.hex }} />
      </div>
      <div className="hud text-[9.5px] text-white/38 mt-2">
        Second cerveau · {done}/{total} actions accomplies
      </div>
      <div ref={telRef} className="hud text-[9px] text-white/22 mt-1 tabular-nums" />
    </div>
  );
}

function ActivityLog() {
  const items = useData((s) => s.activity);
  const openEntity = useUI((s) => s.openEntity);
  const entities = useData((s) => s.entities);
  return (
    <div className="w-[310px] flex flex-col items-end gap-[5px] pointer-events-none">
      {items.slice(0, 7).map((a, i) => (
        <button
          key={a.id}
          disabled={!a.entityId || !entities[a.entityId]}
          onClick={() => a.entityId && openEntity(a.entityId)}
          data-ui
          className="mono text-[9.5px] tracking-[0.1em] uppercase flex gap-2 max-w-full pointer-events-auto disabled:pointer-events-none"
          style={{ opacity: 1 - i * 0.12 }}
        >
          <span className="text-white/28 tabular-nums">{fmtClock(a.at)}</span>
          <span className="truncate" style={{ color: i === 0 ? toneHex(a.tone) : 'rgb(228 233 242 / 0.5)' }}>
            {a.text}
          </span>
        </button>
      ))}
      <div className="hud text-[9px] text-white/22 mt-1">journal d'activité</div>
    </div>
  );
}

/** Fil de pensée : le chemin parcouru de neurone en neurone */
function Trail() {
  const trail = useUI((s) => s.trail);
  const pos = useUI((s) => s.trailPos);
  const ents = useData((s) => s.entities);
  const items = trail.map((id, i) => ({ id, i, e: ents[id] })).filter((x) => !!x.e).slice(-6);
  if (items.length < 2) return null;
  return (
    <div className="flex items-center gap-1.5 hud text-[9px] text-white/32 pointer-events-auto max-w-[70vw]" data-ui>
      <span className="text-white/22">Fil</span>
      {items.map((x, k) => (
        <Fragment key={`${x.id}-${x.i}`}>
          {k > 0 && <span className="text-white/18">›</span>}
          <button
            className={`truncate max-w-[150px] ${x.i === pos ? 'text-white' : 'hover:text-white/80'}`}
            onClick={() => {
              useUI.setState({ trailPos: x.i });
              useUI.getState().openEntity(x.id, { via: 'trail' });
            }}
          >
            {displayTitle(x.e)}
          </button>
        </Fragment>
      ))}
    </div>
  );
}

function Hints() {
  return (
    <div className="hud text-[9px] text-white/32 hidden min-[1400px]:flex flex-wrap justify-center gap-x-4 gap-y-1.5 pointer-events-none max-w-[720px]">
      <span>
        <Kbd>Ctrl K</Kbd> capturer
      </span>
      <span>
        <Kbd>/</Kbd> chercher
      </span>
      <span>
        <Kbd>Maj+clic</Kbd> relier
      </span>
      <span>
        <Kbd>Molette</Kbd> avancer
      </span>
      <span>
        <Kbd>Clic droit</Kbd> pivoter
      </span>
      <span>
        <Kbd>ZQSD</Kbd> voler
      </span>
      <span>
        <Kbd>H</Kbd> vue d'ensemble
      </span>
      <span>
        <Kbd>?</Kbd> aide
      </span>
    </div>
  );
}

function Subtitle() {
  const mode = useSession((s) => s.mode);
  const role = useSession((s) => s.role);
  const ownerName = useSession((s) => s.ownerName);
  const brainName = useSession((s) => s.brainName);
  const text =
    mode === 'local' || role === 'owner'
      ? `second cerveau · v4${mode !== 'local' && brainName ? ' · ' + brainName : ''}`
      : `cerveau ${deName(ownerName || 'ton hôte')} · invité · ${ROLE_LABEL[role]}`;
  return <div className="hud text-[9px] text-white/32 mt-1.5 ml-5 max-w-[300px] truncate">{text}</div>;
}

/** Le propriétaire voit son cerveau comme le voit un invité */
function PreviewBanner() {
  const previewAs = useSession((s) => s.previewAs);
  const members = useSession((s) => s.members);
  if (!previewAs) return null;
  return (
    <div className="absolute left-1/2 -translate-x-1/2 top-[132px] glass neon px-4 py-2 flex items-center gap-3 pointer-events-auto" data-ui>
      <span className="hud text-[9.5px] text-white/80">Aperçu · tu vois le cerveau comme {members[previewAs]?.name ?? 'cet invité'}</span>
      <button className="btn !py-0.5 !px-2 !text-[9px]" onClick={() => useSession.setState({ previewAs: null })}>
        Quitter <span className="text-white/35 ml-1">Échap</span>
      </button>
    </div>
  );
}

export function Hud() {
  const view = useUI((s) => s.view);
  const editorOpen = useUI((s) => !!s.editorId);
  const panelOpen = useUI((s) => !!s.selectedId);
  const openPalette = useUI((s) => s.openPalette);
  const can = useCan();
  const hidden = view !== 'network' || editorOpen;
  return (
    <div className="absolute inset-0 pointer-events-none z-10 transition-opacity duration-300" style={{ opacity: hidden ? 0 : 1 }}>
      <i className="pc tl !w-5 !h-5 !left-3 !top-3" style={cvar(PEARL_HEX, { opacity: 0.4 })} />
      <i className="pc tr !w-5 !h-5 !right-3 !top-3" style={cvar(PEARL_HEX, { opacity: 0.4 })} />
      <i className="pc bl !w-5 !h-5 !left-3 !bottom-3" style={cvar(PEARL_HEX, { opacity: 0.4 })} />
      <i className="pc br !w-5 !h-5 !right-3 !bottom-3" style={cvar(PEARL_HEX, { opacity: 0.4 })} />

      <div className="absolute left-8 top-7">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rotate-45 bg-[rgb(var(--pearl))] shadow-[0_0_10px_rgb(var(--pearl)/0.7)]" />
          <span className="hud text-[15px] font-semibold tracking-[0.42em] text-white">Synapse</span>
        </div>
        <Subtitle />
        <Legend />
      </div>

      <div className="absolute left-1/2 -translate-x-1/2 top-6 flex flex-col items-center gap-3">
        <ViewTabs />
        <TagBar />
      </div>

      <div
        className="absolute right-8 top-7 transition-transform duration-300 hidden min-[1120px]:block"
        style={{ transform: panelOpen ? 'translateX(-460px)' : undefined, opacity: panelOpen ? 0 : 1 }}
      >
        <div className="flex flex-col items-end gap-2.5">
          <AccountChip />
          <NowWidget />
          <PresenceBar />
        </div>
      </div>
      <div className="absolute left-1/2 -translate-x-1/2 top-[84px] min-[1120px]:hidden pointer-events-auto flex flex-col items-center gap-2">
        <AccountChip />
        <PresenceBar />
      </div>
      <PreviewBanner />

      <div className="absolute left-8 bottom-8">
        <Counter />
      </div>

      <div className="absolute right-8 bottom-8 transition-opacity duration-300" style={{ opacity: panelOpen ? 0 : 1 }}>
        <ActivityLog />
      </div>

      <div className="absolute left-1/2 -translate-x-1/2 bottom-7 flex flex-col items-center gap-3">
        <Trail />
        <button
          data-ui
          onClick={() => openPalette(can.write() ? '' : '/')}
          className="glass neon pointer-events-auto flex items-center gap-3 px-4 py-2 hud text-[10.5px] text-white/72 hover:text-white transition-colors"
        >
          <span className="text-white text-sm leading-none">{can.write() ? '+' : '⌕'}</span>
          {can.write() ? 'Capturer · chercher' : 'Chercher'}
          <Kbd>Ctrl K</Kbd>
        </button>
        <Hints />
        <div className="hud text-[9px] text-white/30 min-[1400px]:hidden pointer-events-none">
          <Kbd>?</Kbd> aide & raccourcis
        </div>
      </div>
    </div>
  );
}
