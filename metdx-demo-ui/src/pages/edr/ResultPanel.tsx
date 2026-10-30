// Sidebar "Result" panel of the EDR page: draws a fetched CoverageJSON on the map and offers the pickers,
// legend, clicked-point readout and (multi-time) series chart for it.
import { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, MenuItem, Slider, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import DataObjectIcon from '@mui/icons-material/DataObject';
import { useMap } from '../../shell';
import { Legend } from '../../shell/Legend';
import { CovJsonError, parseCoverageJson, pointSeries, type CovJsonLayer } from '../../lib/covjson';
import { DEFAULT_COLOUR_SCALE, TooLargeToDraw, isGridSpec, type DataStyle } from '../../lib/covjsonTypes';
import { MAX_CONTOUR_POINTS, contourLevels, contourSupport } from '../../lib/contour';
import type { TimeSeries } from '../../lib/edr';
import { TimeseriesChart, TimeseriesCharts } from './TimeseriesChart';

/** A fetched EDR response, kept so the JSON stays viewable whatever happens when drawing it. */
export interface FetchedResult {
  /** Changes with every response (the panel's `key`). */
  id: number;
  data: unknown;
  text: string;
  filename: string;
}

const MAX_CHARTS = 8;
/** Query types whose MultiPoint result is shown as filled contours by default. */
const CONTOUR_MODES = ['area', 'radius', 'cube'];

type Parsed = { layer: CovJsonLayer; error?: undefined } | { layer?: undefined; error: string };

function parse(data: unknown, levelIndex: number): Parsed {
  try {
    return { layer: parseCoverageJson(data, { levelIndex }) };
  } catch (e) {
    if (e instanceof TooLargeToDraw) return { error: `${e.message}. Narrow the area, the datetime range or the parameters to draw it on the map.` };
    if (e instanceof CovJsonError) return { error: `Cannot draw this response on the map: ${e.message}` };
    return { error: `Cannot draw this response on the map: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const fmtValue = (v: number) => (Number.isNaN(v) ? 'no data' : String(Number(v.toPrecision(6))));
const fmtLonLat = ([lon, lat]: [number, number]) =>
  `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;

function seriesOf(layer: CovJsonLayer, index: number, key: string): TimeSeries | null {
  const p = layer.parameters.find((q) => q.key === key);
  if (!p || layer.times.length < 2) return null;
  const pts = pointSeries(layer, index, key);
  if (pts.filter((s) => s.value !== null).length < 2) return null;
  return { id: key, label: p.label, unit: p.unit, times: pts.map((s) => s.time), values: pts.map((s) => s.value) };
}

interface Props {
  result: FetchedResult;
  /** The query type that produced it (position shows its series chart directly). */
  mode: string;
  onViewJson(): void;
}

/**
 * Mounting draws the result; unmounting (new query, mode change, leaving the page) clears the map data.
 * Remount (via `key`) to show another response.
 */
export function ResultPanel({ result, mode, onViewJson }: Props) {
  const map = useMap();
  const [levelIndex, setLevelIndex] = useState(0);
  const parsed = useMemo(() => parse(result.data, levelIndex), [result.data, levelIndex]);
  const layer = parsed.layer;

  const [paramKey, setParamKey] = useState('');
  const [timeIndex, setTimeIndex] = useState(0);
  const [selected, setSelected] = useState<{ index: number; lonlat: [number, number] } | null>(null);

  const param = layer ? (layer.parameters.find((p) => p.key === paramKey) ?? layer.parameters[0]) : undefined;
  const nTimes = layer ? Math.max(1, layer.times.length) : 1;
  const ti = Math.min(timeIndex, nTimes - 1);

  // Scattered points (area / radius / cube) default to filled contours; position / trajectory / corridor to points.
  const support = useMemo(() => (layer && layer.kind === 'points' ? contourSupport(layer.coords as Float64Array) : null), [layer]);
  const canContour = support?.ok === true;
  const [styleChoice, setStyleChoice] = useState<DataStyle | null>(null);
  const style: DataStyle = canContour ? (styleChoice ?? (CONTOUR_MODES.includes(mode) ? 'contours' : 'points')) : 'points';

  // Opacity of the drawn data: null = the map's default for what is shown (grid 0.85, contours 0.9, points 1).
  // Once chosen it is kept when the parameter, time or style changes within this result.
  const [opacityChoice, setOpacityChoice] = useState<number | null>(null);
  const defaultOpacity = layer?.kind === 'grid' ? 0.85 : style === 'contours' ? 0.9 : 1;
  const opacity = opacityChoice ?? defaultOpacity;

  // Draw (or recolour, for the same layer; an opacity change alone only sets the layer opacity).
  useEffect(() => {
    if (!layer || !param) return;
    map.showData(layer, {
      param: param.key,
      timeIndex: ti,
      colourScale: DEFAULT_COLOUR_SCALE,
      style,
      ...(opacityChoice === null ? {} : { opacity: opacityChoice }),
    });
  }, [map, layer, param, ti, style, opacityChoice]);

  // A replaced layer (other level) invalidates a selection only if it no longer fits.
  useEffect(() => {
    if (!layer) return;
    const n = isGridSpec(layer.coords) ? layer.coords.x.length * layer.coords.y.length : layer.coords.length / 2;
    setSelected((s) => (s && s.index >= n ? null : s));
  }, [layer]);

  useEffect(() => {
    if (!layer) return;
    return map.onDataSelect((index, lonlat) => setSelected({ index, lonlat }));
  }, [map, layer]);

  // Release the map data when the panel goes away.
  useEffect(
    () => () => {
      map.clearData();
    },
    [map],
  );

  const direct = useMemo(() => {
    if (!layer || mode !== 'position') return [];
    return layer.parameters
      .map((p) => seriesOf(layer, 0, p.key))
      .filter((s): s is TimeSeries => s !== null)
      .slice(0, MAX_CHARTS);
  }, [layer, mode]);

  const selectedSeries = useMemo(
    () => (layer && param && selected && mode !== 'position' ? seriesOf(layer, selected.index, param.key) : null),
    [layer, param, selected, mode],
  );

  return (
    <Box sx={{ mt: 2 }} data-testid="edr-result">
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
        <Typography variant="subtitle2">Result</Typography>
        <Button size="small" startIcon={<DataObjectIcon />} onClick={onViewJson}>
          View JSON
        </Button>
      </Stack>

      {parsed.error !== undefined && (
        <Alert severity="warning" data-testid="edr-result-error">
          {parsed.error} The JSON can still be viewed.
        </Alert>
      )}

      {layer && param && (
        <>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            {layer.parameters.length > 1 && (
              <TextField select size="small" label="Show parameter" value={param.key} onChange={(e) => setParamKey(e.target.value)}>
                {layer.parameters.map((p) => (
                  <MenuItem key={p.key} value={p.key}>
                    {p.label === p.key ? p.key : `${p.key} (${p.label})`}
                  </MenuItem>
                ))}
              </TextField>
            )}
            {layer.levels.length > 1 && (
              <TextField select size="small" label="Level" value={layer.levelIndex} onChange={(e) => setLevelIndex(Number(e.target.value))}>
                {layer.levels.map((l, i) => (
                  <MenuItem key={i} value={i}>
                    {l}
                  </MenuItem>
                ))}
              </TextField>
            )}
            {layer.times.length > 1 && (
              <Box sx={{ px: 1 }}>
                <Typography variant="caption" color="text.secondary" data-testid="edr-time-label">
                  Time: {layer.times[ti]}
                </Typography>
                <Slider
                  size="small"
                  aria-label="Time"
                  min={0}
                  max={layer.times.length - 1}
                  step={1}
                  value={ti}
                  onChange={(_, v) => setTimeIndex(v as number)}
                />
              </Box>
            )}
            {canContour && (
              <ToggleButtonGroup
                exclusive
                size="small"
                fullWidth
                aria-label="Display style"
                data-testid="edr-style-toggle"
                value={style}
                onChange={(_, v: DataStyle | null) => v && setStyleChoice(v)}
              >
                <ToggleButton value="contours">Contours</ToggleButton>
                <ToggleButton value="points">Points</ToggleButton>
              </ToggleButtonGroup>
            )}
            <Box sx={{ px: 1 }}>
              <Typography variant="caption" color="text.secondary" data-testid="edr-opacity-label">
                Opacity: {Math.round(opacity * 100)}%
              </Typography>
              <Slider
                size="small"
                aria-label="Opacity"
                data-testid="edr-opacity"
                min={0.1}
                max={1}
                step={0.05}
                value={opacity}
                onChange={(_, v) => setOpacityChoice(Math.round((v as number) * 100) / 100)}
              />
            </Box>
            {support && !support.ok && support.reason === 'too-many' && (
              <Typography variant="caption" color="text.secondary" data-testid="edr-style-note">
                Too many points to draw contours (more than {MAX_CONTOUR_POINTS.toLocaleString('en-GB')}); showing points.
              </Typography>
            )}
          </Stack>

          <Box sx={{ mt: 1 }}>
            <Legend
              min={param.min}
              max={param.max}
              unit={param.unit}
              scale={DEFAULT_COLOUR_SCALE}
              label={param.label}
              levels={style === 'contours' ? contourLevels(param.min, param.max) : undefined}
            />
          </Box>

          {selected && (
            <Typography variant="body2" sx={{ mt: 1 }} data-testid="edr-selected">
              {fmtLonLat(selected.lonlat)}: {param.label} = {fmtValue(layer.values(param.key, ti)[selected.index])}
              {param.unit ? ` ${param.unit}` : ''}
            </Typography>
          )}
          {!selected && mode !== 'position' && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Click the map to read a value.
            </Typography>
          )}
          {selectedSeries && (
            <Box sx={{ mt: 1 }}>
              <TimeseriesChart series={selectedSeries} />
            </Box>
          )}
          {direct.length > 0 && (
            <Box sx={{ mt: 1 }}>
              <TimeseriesCharts series={direct} />
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
