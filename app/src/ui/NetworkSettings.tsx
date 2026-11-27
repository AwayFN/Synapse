import { useMemo } from 'react';
import { useData } from '../store/data';
import { networkSettingsVisible, useUI } from '../store/ui';
import { SPACING_DEFAULT, SPACING_MAX, SPACING_MIN, useNetwork } from '../store/network';
import { Corners, cvar } from './common';

const pct = (v: number) => Math.round(v * 100);

/** Un curseur de distance : 40 % (serré) à 160 % (aéré) de la distance de la V7 */
function SpacingSlider({ label, hint, value, onChange, testId }: { label: string; hint: string; value: number; onChange: (v: number) => void; testId: string }) {
  const min = pct(SPACING_MIN);
  const max = pct(SPACING_MAX);
  const v = pct(value);
  return (
    <div className="mt-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="xs-label">{label}</span>
        <span className="mono text-[12px] text-white/85 tabular-nums" data-value={testId}>
          {v} %
        </span>
      </div>
      <input
        type="range"
        className="range mt-1"
        min={min}
        max={max}
        step={5}
        value={v}
        aria-label={label}
        data-slider={testId}
        style={{ ['--fill' as string]: `${((v - min) / (max - min)) * 100}%` }}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <div className="flex justify-between mono text-[9px] text-white/30 -mt-0.5">
        <span>plus serré</span>
        <span>plus aéré</span>
      </div>
      <div className="text-[11px] text-white/40 leading-snug mt-1">{hint}</div>
    </div>
  );
}

/**
 * Réglages du réseau de neurones : la distance entre les neurones (liés, non liés), et les neurones posés à la main.
 * Le réseau se réorganise en direct derrière le panneau ; tout est gardé sur cet appareil.
 */
export function NetworkSettings() {
  const open = useUI(networkSettingsVisible);
  const close = () => useUI.getState().setNetworkOpen(false);
  const linked = useNetwork((s) => s.linked);
  const unlinked = useNetwork((s) => s.unlinked);
  const setSpacing = useNetwork((s) => s.setSpacing);
  const resetSpacing = useNetwork((s) => s.resetSpacing);
  const unpinAll = useNetwork((s) => s.unpinAll);
  const pinnedIds = useNetwork((s) => s.pinned);
  const entities = useData((s) => s.entities);
  const pinned = useMemo(() => Object.keys(pinnedIds).filter((id) => entities[id]).length, [pinnedIds, entities]);
  if (!open) return null;
  const isDefault = linked === SPACING_DEFAULT && unlinked === SPACING_DEFAULT;
  return (
    <div
      data-ui
      data-network-settings
      className="fixed z-20 right-8 top-[72px] w-[340px] max-md:left-2 max-md:right-2 max-md:w-auto max-md:top-[58px] glass neon bg-[rgb(7_7_12/0.92)] anim-pop p-5 max-md:p-4 max-h-[calc(100vh-90px)] overflow-y-auto scroll-thin"
      style={cvar('#00e5ff')}
    >
      <Corners />
      <div className="flex items-center justify-between">
        <span className="hud text-[10.5px] text-[#00e5ff]">Réglages du réseau</span>
        <button className="btn btn-ghost !px-2" title="Fermer (Échap)" onClick={close}>
          ✕
        </button>
      </div>
      <div className="text-[12px] text-white/50 leading-relaxed mt-2">Distance entre les neurones : le réseau se réorganise en direct.</div>

      <SpacingSlider
        label="Neurones liés"
        hint="Deux éléments reliés, ou une tâche, une note, un créneau et son projet."
        value={linked}
        onChange={(v) => setSpacing({ linked: v })}
        testId="linked"
      />
      <SpacingSlider label="Neurones non liés" hint="Tout le reste : l’espace entre les groupes." value={unlinked} onChange={(v) => setSpacing({ unlinked: v })} testId="unlinked" />
      <div className="flex items-center gap-2 mt-4 flex-wrap">
        <button className="btn" disabled={isDefault} onClick={resetSpacing} data-reset-spacing>
          Par défaut ({pct(SPACING_DEFAULT)} %)
        </button>
        <button className="btn btn-ghost" onClick={() => setSpacing({ linked: unlinked })} disabled={linked === unlinked} title="Les neurones liés prennent la même distance que les autres">
          Égaliser
        </button>
      </div>

      <div className="mt-5 pt-4 border-t border-white/[0.07]">
        <div className="flex items-center justify-between gap-3">
          <span className="xs-label">Posés à la main · {pinned}</span>
          {pinned > 0 && (
            <button className="btn !py-1 !px-2 !text-[9.5px]" onClick={unpinAll} data-unpin-all>
              Tout libérer
            </button>
          )}
        </div>
        <div className="text-[11.5px] text-white/45 leading-relaxed mt-2">
          Glisse un neurone pour le poser où tu veux (au doigt : appui long, puis glisse ; molette pendant le déplacement : l’éloigner ou le rapprocher). Il reste
          exactement là, même après avoir fermé Synapse. « Libérer » (dans sa fiche) lui rend sa place automatique.
        </div>
      </div>
    </div>
  );
}
