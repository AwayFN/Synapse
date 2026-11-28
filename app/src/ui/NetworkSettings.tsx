import { useEffect, useMemo, useState } from 'react';
import { useData } from '../store/data';
import { networkSettingsVisible, useUI } from '../store/ui';
import { clampSpacing, SLIDER_MAX, SLIDER_MIN, SPACING_DEFAULT, SPACING_MAX, SPACING_MIN, useNetwork } from '../store/network';
import { Corners, cvar } from './common';

/** 0,85 → « 85 », 0,045 → « 4,5 », 120 → « 12 000 » */
const pctText = (v: number) => Number((v * 100).toPrecision(3)).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
const STEPS = 1000;
const LOG_MIN = Math.log10(SLIDER_MIN);
const LOG_MAX = Math.log10(SLIDER_MAX);
/** le curseur suit une échelle logarithmique : autant de place entre 10 % et 100 % qu'entre 100 % et 1 000 % */
const toSlider = (v: number) => Math.round(((Math.log10(Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, v))) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * STEPS);
const fromSlider = (x: number) => 10 ** (LOG_MIN + (x / STEPS) * (LOG_MAX - LOG_MIN));

/**
 * Une distance : un curseur de 5 % (très serré) à 5 000 % (très aéré) de la distance de la V7, et une case où taper
 * n'importe quelle valeur de 1 % à 100 000 %.
 */
function SpacingSlider({ label, hint, value, onChange, testId }: { label: string; hint: string; value: number; onChange: (v: number) => void; testId: string }) {
  const x = toSlider(value);
  const [text, setText] = useState(pctText(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(pctText(value));
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    const n = Number(text.replace(/\s/g, '').replace(',', '.').replace('%', ''));
    if (Number.isFinite(n) && n > 0) onChange(clampSpacing(n / 100));
    else setText(pctText(value));
  };
  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-3">
        <span className="xs-label">{label}</span>
        <label className="flex items-center gap-1 mono text-[12px] text-white/85" title="Tape la valeur que tu veux (de 1 % à 100 000 %)">
          <input
            value={text}
            inputMode="decimal"
            aria-label={`${label} (pourcentage)`}
            data-value={testId}
            className="w-[76px] bg-transparent border-b border-white/15 focus:border-[rgb(var(--c))] outline-none text-right tabular-nums py-0.5"
            onFocus={(e) => {
              setEditing(true);
              e.currentTarget.select();
            }}
            onChange={(e) => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              else if (e.key === 'Escape') {
                setText(pctText(value));
                setEditing(false);
                e.currentTarget.blur();
              }
            }}
          />
          %
        </label>
      </div>
      <input
        type="range"
        className="range mt-1"
        min={0}
        max={STEPS}
        step={1}
        value={x}
        aria-label={label}
        data-slider={testId}
        style={{ ['--fill' as string]: `${(x / STEPS) * 100}%` }}
        onChange={(e) => onChange(clampSpacing(fromSlider(Number(e.target.value))))}
      />
      <div className="flex justify-between mono text-[9px] text-white/30 -mt-0.5">
        <span>{pctText(SLIDER_MIN)} % · serré</span>
        <span>aéré · {pctText(SLIDER_MAX)} %</span>
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
    // sur téléphone : posé en bas de l'écran, à portée de pouce ; le réseau reste visible au-dessus et bouge en direct
    <div
      data-ui
      data-network-settings
      className="fixed z-20 right-8 top-[72px] w-[340px] max-md:left-0 max-md:right-0 max-md:w-auto max-md:top-auto max-md:bottom-0 glass neon bg-[rgb(7_7_12/0.92)] max-md:bg-[rgb(7_7_12/0.95)] anim-pop-sheet flex flex-col max-h-[calc(100vh-90px)] max-md:max-h-[52dvh]"
      style={cvar('#00e5ff')}
    >
      <Corners />
      <div className="md:hidden flex justify-center pt-2 flex-none">
        <span className="w-10 h-1 rounded-full bg-white/15" />
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain scroll-thin p-5 max-md:px-4 max-md:pt-2 max-md:pb-[calc(16px+env(safe-area-inset-bottom))]">
      <div className="flex items-center justify-between">
        <span className="hud text-[10.5px] text-[#00e5ff]">Réglages du réseau</span>
        <button className="btn btn-ghost !px-2 max-md:!px-3 max-md:!py-2" title="Fermer (Échap)" aria-label="Fermer les réglages du réseau" onClick={close}>
          ✕
        </button>
      </div>
      <div className="text-[12px] text-white/50 leading-relaxed mt-2">
        Distance entre les neurones, aussi serrée ou aussi grande que tu veux : le réseau se réorganise en direct.
      </div>

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
          Par défaut ({pctText(SPACING_DEFAULT)} %)
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
        <div className="text-[11.5px] text-white/45 leading-relaxed mt-2 max-md:hidden">
          Glisse un neurone pour le poser où tu veux dans l’espace, aussi loin que tu veux : pendant que tu le tiens, la molette (au doigt : un deuxième doigt,
          et pincer) l’éloigne ou le rapproche, et tu peux voler avec (Z Q S D) pour l’emporter plus loin. Au doigt : appui long sur le neurone, puis glisse. Il
          reste exactement là, même après avoir fermé Synapse. « Libérer » (dans sa fiche) lui rend sa place automatique.
        </div>
        <div className="text-[12px] text-white/45 leading-relaxed mt-2 md:hidden">
          Appui long sur un neurone, puis glisse : tu le poses où tu veux, aussi loin que tu veux (en le tenant, pose un deuxième doigt et pince pour l’éloigner ou
          le rapprocher). Il reste exactement là, même après avoir fermé Synapse. « Libérer » (dans sa fiche) lui rend sa place automatique.
        </div>
        <div className="mono text-[10px] text-white/30 mt-2">
          Valeurs possibles : de {pctText(SPACING_MIN)} % à {pctText(SPACING_MAX)} %.
        </div>
      </div>
      </div>
    </div>
  );
}
