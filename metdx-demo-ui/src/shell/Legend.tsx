import type { CSSProperties } from 'react';
import type { LegendProps } from '../lib/covjsonTypes';
import { bandColour } from '../lib/contour';

const GRADIENT_STOPS = 11;

/** Compact number for the legend ends (4 significant digits, no trailing zeros); `–` for NaN. */
export function formatLegendValue(v: number): string {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2);
  return String(Number(v.toPrecision(4)));
}

const box: CSSProperties = {
  display: 'inline-block',
  minWidth: 180,
  padding: '6px 10px 8px',
  background: 'rgba(255,255,255,0.92)',
  border: '1px solid rgba(0,0,0,0.2)',
  borderRadius: 4,
  font: '12px/1.3 system-ui, sans-serif',
  color: '#212121',
};

/** Stepped colour bar of a contour map: one block per band, edge values underneath (every n-th when crowded). */
function SteppedLegend({ unit, scale, label, levels, min, max }: LegendProps & { levels: number[] }) {
  const n = levels.length - 1;
  const stride = Math.ceil(n / 6);
  return (
    <div data-testid="legend" data-levels={levels.length} role="group" aria-label={label ? `Legend: ${label}` : 'Legend'} style={{ ...box, minWidth: 220 }}>
      {(label || unit) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
          <span data-testid="legend-label" style={{ fontWeight: 600 }}>
            {label}
          </span>
          {unit && <span data-testid="legend-unit">{unit}</span>}
        </div>
      )}
      <div data-testid="legend-bar" style={{ display: 'flex', height: 12, margin: '0 14px', border: '1px solid rgba(0,0,0,0.3)' }}>
        {Array.from({ length: n }, (_, k) => {
          const [r, g, b] = bandColour(scale, levels[k], levels[k + 1], min, max);
          return <div key={k} data-testid="legend-step" style={{ flex: 1, background: `rgb(${r},${g},${b})` }} />;
        })}
      </div>
      <div style={{ position: 'relative', height: 14, margin: '2px 14px 0' }}>
        {levels.map((v, k) => {
          const first = k === 0;
          const last = k === n;
          if (!first && !last && (k % stride !== 0 || n - k < stride)) return null;
          return (
            <span
              key={k}
              data-testid={first ? 'legend-min' : last ? 'legend-max' : 'legend-tick'}
              style={{ position: 'absolute', left: `${(k / n) * 100}%`, transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}
            >
              {formatLegendValue(v)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** Colour bar for the data layer on the map: `min` on the left to `max` on the right, with unit and optional title. */
export function Legend({ min, max, unit, scale, label, levels }: LegendProps) {
  if (levels && levels.length >= 2) return <SteppedLegend min={min} max={max} unit={unit} scale={scale} label={label} levels={levels} />;
  const stops = Array.from({ length: GRADIENT_STOPS }, (_, k) => {
    const [r, g, b] = scale.fn(k / (GRADIENT_STOPS - 1));
    return `rgb(${r},${g},${b}) ${(k / (GRADIENT_STOPS - 1)) * 100}%`;
  });
  return (
    <div data-testid="legend" role="group" aria-label={label ? `Legend: ${label}` : 'Legend'} style={box}>
      {label && (
        <div data-testid="legend-label" style={{ fontWeight: 600, marginBottom: 4 }}>
          {label}
        </div>
      )}
      <div
        data-testid="legend-bar"
        style={{ height: 12, border: '1px solid rgba(0,0,0,0.3)', background: `linear-gradient(to right, ${stops.join(', ')})` }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2 }}>
        <span data-testid="legend-min">{formatLegendValue(min)}</span>
        {unit && <span data-testid="legend-unit">{unit}</span>}
        <span data-testid="legend-max">{formatLegendValue(max)}</span>
      </div>
    </div>
  );
}
