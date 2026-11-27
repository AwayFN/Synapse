import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { displayTitle, useData } from '../store/data';
import { useUI } from '../store/ui';
import { telemetry } from '../scene/telemetry';
import { TYPE_ACCENT } from '../lib/color';
import { fmtClock, fmtRelative, fmtTime, slotEndTs, slotStartTs } from '../lib/time';
import { hasProject, TYPE_PLURAL, type EntityType, type Slot } from '../types';
import { cvar, Kbd } from './common';
import { TagBar } from './TagBar';
import { fx } from '../store/fx';

/** Sous le nom : tout est ici, sur cet appareil */
function Subtitle() {
  return <div className="hud text-[9px] text-white/35 mt-1.5 ml-5 max-w-[320px] truncate">réseau personnel · v8 · 100 % local</div>;
}

const TYPES: EntityType[] = ['project', 'task', 'note', 'slot'];

function Legend() {
  const counts = useData(
    useShallow((s) => {
      const c = { project: 0, task: 0, note: 0, slot: 0, links: 0 };
      for (const e of Object.values(s.entities)) c[e.type]++;
      c.links = s.links.length + Object.values(s.entities).filter((e) => hasProject(e) && e.projectId).length;
      return c;
    }),
  );
  const hidden = useUI((s) => s.hiddenTypes);
  const toggleType = useUI((s) => s.toggleType);
  return (
    <div className="mt-5 flex flex-col gap-[7px]" data-ui>
      {TYPES.map((t) => {
        const off = hidden.includes(t);
        return (
          <button
            key={t}
            onClick={() => toggleType(t)}
            className="hud flex items-center gap-2.5 text-[10.5px] text-left pointer-events-auto group"
            style={cvar(TYPE_ACCENT[t], { opacity: off ? 0.35 : 1 })}
            title={off ? 'Afficher' : 'Masquer'}
          >
            <span className="dot" style={{ background: off ? 'transparent' : undefined, border: '1px solid rgb(var(--c))' }} />
            <span className="w-[88px] text-white/80 group-hover:text-white">{TYPE_PLURAL[t]}</span>
            <span className="text-white/45 tabular-nums">{String(counts[t]).padStart(3, '0')}</span>
          </button>
        );
      })}
      <div className="hud flex items-center gap-2.5 text-[10.5px] text-white/40">
        <span className="w-[7px] text-center">⟷</span>
        <span className="w-[88px]">Liens</span>
        <span className="tabular-nums">{String(counts.links).padStart(3, '0')}</span>
      </div>
    </div>
  );
}

