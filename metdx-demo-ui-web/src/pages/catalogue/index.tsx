import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link as RouterLink, useLocation, useSearchParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  CircularProgress,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { getRecordsSource } from '../../lib/config';
import { PAGE_SIZE, pageInfo, searchRecords, useServices, type SearchPage } from '../../lib/records';
import type { OgcRecord } from '../../lib/types';
import { cacheRecords, paths, useMap, type NavState } from '../../shell';

/** EDR (blue) and OGC Maps (green) badges, shown once the collections have been probed. */
export function ServiceBadges({ record }: { record: OgcRecord }) {
  const info = useServices(record);
  if (!info) return null;
  return (
    <>
      {info.edr && <Chip size="small" color="primary" label="EDR" data-testid="badge-edr" />}
      {info.maps && <Chip size="small" color="success" label="OGC Maps" data-testid="badge-maps" />}
      {info.queryTypes.length > 0 && (
        <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center', flexWrap: 'wrap', width: '100%' }} data-testid="query-types">
          <Typography variant="caption" color="text.secondary">
            EDR queries:
          </Typography>
          {info.queryTypes.map((qt) => (
            <Chip key={qt} size="small" variant="outlined" color="primary" label={qt} sx={{ height: 18, fontSize: 10 }} />
          ))}
        </Stack>
      )}
    </>
  );
}

/** Which records source the catalogue is searching. */
export function SourceChip() {
  const local = getRecordsSource() === 'local';
  return (
    <Chip
      size="small"
      variant="outlined"
      color={local ? 'secondary' : 'primary'}
      label={local ? 'local records' : 'WIS2 GDC'}
      title={local ? 'Searching the records bundled with this app' : 'Searching the live WIS2 Global Discovery Catalogue'}
      data-testid="records-source"
      sx={{ flexShrink: 0 }}
    />
  );
}

function ResultCard({ record }: { record: OgcRecord }) {
  const p = record.properties ?? {};
  const location = useLocation();
  // The record page's Back returns to this search (query and page are in the URL).
  const state: NavState = { from: `${location.pathname}${location.search}` };
  return (
    <Card variant="outlined" data-testid="result-card">
      <CardActionArea component={RouterLink} to={paths.record(record.id)} state={state}>
        <CardContent sx={{ p: 1.25, '&:last-child': { pb: 1.25 } }}>
          <Typography variant="subtitle2" noWrap title={p.title}>
            {p.title ?? 'No Title'}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="p" noWrap sx={{ m: 0 }}>
            {p.description ?? 'No description'}
          </Typography>
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, mt: 0.5 }}>
            <ServiceBadges record={record} />
          </Stack>
          <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', rowGap: 0.5, mt: 0.5 }}>
            {(p.keywords ?? []).slice(0, 5).map((k) => (
              <Chip key={k} size="small" label={k} sx={{ height: 18, fontSize: 10 }} />
            ))}
          </Stack>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

/** Catalogue search: query + offset live in the URL (`/?q=&offset=`), so Back from a record restores the page. */
export default function CataloguePage() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const offset = Math.max(0, Number(params.get('offset') ?? 0) || 0);

  const [text, setText] = useState(query);
  const [page, setPage] = useState<SearchPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const map = useMap();
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    mapRef.current.clear();
  }, []);

  useEffect(() => setText(query), [query]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    searchRecords(query, offset).then(
      (res) => {
        if (!live) return;
        cacheRecords(res.records);
        setPage(res);
        setLoading(false);
      },
      (e) => {
        if (!live) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [query, offset]);

  const go = useCallback(
    (q: string, off: number) => {
      const next = new URLSearchParams();
      if (q) next.set('q', q);
      if (off > 0) next.set('offset', String(off));
      setParams(next);
    },
    [setParams],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    go(text.trim(), 0);
  };

  const count = page?.records.length ?? 0;
  const total = page?.total ?? 0;
  const end = offset + count;

  return (
    <Box sx={{ p: 1.5 }} data-testid="page-catalogue">
      <Box component="form" onSubmit={onSubmit} role="search" sx={{ mb: 1.5 }}>
        <TextField
          fullWidth
          autoFocus
          placeholder="Search datasets..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          slotProps={{
            htmlInput: { 'aria-label': 'Search datasets' },
            input: {
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton type="submit" size="small" aria-label="Search">
                    <SearchIcon fontSize="small" />
                  </IconButton>
                </InputAdornment>
              ),
            },
          }}
        />
      </Box>

      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between', mb: 1, minHeight: 24 }}>
        <Typography variant="body2" sx={{ fontWeight: 'bold' }} data-testid="results-header">
          {page && !loading && !error
            ? page.query
              ? `Found ${total} results for '${page.query}'`
              : `Showing latest datasets (${total} available)`
            : null}
        </Typography>
        <SourceChip />
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 1 }}>
          Error loading results: {error}
        </Alert>
      )}
      {loading && <CircularProgress size={20} aria-label="Loading" />}

      {page && !loading && !error && (
        <>
          <Stack spacing={1}>
            {page.records.map((r) => (
              <ResultCard key={r.id} record={r} />
            ))}
          </Stack>
          {total > 0 && (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'center', mt: 1.5 }}>
              <Button
                startIcon={<ChevronLeftIcon />}
                disabled={offset <= 0}
                onClick={() => go(query, Math.max(0, offset - PAGE_SIZE))}
              >
                Previous
              </Button>
              <Typography variant="caption" color="text.secondary" data-testid="page-info">
                {pageInfo(offset, count, total)}
              </Typography>
              <Button endIcon={<ChevronRightIcon />} disabled={end >= total} onClick={() => go(query, offset + PAGE_SIZE)}>
                Next
              </Button>
            </Stack>
          )}
        </>
      )}
    </Box>
  );
}
