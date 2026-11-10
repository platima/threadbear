// A QR code as inline SVG, drawn from qrcode-generator's modules. Always
// dark on white, whatever the colour scheme, so phones can read it.

import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

export function QrCode({ text, size = 240, label = 'QR code' }: { text: string; size?: number; label?: string }) {
  const drawn = useMemo(() => {
    try {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      const n = qr.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      return { n, d };
    } catch {
      return undefined;
    }
  }, [text]);
  if (!drawn) return <p className="ops-note bad">That link is too long to draw as a code.</p>;
  const q = 3;
  return (
    <svg viewBox={`${-q} ${-q} ${drawn.n + 2 * q} ${drawn.n + 2 * q}`} width={size} height={size} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect x={-q} y={-q} width={drawn.n + 2 * q} height={drawn.n + 2 * q} fill="#fff" />
      <path d={drawn.d} fill="#000" />
    </svg>
  );
}