function ViewTabs() {
  const view = useUI((s) => s.view);
  const setView = useUI((s) => s.setView);
  // sur téléphone, des noms courts : les quatre vues tiennent sous le pouce
  const tabs: { v: typeof view; label: string; short: string; key: string }[] = [
    { v: 'network', label: 'Réseau', short: 'Réseau', key: 'ÉCHAP' },
    { v: 'agenda', label: 'Agenda', short: 'Agenda', key: 'TAB' },
    { v: 'tasks', label: 'Tâches', short: 'Tâches', key: '⇧TAB' },
    { v: 'notes', label: 'Notes', short: 'Notes', key: '' },
  ];
  return (
    <div className="glass flex pointer-events-auto" data-ui style={cvar('#00e5ff')}>
      {tabs.map((t) => (
        <button
          key={t.v}
          onClick={() => setView(t.v)}
          data-view-tab={t.v}
          className={`hud text-[10.5px] whitespace-nowrap px-4 max-xl:px-3 py-2 max-md:text-[9.5px] max-md:tracking-[0.08em] max-md:px-2.5 max-md:py-2.5 flex items-center gap-2 transition-colors ${
            view === t.v ? 'text-[rgb(var(--c))] bg-[rgb(var(--c)/0.1)] shadow-[inset_0_-1px_0_rgb(var(--c))]' : 'text-white/50 hover:text-white'
          }`}
        >
          <span className="max-lg:hidden">{t.label}</span>
          <span className="lg:hidden">{t.short}</span>
          {t.key && <span className="text-[8.5px] text-white/30 max-xl:hidden">{t.key}</span>}
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
  const slots = useData(useShallow((s) => Object.values(s.entities).filter((e): e is Slot => e.type === 'slot')));
  const openEntity = useUI((s) => s.openEntity);
  const clockRef = useRef<HTMLSpanElement>(null);
  const ppmRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      const d = new Date();
      if (clockRef.current) clockRef.current.textContent = d.toLocaleTimeString('fr-FR');
      if (ppmRef.current) ppmRef.current.textContent = Math.round(telemetry.pulsesPerMin).toLocaleString('fr-FR');
    }, 500);
    return () => window.clearInterval(id);
  }, []);
  const { current, next } = useMemo(() => {
    let current: Slot | null = null;
    let next: Slot | null = null;
    for (const s of slots) {
      const a = slotStartTs(s.date, s.start);
      const b = slotEndTs(s.date, s.start, s.end);
      if (a <= now && now < b) {
        if (!current || a > slotStartTs(current.date, current.start)) current = s;
      } else if (a > now && (!next || a < slotStartTs(next.date, next.start))) next = s;
    }
    return { current, next };
  }, [slots, now]);

  return (
    <div className="glass neon w-[290px] pointer-events-auto" style={cvar('#00e5ff')} data-ui>
      <div className="flex justify-between items-center px-3 pt-2.5 hud text-[9.5px] text-white/45">
        <span className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 bg-[#39ff88] shadow-[0_0_8px_#39ff88] blink" /> Live · synapse
        </span>
        <span ref={clockRef} className="text-white/70 tabular-nums">
          --:--:--
        </span>
      </div>
      <div className="px-3 pt-1 pb-2 flex items-baseline gap-2">
        <span ref={ppmRef} className="mono text-[26px] font-light text-white tabular-nums">
          0
        </span>
        <span className="hud text-[9.5px] text-white/40">impulsions/min</span>
      </div>
      {(current || next) && (
        <button
          onClick={() => openEntity((current ?? next)!.id)}
          className="w-full text-left border-t border-white/[0.06] px-3 py-2 hover:bg-white/[0.03] transition-colors"
          style={cvar((current ?? next)!.color)}
        >
          <div className="hud text-[9px] text-[rgb(var(--c))]">
            {current ? '● En cours' : '○ Prochain créneau'} · {fmtTime((current ?? next)!.start)} → {fmtTime((current ?? next)!.end)}
          </div>
          <div className="text-[12.5px] text-white/90 truncate mt-0.5">{displayTitle(current ?? next)}</div>
          <div className="hud text-[9px] text-white/40 mt-0.5">
            {current
              ? `fin ${fmtRelative(slotEndTs(current.date, current.start, current.end) - now)}`
              : fmtRelative(slotStartTs(next!.date, next!.start) - now)}
          </div>
        </button>
      )}
    </div>
  );
}

function TaskCounter() {
  const { done, total } = useData(
    useShallow((s) => {
      let done = 0;
      let total = 0;
      for (const e of Object.values(s.entities)) {
        if (e.type !== 'task') continue;
        total++;
        if (e.status === 'done') done++;
      }
      return { done, total };
    }),
  );
  const telRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!telRef.current) return;
      const t = telemetry;
      telRef.current.textContent = `CAP ${t.heading.toFixed(1).padStart(5, '0')}° · INC ${t.pitch >= 0 ? '+' : ''}${t.pitch.toFixed(0)}° · VIT ${t.speed.toFixed(1)} · ${Math.round(t.fps)} FPS`;
    }, 200);
    return () => window.clearInterval(id);
  }, []);
  const pct = total ? done / total : 0;
  return (
    <div className="pointer-events-none">
      <div className="flex items-baseline gap-2">
        <span className="mono text-[44px] font-extralight text-white leading-none tabular-nums">{done}</span>
        <span className="mono text-[18px] text-white/35 tabular-nums">/ {total}</span>
      </div>
      <div className="w-[230px] h-px bg-white/10 mt-2 relative">
        <div
          className="absolute left-0 top-0 h-px bg-[#39ff88] shadow-[0_0_10px_#39ff88] transition-all duration-700"
          style={{ width: `${pct * 100}%` }}
        />
      </div>
      <div className="hud text-[9.5px] text-white/40 mt-2">Tâches accomplies · réseau personnel</div>
      <div ref={telRef} className="hud text-[9px] text-white/25 mt-1 tabular-nums" />
    </div>
  );
}

