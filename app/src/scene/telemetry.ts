/** Live values written by the 3D loop, read by the HUD (no React re-render per frame) */
export const telemetry = {
  heading: 0,
  pitch: 0,
  speed: 0,
  x: 0,
  y: 0,
  z: 0,
  fps: 60,
  pulses: 0,
  pulsesPerMin: 0,
  /** loin des neurones : le bouton « revenir aux neurones » s'allume */
  far: false,
};

/** DOM labels registry, filled by <LabelLayer/>, positioned by <LabelsProjector/> */
export const labelEls = new Map<string, HTMLElement>();
export const reticle: { el: HTMLElement | null } = { el: null };
/** Constellation hovered through its DOM label (takes precedence over 3D picking) */
export const labelHover: { id: string | null } = { id: null };
/**
 * Un neurone qu'on déplace à la main (souris : glisser ; doigt : appui long puis glisser) : son id, pour que la scène
 * (et son étiquette) le montrent « pris en main » ; endedAt : le moment où on l'a lâché (le clic qui suit n'ouvre rien).
 * Écrit par <FlyControls/>.
 */
export const grab: { id: string | null; endedAt: number } = { id: null, endedAt: 0 };
