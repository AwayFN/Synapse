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
};

/** DOM labels registry, filled by <LabelLayer/>, positioned by <LabelsProjector/> */
export const labelEls = new Map<string, HTMLElement>();
export const reticle: { el: HTMLElement | null } = { el: null };
/** Constellation hovered through its DOM label (takes precedence over 3D picking) */
export const labelHover: { id: string | null } = { id: null };
/** Étiquettes de présence (« LÉA ») : participant → élément DOM, et le neurone qu'il regarde */
export const presenceEls = new Map<string, { el: HTMLElement; focus: string | null; slot: number }>();