function ActivityLog() {
  const items = useData((s) => s.activity);
  const openEntity = useUI((s) => s.openEntity);
  const entities = useData((s) => s.entities);
  return (
    <div className="w-[300px] flex flex-col items-end gap-[5px] pointer-events-none">
      {items.slice(0, 7).map((a, i) => (
        <button
          key={a.id}
          disabled={!a.entityId || !entities[a.entityId]}
          onClick={() => a.entityId && openEntity(a.entityId)}
          data-ui
          className="mono text-[9.5px] tracking-[0.1em] uppercase flex gap-2 max-w-full pointer-events-auto disabled:pointer-events-none"
          style={{ opacity: 1 - i * 0.12 }}
        >
          <span className="text-white/30 tabular-nums">{fmtClock(a.at)}</span>
          <span className="truncate" style={{ color: i === 0 ? a.color : 'rgb(233 233 241 / 0.55)' }}>
            {a.text}
          </span>
        </button>
      ))}
      <div className="hud text-[9px] text-white/25 mt-1">journal d'activité</div>
    </div>
  );
}

function Hints() {
  return (
    <div className="hud text-[9px] text-white/35 flex flex-wrap justify-center gap-x-4 gap-y-1.5 pointer-events-none">
      <span><Kbd>Ctrl K</Kbd> commande</span>
      <span><Kbd>Ctrl N</Kbd> / <Kbd>Alt N</Kbd> note</span>
      <span><Kbd>Molette</Kbd> avancer</span>
      <span><Kbd>Clic droit</Kbd> pivoter</span>
      <span><Kbd>ZQSD</Kbd> voler</span>
      <span><Kbd>Glisser un neurone</Kbd> le déplacer</span>
      <span><Kbd>H</Kbd> vue d'ensemble</span>
      <span><Kbd>?</Kbd> aide</span>
    </div>
  );
}

/**
 * Revenir aux neurones : un petit bouton discret à côté de « Créer · chercher ». Il s'allume quand on s'est
 * éloigné du réseau ; un appui ramène devant les neurones presque instantanément, même de très loin.
 */
function HomeButton() {
  const [far, setFar] = useState(false);
  useEffect(() => {
    const id = window.setInterval(() => setFar(telemetry.far), 300);
    return () => window.clearInterval(id);
  }, []);
  return (
    <button
      data-ui
      data-home
      data-far={far ? '1' : '0'}
      onClick={() => fx.emit({ kind: 'home' })}
      title="Revenir aux neurones (touche H)"
      aria-label="Revenir aux neurones"
      className={`glass pointer-events-auto w-9 h-9 max-md:w-10 max-md:h-10 flex items-center justify-center transition-colors duration-500 ${
        far ? 'neon text-[#00e5ff] breathe' : 'text-white/40 hover:text-white'
      }`}
      style={cvar('#00e5ff')}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
        <circle cx="12" cy="12" r="6.5" />
        <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
        <path d="M12 1.8v3.4M12 18.8v3.4M1.8 12h3.4M18.8 12h3.4" />
      </svg>
    </button>
  );
}

/** Les réglages du réseau : distance entre les neurones, neurones déplacés à la main */
function NetworkButton() {
  const open = useUI((s) => s.networkOpen);
  const setOpen = useUI((s) => s.setNetworkOpen);
  return (
    <button
      data-ui
      data-network-settings-button
      onClick={() => setOpen(!open)}
      title="Réglages du réseau : distance entre les neurones"
      aria-label="Réglages du réseau"
      className={`glass pointer-events-auto h-9 max-md:h-10 px-3 max-md:px-0 max-md:w-10 flex items-center justify-center gap-2 hud text-[10px] transition-colors ${
        open ? 'neon text-[#00e5ff]' : 'text-white/55 hover:text-white'
      }`}
      style={cvar('#00e5ff')}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
        <circle cx="5" cy="7" r="2.2" />
        <circle cx="18.5" cy="5.5" r="1.8" />
        <circle cx="14" cy="17.5" r="2.6" />
        <path d="M7 7.6l9.7-1.6M6.4 8.8l6 6.7M17.9 7.3l-2.9 7.7" />
      </svg>
      <span className="max-md:hidden">Réseau</span>
    </button>
  );
}

