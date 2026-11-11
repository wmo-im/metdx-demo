// Sidebar "Result" panel of the EDR page: draws a fetched CoverageJSON on the map and offers the pickers,
// legend, clicked-point readout and (multi-time) series chart for it.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Alert, Box, Button, IconButton, MenuItem, Slider, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import DataObjectIcon from '@mui/icons-material/DataObject';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import { useMap, useMapEngine } from '../../shell';
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
/** Play speed: one time step every 500 ms (about 2 steps/s). */
const PLAY_INTERVAL_MS = 500;

/** Slider marks, one per step; the first and last carry the time (as `MM-DD HH:mm` for an ISO instant). */
function timeMarks(times: string[]): { value: number; label?: string }[] {
  const short = (t: string) => {
    const m = /^\d{4}-(\d{2})-(\d{2})[T ](\d{2}:\d{2})/.exec(t);
    return m ? `${m[1]}-${m[2]} ${m[3]}` : t;
  };
  return times.map((t, i) => (i === 0 || i === times.length - 1 ? { value: i, label: short(t) } : { value: i }));
}
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
  const canCoverage = useMapEngine()?.capabilities.coverageRenderer === true;
  const [renderer, setRenderer] = useState<'builtin' | 'coverage'>('builtin');
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const useCoverage = canCoverage && renderer === 'coverage';
  const [levelIndex, setLevelIndex] = useState(0);
  const parsed = useMemo(() => parse(result.data, levelIndex), [result.data, levelIndex]);
  const layer = parsed.layer;

  const [paramKey, setParamKey] = useState('');
  // The slider position (`timeIndex`) follows the pointer / keys at once; the map is told through `drawIndex`, which is
  // updated at most once per animation frame while dragging (see `goTo`).
  const [timeIndex, setTimeIndex] = useState(0);
  const [drawIndex, setDrawIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const frame = useRef<{ raf: number; pending: number | null }>({ raf: 0, pending: null });
  const [selected, setSelected] = useState<{ index: number; lonlat: [number, number] } | null>(null);

  const param = layer ? (layer.parameters.find((p) => p.key === paramKey) ?? layer.parameters[0]) : undefined;
  const nTimes = layer ? Math.max(1, layer.times.length) : 1;
  const uiTi = Math.min(timeIndex, nTimes - 1);
  const ti = Math.min(drawIndex, nTimes - 1);

  const goTo = useCallback((i: number) => {
    setTimeIndex(i);
    const f = frame.current;
    if (f.raf) {
      f.pending = i; // a redraw is already scheduled for this frame: keep only the latest position
      return;
    }
    setDrawIndex(i);
    f.raf = requestAnimationFrame(() => {
      f.raf = 0;
      if (f.pending !== null) {
        const p = f.pending;
        f.pending = null;
        setDrawIndex(p);
      }
    });
  }, []);
  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current.raf);
      frame.current = { raf: 0, pending: null };
    },
    [],
  );

  // Play: one step every PLAY_INTERVAL_MS, looping; the next step is only scheduled once the current one is shown.
  useEffect(() => {
    if (!playing || nTimes < 2) return;
    const id = setTimeout(() => goTo((uiTi + 1) % nTimes), PLAY_INTERVAL_MS);
    return () => clearTimeout(id);
  }, [playing, uiTi, nTimes, goTo]);
  useEffect(() => {
    if (nTimes < 2) setPlaying(false);
  }, [nTimes]);

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
    if (useCoverage) {
      let current = true;
      map.showCoverage?.(layer, param.key, ti).then(
        () => current && setCoverageError(null),
        (e: unknown) => {
          if (!current) return;
          setCoverageError(e instanceof Error ? e.message : String(e));
          setRenderer('builtin'); // fall back to the built-in drawing
        },
      );
      return () => {
        current = false;
      };
    }
    map.showData(layer, {
      param: param.key,
      timeIndex: ti,
      colourScale: DEFAULT_COLOUR_SCALE,
      style,
      ...(opacityChoice === null ? {} : { opacity: opacityChoice }),
    });
  }, [map, layer, param, ti, style, opacityChoice, useCoverage]);

  // When idle, precompute the contours of the two next and two previous steps (cancelled by the cleanup as soon as the
  // result, parameter, style or step changes, and by the map when the data is cleared).
  useEffect(() => {
    if (!layer || !param || useCoverage || style !== 'contours' || nTimes < 2) return;
    const near = [ti + 1, ti - 1, ti + 2, ti - 2].filter((i) => i >= 0 && i < nTimes);
    return map.prefetchData?.(layer, { param: param.key, timeIndices: near, style });
  }, [map, layer, param, ti, style, useCoverage, nTimes]);

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

  const onTimeKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Arrows / Home / End / Page keys are the slider's own; Space on the slider toggles play (on the button it clicks).
    if (e.key === ' ' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      setPlaying((p) => !p);
    }
  };

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
              <Box sx={{ px: 1 }} onKeyDown={onTimeKeyDown} data-testid="edr-time">
                <Stack direction="row" alignItems="center" spacing={0.5}>
                  <IconButton
                    size="small"
                    aria-label={playing ? 'Pause' : 'Play'}
                    data-testid="edr-time-play"
                    onClick={() => setPlaying((p) => !p)}
                  >
                    {playing ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
                  </IconButton>
                  <Typography variant="caption" color="text.secondary" data-testid="edr-time-label">
                    Time: {layer.times[uiTi]}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto !important' }} data-testid="edr-time-step">
                    Step {uiTi + 1}/{layer.times.length}
                  </Typography>
                </Stack>
                <Box sx={{ px: 2 }}>
                  <Slider
                    size="small"
                    aria-label="Time"
                    min={0}
                    max={layer.times.length - 1}
                    step={1}
                    marks={timeMarks(layer.times)}
                    value={uiTi}
                    valueLabelDisplay="off"
                    getAriaValueText={(v) => layer.times[v] ?? String(v)}
                    onChange={(_, v) => {
                      setPlaying(false);
                      goTo(v as number);
                    }}
                  />
                </Box>
              </Box>
            )}
            {canCoverage && (
              <ToggleButtonGroup
                exclusive
                size="small"
                fullWidth
                aria-label="Renderer"
                data-testid="edr-renderer-toggle"
                value={renderer}
                onChange={(_, v: 'builtin' | 'coverage' | null) => {
                  if (!v) return;
                  setCoverageError(null);
                  setRenderer(v);
                }}
              >
                <ToggleButton value="builtin">Built-in</ToggleButton>
                <ToggleButton value="coverage">leaflet-coverage</ToggleButton>
              </ToggleButtonGroup>
            )}
            {coverageError !== null && (
              <Alert severity="warning" data-testid="edr-coverage-error">
                leaflet-coverage could not render this result: {coverageError}
              </Alert>
            )}
            {canContour && !useCoverage && (
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
            {!useCoverage && (
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
            )}
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
