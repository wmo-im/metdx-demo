// EDR query builder: position, area, trajectory, radius, cube and corridor.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import GestureIcon from '@mui/icons-material/Gesture';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useParams, useSearchParams } from 'react-router-dom';
import { COLLECTION_PARAM, DrawCancelledError, RecordLink, useMap, useRegisterFetch, useRequestBar } from '../../shell';
import { AbortedError, HttpError, ResponseTooLargeError, fetchJson, fetchWithJob } from '../../lib/http';
import {
  COMMON_LEVELS,
  DEFAULT_CORRIDOR_HEIGHT,
  DEFAULT_RADIUS_UNITS,
  DEFAULT_WIDTH_UNITS,
  DRAW_KIND,
  EDR_JOB,
  EDR_MODES,
  HEIGHT_UNITS,
  IMPLEMENTED_MODES,
  LEVEL_PARAMS,
  MODE_HELP,
  RADIUS_UNITS,
  WIDTH_UNITS,
  availableModes,
  buildEdrUrl,
  collectionBase,
  collectionJsonUrl,
  combineDatetime,
  describePoints,
  geometryToPoints,
  instanceUrl,
  instancesUrl,
  needsLevel,
  paramLabel,
  parseCollection,
  parseInstances,
  parseNumber,
  parseTemporal,
  parseTimeSeries,
  queryGeometry,
  splitIso,
  type EdrCollectionInfo,
  type EdrMode,
  type TemporalExtent,
} from '../../lib/edr';
import type { Position } from '../../lib/types';
import { TimeseriesCharts } from './TimeseriesChart';

const MAX_CHARTS = 8;

type Status = { severity: 'error' | 'info' | 'success' | 'warning'; text: string } | null;

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Larger EDR responses are refused (the datetime range / area is probably far too big). */
const MAX_RESPONSE_BYTES = 60 * 1024 * 1024;

