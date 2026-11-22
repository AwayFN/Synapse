import { useMemo } from 'react';
import { makeQr } from '../lib/qr';

/** QR code à viser avec l'appareil photo d'un téléphone (noir sur blanc : c'est ce que lisent tous les téléphones) */
export function QrCode({ text, size = 200, label }: { text: string; size?: number; label?: string }) {
  const m = useMemo(() => makeQr(text), [text]);
  const quiet = 4;
  const total = m.length + quiet * 2;
  let d = '';
  m.forEach((row, y) =>
    row.forEach((on, x) => {
      if (on) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
    }),
  );
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${total} ${total}`}
      role="img"
      aria-label={label ?? 'QR code'}
      shapeRendering="crispEdges"
      className="rounded-[6px] flex-none"
    >
      <rect width={total} height={total} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