export function Hud() {
  const view = useUI((s) => s.view);
  const editorOpen = useUI((s) => !!s.editorId);
  const panelOpen = useUI((s) => !!s.selectedId);
  const openPalette = useUI((s) => s.openPalette);
  const hidden = view !== 'network' || editorOpen;
  return (
    <div
      className="absolute inset-0 pointer-events-none z-10 transition-opacity duration-300"
      style={{ opacity: hidden ? 0 : 1 }}
    >
      {/* viewport corners */}
      <i className="pc tl !w-5 !h-5 !left-3 !top-3" style={cvar('#ffffff', { opacity: 0.35 })} />
      <i className="pc tr !w-5 !h-5 !right-3 !top-3" style={cvar('#ffffff', { opacity: 0.35 })} />
      <i className="pc bl !w-5 !h-5 !left-3 !bottom-3" style={cvar('#ffffff', { opacity: 0.35 })} />
      <i className="pc br !w-5 !h-5 !right-3 !bottom-3" style={cvar('#ffffff', { opacity: 0.35 })} />

      <div className="absolute left-8 top-7 max-md:left-4 max-md:top-4">
        <div className="flex items-center gap-3">
          <div className="w-2 h-2 rotate-45 bg-[#ff2e88] shadow-[0_0_12px_#ff2e88]" />
          <span className="hud text-[15px] font-semibold tracking-[0.42em] text-white">Synapse</span>
        </div>
        <div className="max-md:hidden">
          <Subtitle />
          <Legend />
        </div>
      </div>

      {/* sur téléphone, les vues passent en bas, à portée de pouce */}
      <div
        className={`absolute left-1/2 -translate-x-1/2 top-6 flex flex-col items-center gap-3 max-md:top-auto max-md:bottom-[calc(14px+env(safe-area-inset-bottom))] ${
          panelOpen ? 'max-md:opacity-0 max-md:pointer-events-none' : ''
        }`}
      >
        <ViewTabs />
        <div className="max-md:hidden">
          <TagBar />
        </div>
      </div>

      {/* sur téléphone : les tags en haut, sur une ligne qui défile (les mêmes que sur le PC) */}
      <div
        className={`md:hidden absolute left-0 right-0 top-[60px] transition-opacity duration-300 ${panelOpen ? 'opacity-0 pointer-events-none' : ''}`}
        data-mobile-tags
      >
        <TagBar variant="scroll" />
      </div>

      <div
        className="absolute right-8 top-7 transition-transform duration-300 max-md:right-3 max-md:top-3"
        style={{ transform: panelOpen ? 'translateX(-440px)' : undefined, opacity: panelOpen ? 0 : 1 }}
      >
        <div className="flex flex-col items-end gap-2.5">
          <NetworkButton />
          <div className="max-md:hidden">
            <NowWidget />
          </div>
        </div>
      </div>

      <div className="absolute left-8 bottom-8 max-md:hidden">
        <TaskCounter />
      </div>

      <div
        className="absolute right-8 bottom-8 transition-opacity duration-300 max-md:hidden"
        style={{ opacity: panelOpen ? 0 : 1 }}
      >
        <ActivityLog />
      </div>

      <div
        className={`absolute left-1/2 -translate-x-1/2 bottom-7 flex flex-col items-center gap-3 max-md:bottom-[calc(70px+env(safe-area-inset-bottom))] ${
          panelOpen ? 'max-md:opacity-0 max-md:pointer-events-none' : ''
        }`}
      >
        <div className="relative">
          <button
            data-ui
            onClick={() => openPalette()}
            className="glass neon pointer-events-auto flex items-center gap-3 px-4 py-2 max-md:py-2.5 hud text-[10.5px] text-white/70 hover:text-white transition-colors"
            style={cvar('#ff2e88')}
          >
            <span className="text-[#ff2e88] text-sm leading-none">+</span>
            Créer · chercher
            <span className="max-md:hidden">
              <Kbd>Ctrl K</Kbd>
            </span>
          </button>
          {/* à côté, sans décentrer « Créer · chercher » */}
          <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2">
            <HomeButton />
          </div>
        </div>
        <div className="max-md:hidden">
          <Hints />
        </div>
      </div>
    </div>
  );
}