function errorMessage(e: unknown, url?: string): string {
  if (e instanceof ResponseTooLargeError) {
    return `${e.message}. Narrow the datetime range, the area or the parameters and try again.`;
  }
  if (e instanceof HttpError) {
    let detail = '';
    try {
      const j = JSON.parse(e.body ?? '') as { description?: string; detail?: string; message?: string; error?: string };
      detail = j.description ?? j.detail ?? j.message ?? j.error ?? '';
    } catch {
      detail = e.body ?? '';
    }
    let hint = '';
    if (e.status === 502 || e.status === 504) {
      hint = ' The server did not answer (it closed the connection or timed out); it may be overloaded, or the request may be too big (long datetime range, large area). Try a shorter datetime range or a smaller area, or try again later.';
    } else if (e.status === 500 && url && /\/corridor\?/.test(url) && !/[?&]corridor-height=/.test(url) && /NoneType/.test(detail)) {
      hint = ' This server needs a corridor height: fill in "Corridor height" and its units.';
    }
    return `${e.message}${detail ? `: ${detail.slice(0, 300)}` : ''}${hint ? `.${hint}` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}

function fileNameFor(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return `edr-${last ?? 'response'}.json`;
  } catch {
    return 'edr-response.json';
  }
}

export default function EdrPage() {
  const [sp] = useSearchParams();
  const col = sp.get(COLLECTION_PARAM);
  return (
    <Box sx={{ p: 2 }} data-testid="page-edr">
      {col ? (
        <EdrBuilder key={col} collectionUrl={col} />
      ) : (
        <Alert severity="warning">No collection selected. Open a record and choose EDR.</Alert>
      )}
    </Box>
  );
}

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Box sx={{ mt: 2 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
        <Typography variant="subtitle2">{title}</Typography>
        {action}
      </Stack>
      {children}
    </Box>
  );
}

function EdrBuilder({ collectionUrl }: { collectionUrl: string }) {
  const { id: recordId } = useParams();
  const map = useMap();
  const bar = useRequestBar();

  // --- collection metadata
  const [info, setInfo] = useState<EdrCollectionInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [instances, setInstances] = useState<string[] | null>(null);

  // --- query state
  const [mode, setMode] = useState<EdrMode>('position');
  const [points, setPoints] = useState<Position[]>([]);
  const [params, setParams] = useState<string[]>([]);
  const [useInstance, setUseInstance] = useState(false);
  const [instanceId, setInstanceId] = useState('');
  const [level, setLevel] = useState('');
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');
  const [dtHint, setDtHint] = useState('');
  const [radius, setRadius] = useState('');
  const [radiusUnits, setRadiusUnits] = useState(DEFAULT_RADIUS_UNITS);
  const [corridorWidth, setCorridorWidth] = useState('');
  const [widthUnits, setWidthUnits] = useState(DEFAULT_WIDTH_UNITS);
  const [corridorHeight, setCorridorHeight] = useState(DEFAULT_CORRIDOR_HEIGHT);
  const [heightUnits, setHeightUnits] = useState(HEIGHT_UNITS[0]);
  const [drawing, setDrawing] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const modes = useMemo(() => (info ? availableModes(info.modes) : []), [info]);
  const noModes = info !== null && modes.length === 0;
  const notSupported = useMemo(() => {
    if (!info) return [];
    const unsupportedKnown = info.modes.filter((m) => !IMPLEMENTED_MODES.includes(m));
    return [...unsupportedKnown, ...info.unknownQueries];
  }, [info]);

  const effectiveInstance = useInstance && instanceId ? instanceId : null;

  const applyTemporal = useCallback((t: TemporalExtent, label: string, fallbackToday: boolean) => {
    const parts: string[] = [];
    if (t.start) parts.push(`from ${t.start.slice(0, 16)}`);
    if (t.end) parts.push(`to ${t.end.slice(0, 16)}`);
    else if (t.start) parts.push('to now');
    setDtHint(parts.length ? `${label}: ${parts.join(' ')}` : '');
    if (t.start) {
      const s = splitIso(t.start);
      setStartDate(s.date);
      setStartTime(s.time);
    } else if (fallbackToday) {
      setStartDate(new Date().toISOString().slice(0, 10));
      setStartTime('00:00');
    }
    // Default to a single time (the first available step): the whole extent can be hundreds of MB.
    // The user can still fill in an end date/time to query a range.
    setEndDate('');
    setEndTime('');
  }, []);

  // Collection document + instance list (loaded once per collection).
  useEffect(() => {
    let live = true;
    fetchJson(collectionJsonUrl(collectionUrl)).then(
      (data) => {
        if (!live) return;
        const c = parseCollection(data);
        setInfo(c);
        const avail = availableModes(c.modes);
        setMode((m) => (avail.length && !avail.includes(m) ? avail[0] : m));
        map.showExtent(c.bbox);
        applyTemporal(c.temporal, 'Available', true);
      },
      (e) => live && setInfoError(errorMessage(e)),
    );
    fetchJson(instancesUrl(collectionUrl)).then(
      (data) => {
        if (!live) return;
        const ids = parseInstances(data);
        setInstances(ids);
        if (ids.length) setInstanceId((cur) => cur || ids[0]);
      },
      () => live && setInstances([]),
    );
    return () => {
      live = false;
    };
  }, [collectionUrl, map, applyTemporal]);

  // Datetime range follows the selected instance (and goes back to the collection's range without one).
  const collectionTemporal = info?.temporal;
  const hadInstance = useRef(false);
  useEffect(() => {
    if (!effectiveInstance) {
      if (hadInstance.current) {
        hadInstance.current = false;
        if (collectionTemporal) applyTemporal(collectionTemporal, 'Available', true);
      }
      return;
    }
    hadInstance.current = true;
    let live = true;
    setDtHint('Loading forecast range...');
    fetchJson(instanceUrl(collectionUrl, effectiveInstance)).then(
      (data) => live && applyTemporal(parseTemporal(data), 'Valid range', false),
      (e) => live && setDtHint(`Could not load instance details: ${errorMessage(e)}`),
    );
    return () => {
      live = false;
    };
    // collectionTemporal is intentionally not a dependency: only instance changes re-prefill.
  }, [effectiveInstance, collectionUrl, applyTemporal]);

  // --- derived query URL
  const datetime = combineDatetime(startDate, startTime, endDate, endTime);
  const radiusValue = parseNumber(radius);
  const widthValue = parseNumber(corridorWidth);
  const heightValue = parseNumber(corridorHeight);
  const url = useMemo(
    () =>
      buildEdrUrl({
        collectionUrl,
        mode,
        points,
        params,
        datetime,
        instanceId: effectiveInstance,
        level,
        radius: radiusValue,
        radiusUnits,
        corridorWidth: widthValue,
        widthUnits,
        corridorHeight: heightValue,
        heightUnits,
      }),
    [
      collectionUrl,
      mode,
      points,
      params,
      datetime,
      effectiveInstance,
      level,
      radiusValue,
      radiusUnits,
      widthValue,
      widthUnits,
      heightValue,
      heightUnits,
    ],
  );

  const { setUrl, setResult, setBusy, setCancel } = bar;
  useEffect(() => {
    setUrl(url ?? '');
  }, [url, setUrl]);
  useEffect(() => () => setUrl(''), [setUrl]);

  // Navigating away: abort the running request (its completion is then ignored) and release the bar.
  const activeRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      const ctrl = activeRef.current;
      if (!ctrl) return;
      activeRef.current = null;
      ctrl.abort();
      setBusy(false);
    },
    [setBusy],
  );
  useEffect(() => {
    map.showGeometry(queryGeometry(mode, points));
  }, [map, mode, points]);
  useEffect(
    () => () => {
      map.clear();
    },
    [map],
  );

  // --- actions
  const resetDrawing = useCallback(() => {
    map.clear(); // also cancels a draw in progress
    map.showExtent(info?.bbox ?? null);
    setPoints([]);
  }, [map, info]);

  const chooseMode = (m: EdrMode | null) => {
    if (!m || m === mode) return;
    resetDrawing();
    setMode(m);
    setStatus(null);
  };

  const draw = async () => {
    setStatus(null);
    setDrawing(true);
    try {
      const g = await map.drawGeometry(DRAW_KIND[mode]);
      setPoints(geometryToPoints(mode, g));
    } catch (e) {
      if (!(e instanceof DrawCancelledError)) setStatus({ severity: 'error', text: errorMessage(e) });
    } finally {
      setDrawing(false);
    }
  };

  const toggleParam = (id: string) =>
    setParams((cur) => (cur.includes(id) ? cur.filter((p) => p !== id) : [...cur, id]));

  const levelParams = params.filter((p) => LEVEL_PARAMS.has(p));

  // The bar's Fetch: validate selections only when the URL is the one we built (hand-edited URLs run as typed).
  const builtUrl = useRef<string | null>(url);
  builtUrl.current = url;
  const paramsRef = useRef({ params, level });
  paramsRef.current = { params, level };
  useRegisterFetch(async (target) => {
    if (target === builtUrl.current) {
      const { params: ps, level: lv } = paramsRef.current;
      if (!ps.length) {
        setStatus({ severity: 'error', text: 'Select at least one parameter first' });
        return;
      }
      if (needsLevel(ps) && !lv) {
        setStatus({
          severity: 'error',
          text: `Select a pressure level for ${ps.filter((p) => LEVEL_PARAMS.has(p)).join(', ')} before querying`,
        });
        return;
      }
    }
    setStatus({ severity: 'info', text: 'Fetching...' });
    activeRef.current?.abort();
    const ctrl = new AbortController();
    activeRef.current = ctrl;
    // After unmount (or once a newer request replaced this one) a completion must not touch the UI.
    const current = () => activeRef.current === ctrl;
    setBusy(true);
    setCancel(() => ctrl.abort());
    try {
      // Cold-start backends can be slow: Flet tried 3 times.
      const data = await fetchWithJob(target, {
        signal: ctrl.signal,
        // The JSON is parsed and pretty-printed in the page: a few hundred MB would freeze the tab.
        maxBytes: MAX_RESPONSE_BYTES,
        timeoutMs: 60_000,
        retries: 2,
        // A slow failure (a gateway giving up after ~50 s) is not retried: it would only triple the wait.
        retryMaxElapsedMs: 10_000,
        pollIntervalMs: EDR_JOB.pollIntervalMs,
        maxPolls: EDR_JOB.maxPolls,
        onPoll: (n, st) => {
          if (current()) setStatus({ severity: 'info', text: `Waiting for job (poll ${n}${st ? `, ${st}` : ''})...` });
        },
        retryDelayMs: 2_000,
        onRetry: (attempt, max) => {
          if (current()) setStatus({ severity: 'info', text: `Retrying (${attempt}/${max})...` });
        },
      });
      if (!current()) return;
      const text = JSON.stringify(data, null, 2);
      const series = parseTimeSeries(data).slice(0, MAX_CHARTS);
      setResult({
        kind: 'json',
        data,
        text,
        filename: fileNameFor(target),
        extra: series.length ? <TimeseriesCharts series={series} /> : undefined,
      });
      setStatus({ severity: 'success', text: `Response received (${text.length.toLocaleString()} chars)` });
    } catch (e) {
      if (!current()) return;
      if (e instanceof AbortedError) {
        setStatus({ severity: 'warning', text: 'Request cancelled' });
      } else {
        setResult({ kind: 'error', message: errorMessage(e, target) });
        setStatus({ severity: 'error', text: 'Request failed' });
      }
    } finally {
      if (current()) {
        activeRef.current = null;
        setBusy(false);
      }
    }
  });

  return (
    <>
      <Stack direction="row" alignItems="center" spacing={1}>
        {recordId && <RecordLink recordId={recordId} />}
      </Stack>
      <Typography variant="h6" sx={{ mt: 1 }}>
        {info?.title ?? 'EDR query builder'}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
        {collectionBase(collectionUrl)}
      </Typography>

      {infoError && (
        <Alert severity="error" sx={{ mt: 1 }}>
          Failed to load collection: {infoError}
        </Alert>
      )}
      {!info && !infoError && (
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1 }}>
          <CircularProgress size={14} />
          <Typography variant="caption">Loading collection...</Typography>
        </Stack>
      )}

      <Section title="Query type">
        {modes.length ? (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={mode}
            onChange={(_, m: EdrMode | null) => chooseMode(m)}
            aria-label="Query type"
            sx={{ flexWrap: 'wrap' }}
          >
            {EDR_MODES.filter((m) => modes.includes(m)).map((m) => (
              <ToggleButton key={m} value={m} aria-label={m}>
                {cap(m)}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        ) : (
          info && <Alert severity="warning">No supported query types: this collection advertises none that this UI implements.</Alert>
        )}
        {notSupported.length > 0 && (
          <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5, fontStyle: 'italic' }}>
            Also advertised (not yet supported in this UI): {notSupported.join(', ')}
          </Typography>
        )}
        {!noModes && (
        <>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1, fontStyle: 'italic' }}>
          {MODE_HELP[mode]}
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center">
          <Button
            variant="outlined"
            size="small"
            startIcon={<GestureIcon />}
            onClick={() => void draw()}
            disabled={drawing || !modes.length}
          >
            {drawing ? 'Drawing… (Esc to cancel)' : `Draw ${mode}`}
          </Button>
          <Button size="small" color="error" startIcon={<DeleteOutlineIcon />} onClick={resetDrawing} disabled={!points.length && !drawing}>
            Clear
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" data-testid="edr-geometry" sx={{ display: 'block', mt: 0.5 }}>
          {describePoints(points)}
        </Typography>

        {mode === 'radius' && (
          <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="flex-start">
            <TextField
              size="small"
              label="Radius"
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
              error={radius.trim() !== '' && radiusValue == null}
              helperText={
                radiusValue != null && radiusUnits === 'degrees' ? `≈ ${(radiusValue * 111).toFixed(0)} km` : undefined
              }
              slotProps={{ htmlInput: { inputMode: 'decimal' } }}
              sx={{ flex: 1 }}
            />
            <TextField select size="small" label="Radius units" value={radiusUnits} onChange={(e) => setRadiusUnits(e.target.value)} sx={{ flex: 1 }}>
              {RADIUS_UNITS.map((u) => (
                <MenuItem key={u} value={u}>
                  {u}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        )}

        {mode === 'corridor' && (
          <>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="flex-start">
              <TextField
                size="small"
                label="Corridor width"
                value={corridorWidth}
                onChange={(e) => setCorridorWidth(e.target.value)}
                error={corridorWidth.trim() !== '' && widthValue == null}
                slotProps={{ htmlInput: { inputMode: 'decimal' } }}
                sx={{ flex: 1 }}
              />
              <TextField select size="small" label="Width units" value={widthUnits} onChange={(e) => setWidthUnits(e.target.value)} sx={{ flex: 1 }}>
                {WIDTH_UNITS.map((u) => (
                  <MenuItem key={u} value={u}>
                    {u}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="flex-start">
              <TextField
                size="small"
                label="Corridor height (optional)"
                helperText={corridorHeight.trim() === '' ? 'Some servers (e.g. DestinE operational-data) require it' : undefined}
                value={corridorHeight}
                onChange={(e) => setCorridorHeight(e.target.value)}
                error={corridorHeight.trim() !== '' && heightValue == null}
                slotProps={{ htmlInput: { inputMode: 'decimal' } }}
                sx={{ flex: 1 }}
              />
              <TextField select size="small" label="Height units" value={heightUnits} onChange={(e) => setHeightUnits(e.target.value)} sx={{ flex: 1 }}>
                {HEIGHT_UNITS.map((u) => (
                  <MenuItem key={u} value={u}>
                    {u}
                  </MenuItem>
                ))}
              </TextField>
            </Stack>
          </>
        )}
        {mode === 'radius' && radiusValue == null && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            Enter a radius to build the URL.
          </Typography>
        )}
        {mode === 'corridor' && widthValue == null && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            Enter a corridor width to build the URL.
          </Typography>
        )}
        </>
        )}
      </Section>

      {instances && instances.length > 0 && (
        <Section title="Instance">
          <FormControlLabel
            control={<Switch size="small" checked={useInstance} onChange={(e) => setUseInstance(e.target.checked)} />}
            label="Use specific instance"
          />
          {useInstance && (
            <TextField
              select
              size="small"
              fullWidth
              label="Instance (reference time)"
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
            >
              {instances.map((i) => (
                <MenuItem key={i} value={i}>
                  {i}
                </MenuItem>
              ))}
            </TextField>
          )}
        </Section>
      )}

      <Section
        title="Parameters"
        action={
          info && info.params.length > 0 ? (
            <Box>
              <Button size="small" onClick={() => setParams(info.params.map((p) => p.id))}>
                All
              </Button>
              <Button size="small" onClick={() => setParams([])}>
                None
              </Button>
            </Box>
          ) : undefined
        }
      >
        {info && info.params.length === 0 && (
          <Typography variant="caption" color="text.secondary">
            The collection lists no parameters.
          </Typography>
        )}
        <Stack direction="row" flexWrap="wrap" gap={0.5}>
          {info?.params.map((p) => {
            const on = params.includes(p.id);
            return (
              <Chip
                key={p.id}
                size="small"
                label={paramLabel(p)}
                color={on ? 'primary' : 'default'}
                variant={on ? 'filled' : 'outlined'}
                onClick={() => toggleParam(p.id)}
                aria-pressed={on}
              />
            );
          })}
        </Stack>
      </Section>

      {levelParams.length > 0 && (
        <Section title="Vertical level">
          <Typography variant="caption" color={level ? 'text.secondary' : 'warning.main'} sx={{ display: 'block', mb: 1 }}>
            {level
              ? `Querying ${levelParams.join(', ')} at ${level} hPa`
              : `⚠ ${levelParams.join(', ')} require a pressure level — select one to query them.`}
          </Typography>
          <TextField select size="small" label="Pressure level (hPa)" value={level} onChange={(e) => setLevel(e.target.value)} sx={{ minWidth: 180 }}>
            <MenuItem value="">
              <em>None</em>
            </MenuItem>
            {COMMON_LEVELS.map((l) => (
              <MenuItem key={l} value={l}>
                {l} hPa
              </MenuItem>
            ))}
          </TextField>
        </Section>
      )}

      <Section title="Datetime">
        {dtHint && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1, fontStyle: 'italic' }}>
            {dtHint}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Starts with a single time (the first available step). Fill in the end date to query a range.
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
          <TextField size="small" label="Start date" placeholder="YYYY-MM-DD" value={startDate} onChange={(e) => setStartDate(e.target.value)} sx={{ flex: 2 }} />
          <TextField size="small" label="Start time" placeholder="HH:MM" value={startTime} onChange={(e) => setStartTime(e.target.value)} sx={{ flex: 1 }} />
        </Stack>
        <Stack direction="row" spacing={1}>
          <TextField size="small" label="End date" placeholder="YYYY-MM-DD" value={endDate} onChange={(e) => setEndDate(e.target.value)} sx={{ flex: 2 }} />
          <TextField size="small" label="End time" placeholder="HH:MM" value={endTime} onChange={(e) => setEndTime(e.target.value)} sx={{ flex: 1 }} />
        </Stack>
      </Section>

      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2 }}>
        Edit the URL in the bar below if needed, then press Fetch.
      </Typography>
      {status && (
        <Alert severity={status.severity} sx={{ mt: 1 }} data-testid="edr-status">
          {status.text}
        </Alert>
      )}
    </>
  );
}
