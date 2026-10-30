// Lightweight SVG line chart for CoverageJSON point series (no chart library).
import { Box, Typography } from '@mui/material';
import type { TimeSeries } from '../../lib/edr';

const W = 600;
const H = 180;
const ML = 50;
const MT = 10;
const MB = 30;
const MR = 10;
const PW = W - ML - MR;
const PH = H - MT - MB;

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(1));

/** One series as a line chart; gaps (null) break the line. */
export function TimeseriesChart({ series }: { series: TimeSeries }) {
  const pts = series.values.map((v, i) => ({ i, v })).filter((p): p is { i: number; v: number } => p.v !== null);
  if (pts.length < 2) return null;
  let lo = Math.min(...pts.map((p) => p.v));
  let hi = Math.max(...pts.map((p) => p.v));
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const last = series.values.length - 1;
  const x = (i: number) => ML + (last === 0 ? 0 : (i / last) * PW);
  const y = (v: number) => MT + PH - ((v - lo) / (hi - lo)) * PH;

  // Break the polyline at gaps.
  const segments: string[] = [];
  let cur: string[] = [];
  series.values.forEach((v, i) => {
    if (v === null) {
      if (cur.length) segments.push(cur.join(' '));
      cur = [];
    } else cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (cur.length) segments.push(cur.join(' '));

  const yTicks = [0, 1, 2, 3, 4].map((k) => lo + ((hi - lo) * k) / 4);
  const xTicks = Array.from(new Set([0, Math.floor(last / 2), last]));
  const title = series.label + (series.unit ? ` (${series.unit})` : '');

  return (
    <Box sx={{ mb: 2 }} data-testid={`chart-${series.id}`}>
      <Typography variant="subtitle2">{title}</Typography>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Time series of ${title}`} style={{ maxWidth: W }}>
        <line x1={ML} y1={MT} x2={ML} y2={MT + PH} stroke="#9e9e9e" />
        <line x1={ML} y1={MT + PH} x2={ML + PW} y2={MT + PH} stroke="#9e9e9e" />
        {yTicks.map((t) => (
          <g key={t}>
            <line x1={ML - 3} y1={y(t)} x2={ML} y2={y(t)} stroke="#9e9e9e" />
            <text x={ML - 6} y={y(t) + 3} fontSize={9} textAnchor="end" fill="#616161">
              {fmt(t)}
            </text>
          </g>
        ))}
        {xTicks.map((i) => (
          <text key={i} x={x(i)} y={MT + PH + 16} fontSize={9} textAnchor={i === 0 ? 'start' : i === last ? 'end' : 'middle'} fill="#616161">
            {series.times[i].slice(0, 10)}
          </text>
        ))}
        {segments.map((p, k) => (
          <polyline key={k} points={p} fill="none" stroke="#1976d2" strokeWidth={2} />
        ))}
        {pts.map((p) => (
          <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={2} fill="#0d47a1" />
        ))}
      </svg>
    </Box>
  );
}

/** All chartable series of a response, or `null` when there is nothing to chart. */
export function TimeseriesCharts({ series }: { series: TimeSeries[] }) {
  if (!series.length) return null;
  return (
    <Box sx={{ mb: 1 }} data-testid="timeseries">
      {series.map((s) => (
        <TimeseriesChart key={s.id} series={s} />
      ))}
    </Box>
  );
}
