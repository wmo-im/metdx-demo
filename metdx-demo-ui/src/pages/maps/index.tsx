import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CropSquareIcon from '@mui/icons-material/CropSquare';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import LayersClearIcon from '@mui/icons-material/LayersClear';
import { useParams, useSearchParams } from 'react-router-dom';
import { DrawCancelledError, RecordLink, useMap, useRegisterFetch, useRequestBar } from '../../shell';
import { COLLECTION_PARAM } from '../../shell/routes';
import { AbortedError, HttpError, MAPS_HTTP, fetchBlob, fetchJson } from '../../lib/http';
import type { BBox } from '../../lib/types';
import {
  DEFAULT_BBOX_TEXT,
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  LEVELS,
  LruCache,
  WORLD_BBOX,
  bboxFromGeometry,
  bboxFromUrl,
  buildMapUrl,
  collectionExtent,
  collectionJsonUrl,
  defaultDatetime,
  defaultInstance,
  filterDatetimes,
  formatBbox,
  parseBbox,
  parseSchema,
  resolveMapUrl,
  schemaUrl,
  todayAtMidnight,
  type MapSchema,
} from '../../lib/maps';

type Status = { severity: 'info' | 'success' | 'error' | 'warning'; text: string } | null;

function mapErrorMessage(e: unknown): string {
  if (e instanceof HttpError) {
    const hint =
      e.status === 502 || e.status === 504
        ? ' The map server did not answer (it closed the connection or timed out); try again later.'
        : '';
    let detail = '';
    try {
      const j = JSON.parse(e.body ?? '') as { description?: string; error?: string };
      detail = j.description ?? j.error ?? '';
    } catch {
      /* not JSON */
    }
    return `${e.message}${detail ? `: ${detail.slice(0, 300)}` : ''}${hint ? `.${hint}` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}

const EMPTY_SCHEMA: MapSchema = { instances: [], datetimes: [], parameters: [] };

/** OGC Maps: choose bbox/time/parameter/level, fetch the PNG and overlay it on the map. */
export default function MapsPage() {
  const { id } = useParams();
  const [search] = useSearchParams();
  const col = search.get(COLLECTION_PARAM) ?? '';
  const map = useMap();
  const bar = useRequestBar();

  const [mapUrl, setMapUrl] = useState('');
  const [title, setTitle] = useState('');
  const [extent, setExtent] = useState<BBox | null>(null);
  const [schema, setSchema] = useState<MapSchema>(EMPTY_SCHEMA);
  const [loadingMeta, setLoadingMeta] = useState(!!col);
  const [metaError, setMetaError] = useState('');

  const [bboxText, setBboxText] = useState(DEFAULT_BBOX_TEXT);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [instance, setInstance] = useState('');
  const [datetime, setDatetime] = useState(todayAtMidnight());
  const [parameter, setParameter] = useState('');
  const [level, setLevel] = useState('');

  const [drawing, setDrawing] = useState(false);
  const [status, setStatus] = useState<Status>({
    severity: 'info',
    text: 'Click Draw BBOX to select an area on the map, or edit BBOX manually',
  });
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

  // Rendered maps by request URL -> object URL; the one on the map is never revoked on eviction.
  const currentSrc = useRef<string | null>(null);
  const cache = useRef(
    new LruCache<string>(undefined, (_k, src) => {
      if (src !== currentSrc.current) URL.revokeObjectURL(src);
    }),
  );
  const abortRef = useRef<AbortController | null>(null);
  const lastBbox = useRef<BBox | null>(null);
  const extentRef = useRef<BBox | null>(null);
  extentRef.current = extent;

  /* ------------------------------------------------------ collection + schema */
  useEffect(() => {
    if (!col) return;
    let live = true;
    const ctrl = new AbortController();
    setLoadingMeta(true);
    setMetaError('');
    (async () => {
      let collection: Record<string, unknown> | null = null;
      try {
        collection = await fetchJson<Record<string, unknown>>(collectionJsonUrl(col), { signal: ctrl.signal });
      } catch (e) {
        if (e instanceof AbortedError) return;
        // Not fatal: fall back to {collection}/map and carry on with the schema.
      }
      if (!live) return;
      setMapUrl(resolveMapUrl(collection, col));
      setTitle(typeof collection?.title === 'string' ? collection.title : '');
      const ext = collectionExtent(collection);
      setExtent(ext);
      map.showExtent(ext);
      try {
        const parsed = parseSchema(await fetchJson(schemaUrl(col), { signal: ctrl.signal }));
        if (!live) return;
        setSchema(parsed);
        const inst = defaultInstance(parsed.instances);
        const dts = filterDatetimes(parsed.datetimes, inst);
        if (inst) setInstance(inst);
        if (dts.length) setDatetime(dts[0]);
        else if (parsed.datetimes.length) setDatetime(defaultDatetime(parsed.datetimes));
        if (parsed.parameters.length) setParameter(parsed.parameters[0]);
      } catch (e) {
        if (e instanceof AbortedError || !live) return;
        setMetaError(`Failed to load schema: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        if (live) setLoadingMeta(false);
      }
    })();
    return () => {
      live = false;
      ctrl.abort();
    };
  }, [col, map]);

  // Leave the shared map clean and free memory when the page goes away. A request still running is aborted
  // and detached (abortRef cleared), so its completion changes neither the map, the status nor the bar.
  const { setBusy } = bar;
  useEffect(() => {
    const lru = cache.current;
    return () => {
      const running = abortRef.current;
      abortRef.current = null;
      running?.abort();
      if (running) setBusy(false);
      map.clear();
      lru.values().forEach((src) => URL.revokeObjectURL(src));
      lru.clear();
    };
  }, [map, setBusy]);

  /* ------------------------------------------------------------- request URL */
  const datetimeOptions = useMemo(() => filterDatetimes(schema.datetimes, instance || undefined), [schema, instance]);

  const requestUrl = useMemo(
    () =>
      mapUrl
        ? buildMapUrl({
            mapUrl,
            bbox: bboxText,
            width,
            height,
            datetime,
            fallbackDatetime: defaultDatetime(schema.datetimes),
            parameter,
            level,
          })
        : '',
    [mapUrl, bboxText, width, height, datetime, schema.datetimes, parameter, level],
  );

  const { setUrl } = bar;
  useEffect(() => {
    setUrl(requestUrl);
  }, [requestUrl, setUrl]);
  useEffect(() => () => setUrl(''), [setUrl]);

  /* ------------------------------------------------------------------ actions */
  const onInstance = (value: string) => {
    setInstance(value);
    const dts = filterDatetimes(schema.datetimes, value);
    if (dts.length) setDatetime(dts[0]);
  };

  const drawBbox = useCallback(async () => {
    if (drawing) return;
    setDrawing(true);
    setStatus({ severity: 'warning', text: 'Drag on the map to draw the bounding box (Esc cancels)' });
    try {
      const geom = await map.drawGeometry('bbox');
      const bb = bboxFromGeometry(geom);
      setBboxText(formatBbox(bb));
      setStatus({ severity: 'success', text: 'Bounding box set — click Fetch or redraw' });
    } catch (e) {
      if (e instanceof DrawCancelledError) setStatus({ severity: 'info', text: 'Drawing cancelled' });
      else setStatus({ severity: 'error', text: `Failed: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setDrawing(false);
    }
  }, [drawing, map]);

  const clearBbox = () => {
    map.clear(); // also cancels a draw in progress
    map.showExtent(extentRef.current);
    if (currentSrc.current) {
      const bb = lastBbox.current;
      if (bb) map.setOverlay(currentSrc.current, bb, { fit: false });
    }
    setBboxText(DEFAULT_BBOX_TEXT);
    setStatus({ severity: 'info', text: 'Click Draw BBOX to select an area on the map' });
  };

  const clearOverlay = () => {
    map.setOverlay(null);
    currentSrc.current = null;
    lastBbox.current = null;
    setLoadedSrc(null);
    setStatus({ severity: 'info', text: 'Result cleared' });
  };

  const fetchMap = useCallback(
    async (url: string) => {
      const bbox = bboxFromUrl(url) ?? (url.includes('bbox=') ? null : WORLD_BBOX);
      if (!bbox) {
        setStatus({ severity: 'error', text: 'Invalid BBOX: expected minLon,minLat,maxLon,maxLat' });
        return;
      }
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      bar.setBusy(true);
      bar.setCancel(() => ctrl.abort());
      // Stale once the page unmounted or a newer request replaced this one: then leave the UI alone.
      const current = () => abortRef.current === ctrl;
      setStatus({ severity: 'info', text: 'Loading...' });
      try {
        let src = cache.current.get(url);
        const hit = src !== undefined;
        if (src === undefined) {
          const blob = await fetchBlob(url, {
            ...MAPS_HTTP,
            signal: ctrl.signal,
            onRetry: (attempt, max) => {
              if (current()) setStatus({ severity: 'info', text: `Retrying (${attempt}/${max})...` });
            },
          });
          if (!current()) return;
          if (/json|text\//i.test(blob.type)) {
            throw new Error(`Server did not return an image (${blob.type || 'unknown type'})`);
          }
          src = URL.createObjectURL(blob);
          cache.current.set(url, src);
        }
        currentSrc.current = src;
        lastBbox.current = bbox;
        map.setOverlay(src, bbox);
        setLoadedSrc(src);
        setStatus({ severity: 'success', text: hit ? 'Map rendered (from cache)' : 'Map rendered on the map' });
      } catch (e) {
        if (!current()) return;
        if (e instanceof AbortedError) {
          setStatus({ severity: 'warning', text: 'Request cancelled' });
          return;
        }
        setStatus({ severity: 'error', text: `Failed: ${mapErrorMessage(e)}` });
      } finally {
        if (current()) {
          abortRef.current = null;
          bar.setBusy(false);
        }
      }
    },
    [bar, map],
  );

  useRegisterFetch(fetchMap);

  const bboxInvalid = bboxText.trim() !== '' && !parseBbox(bboxText);

  /* --------------------------------------------------------------------- view */
  if (!col) {
    return (
      <Box sx={{ p: 2 }} data-testid="page-maps">
        <Alert severity="warning">No collection selected. Open this page from a record that offers OGC Maps.</Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 2 }} data-testid="page-maps">
      {id && <RecordLink recordId={id} />}
      <Typography variant="h6" component="h2">
        OGC Maps{title ? ` — ${title}` : ''}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
        {id ? `Record ${id}` : ''}
      </Typography>

      <Stack spacing={2} sx={{ mt: 2 }}>
        {loadingMeta && (
          <Stack direction="row" spacing={1} alignItems="center">
            <CircularProgress size={16} />
            <Typography variant="caption" color="text.secondary">
              Loading schema...
            </Typography>
          </Stack>
        )}
        {metaError && <Alert severity="error">{metaError}</Alert>}

        {schema.instances.length > 0 && (
          <TextField select size="small" label="Instance (run date)" value={instance} onChange={(e) => onInstance(e.target.value)}>
            {schema.instances.map((v) => (
              <MenuItem key={v} value={v}>
                {v}
              </MenuItem>
            ))}
          </TextField>
        )}

        {datetimeOptions.length > 0 && (
          <TextField
            select
            size="small"
            label="Forecast time"
            value={datetimeOptions.includes(datetime) ? datetime : ''}
            onChange={(e) => setDatetime(e.target.value)}
          >
            {datetimeOptions.map((v) => (
              <MenuItem key={v} value={v}>
                {v}
              </MenuItem>
            ))}
          </TextField>
        )}

        <TextField
          size="small"
          label="Datetime"
          placeholder="e.g. 2026-04-30T00:00:00Z"
          value={datetime}
          onChange={(e) => setDatetime(e.target.value)}
        />

        {schema.parameters.length > 0 && (
          <TextField select size="small" label="Parameter" value={parameter} onChange={(e) => setParameter(e.target.value)}>
            {schema.parameters.map((v) => (
              <MenuItem key={v} value={v}>
                {v}
              </MenuItem>
            ))}
          </TextField>
        )}

        <TextField select size="small" label="Level (hPa)" value={level} onChange={(e) => setLevel(e.target.value)}>
          <MenuItem value="">Surface</MenuItem>
          {LEVELS.map((v) => (
            <MenuItem key={v} value={v}>
              {v}
            </MenuItem>
          ))}
        </TextField>

        <TextField
          size="small"
          label="BBOX (minLon,minLat,maxLon,maxLat)"
          value={bboxText}
          onChange={(e) => setBboxText(e.target.value)}
          error={bboxInvalid}
          helperText={bboxInvalid ? 'Expected four numbers: minLon,minLat,maxLon,maxLat' : undefined}
        />

        <Stack direction="row" spacing={1}>
          <TextField size="small" label="Width" value={width} onChange={(e) => setWidth(e.target.value)} />
          <TextField size="small" label="Height" value={height} onChange={(e) => setHeight(e.target.value)} />
        </Stack>

        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            variant="outlined"
            color={drawing ? 'warning' : 'primary'}
            startIcon={<CropSquareIcon />}
            onClick={() => void drawBbox()}
            disabled={drawing}
          >
            {drawing ? 'Drawing...' : 'Draw BBOX'}
          </Button>
          <Tooltip title="Clear BBOX">
            <IconButton color="error" aria-label="Clear BBOX" onClick={clearBbox}>
              <DeleteOutlineIcon />
            </IconButton>
          </Tooltip>
          {loadedSrc && (
            <Tooltip title="Clear rendered map">
              <IconButton aria-label="Clear rendered map" onClick={clearOverlay}>
                <LayersClearIcon />
              </IconButton>
            </Tooltip>
          )}
        </Stack>

        {status && (
          <Alert severity={status.severity} role="status" data-testid="maps-status">
            {status.text}
          </Alert>
        )}
        <Typography variant="caption" color="text.secondary">
          The rendered PNG is overlaid on the map at the BBOX. The server can be slow: each request waits up to 120 s (use Cancel to stop earlier); quick failures are retried up to 3 times.
        </Typography>
      </Stack>
    </Box>
  );
}
