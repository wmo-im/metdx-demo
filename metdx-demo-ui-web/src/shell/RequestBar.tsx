import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import DownloadIcon from '@mui/icons-material/Download';
import SendIcon from '@mui/icons-material/Send';

/** What a fetch produced; shown by the shell's result dialog. */
export type RequestResult =
  | {
      kind: 'json';
      data: unknown;
      /** Exact response text (otherwise `data` is pretty-printed). */
      text?: string;
      filename?: string;
      /** Extra content under the JSON (e.g. a chart). */
      extra?: ReactNode;
    }
  | { kind: 'image'; src: string; filename?: string }
  | { kind: 'error'; message: string };

export type FetchHandler = (url: string) => void | Promise<void>;

/** Contract between pages and the bottom request bar. */
export interface RequestBarApi {
  url: string;
  result: RequestResult | null;
  busy: boolean;
  /** Set the request URL shown in the bar (the user may still edit it). */
  setUrl(url: string): void;
  /** Publish a result (opens the result dialog); `null` closes it. */
  setResult(result: RequestResult | null): void;
  /** Register the Fetch handler; returns an unregister function. Receives the current (possibly edited) URL. */
  onFetch(handler: FetchHandler): () => void;
  setBusy(busy: boolean): void;
  /**
   * While busy, the bar shows the elapsed time and a Cancel button that calls
   * this function. Pass `null` to remove it (done automatically when `busy` ends).
   */
  setCancel(cancel: (() => void) | null): void;
}

type Internal = RequestBarApi & {
  fetchNow: () => void;
  hasHandler: boolean;
  /** `Date.now()` when the current request started, or null when idle. */
  busySince: number | null;
  cancelNow: (() => void) | null;
};
const Ctx = createContext<Internal | null>(null);

export function RequestBarProvider({ children }: { children: ReactNode }) {
  const [url, setUrl] = useState('');
  const [result, setResult] = useState<RequestResult | null>(null);
  const [busySince, setBusySince] = useState<number | null>(null);
  const [cancel, setCancelState] = useState<{ fn: () => void } | null>(null);
  const busy = busySince !== null;
  const setBusy = useCallback((b: boolean) => {
    setBusySince((cur) => (b ? (cur ?? Date.now()) : null));
    if (!b) setCancelState(null);
  }, []);
  const setCancel = useCallback((fn: (() => void) | null) => setCancelState(fn ? { fn } : null), []);
  const [hasHandler, setHasHandler] = useState(false);
  const handler = useRef<FetchHandler | null>(null);
  const urlRef = useRef(url);
  urlRef.current = url;

  const onFetch = useCallback((h: FetchHandler) => {
    handler.current = h;
    setHasHandler(true);
    return () => {
      if (handler.current === h) {
        handler.current = null;
        setHasHandler(false);
      }
    };
  }, []);

  const fetchNow = useCallback(() => {
    const h = handler.current;
    if (!h) return;
    void (async () => h(urlRef.current))().catch((err) =>
      setResult({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  }, []);

  const value = useMemo(
    () => ({
      url,
      result,
      busy,
      setUrl,
      setResult,
      onFetch,
      setBusy,
      setCancel,
      fetchNow,
      hasHandler,
      busySince,
      cancelNow: cancel?.fn ?? null,
    }),
    [url, result, busy, onFetch, setBusy, setCancel, fetchNow, hasHandler, busySince, cancel],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRequestBar(): RequestBarApi {
  const c = useContext(Ctx);
  if (!c) throw new Error('useRequestBar must be used inside <RequestBarProvider>');
  return c;
}

function useInternal() {
  const c = useContext(Ctx);
  if (!c) throw new Error('RequestBar must be used inside <RequestBarProvider>');
  return c;
}

/** Pages that own the bar call this to wire it up. */
export function useRegisterFetch(handler: FetchHandler): void {
  const { onFetch } = useRequestBar();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => onFetch((u) => ref.current(u)), [onFetch]);
}

/** The fixed bar at the bottom: editable request URL, copy, open, Fetch. */
export function RequestBar() {
  const { url, setUrl, busy, fetchNow, hasHandler, busySince, cancelNow } = useInternal();
  const elapsed = useElapsedSeconds(busySince);
  return (
    <Box
      sx={{ display: 'flex', gap: 1, alignItems: 'center', p: 1, borderTop: 1, borderColor: 'divider', bgcolor: 'background.paper' }}
    >
      <TextField
        size="small"
        fullWidth
        label="Request URL"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && url && hasHandler && !busy) fetchNow();
        }}
        slotProps={{
          htmlInput: { 'aria-label': 'Request URL', style: { fontFamily: 'monospace', fontSize: 13 } },
          input: {
            endAdornment: (
              <InputAdornment position="end">
                <Tooltip title="Copy URL">
                  <span>
                    <IconButton size="small" disabled={!url} onClick={() => void navigator.clipboard?.writeText(url)}>
                      <ContentCopyIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
                <Tooltip title="Open in browser">
                  <span>
                    <IconButton size="small" disabled={!url} component="a" href={url || undefined} target="_blank" rel="noreferrer">
                      <OpenInNewIcon fontSize="small" />
                    </IconButton>
                  </span>
                </Tooltip>
              </InputAdornment>
            ),
          },
        }}
      />
      <Button
        variant="contained"
        onClick={fetchNow}
        disabled={!url || !hasHandler || busy}
        startIcon={busy ? <CircularProgress size={16} color="inherit" /> : <SendIcon />}
      >
        Fetch
      </Button>
      {busy && (
        <Typography variant="body2" color="text.secondary" data-testid="request-elapsed" sx={{ minWidth: 48, textAlign: 'right' }}>
          {elapsed} s
        </Typography>
      )}
      {busy && cancelNow && (
        <Button variant="outlined" color="warning" onClick={cancelNow}>
          Cancel
        </Button>
      )}
    </Box>
  );
}

/** Whole seconds since `since` (a `Date.now()` value), ticking every second; 0 when idle. */
function useElapsedSeconds(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

const MAX_JSON_CHARS = 50_000;

function download(filename: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Dialog showing the current {@link RequestResult}. */
export function ResultDialog() {
  const { result, setResult } = useRequestBar();
  const text =
    result?.kind === 'json' ? (result.text ?? JSON.stringify(result.data, null, 2)) : '';
  const truncated = text.length > MAX_JSON_CHARS;
  return (
    <Dialog open={!!result} onClose={() => setResult(null)} maxWidth="md" fullWidth aria-label="Result">
      <DialogTitle>{result?.kind === 'error' ? 'Request failed' : 'Result'}</DialogTitle>
      <DialogContent dividers>
        {result?.kind === 'error' && <Alert severity="error">{result.message}</Alert>}
        {result?.kind === 'image' && (
          <Box component="img" src={result.src} alt="Result" sx={{ maxWidth: '100%', imageRendering: 'auto' }} />
        )}
        {result?.kind === 'json' && (
          <>
            {result.extra}
            {truncated && (
              <Typography variant="caption" color="text.secondary">
                Showing the first {MAX_JSON_CHARS.toLocaleString()} of {text.length.toLocaleString()} characters; download for the full response.
              </Typography>
            )}
            <Box
              component="pre"
              data-testid="result-json"
              sx={{ m: 0, fontSize: 12, overflow: 'auto', maxHeight: '50vh' }}
            >
              {truncated ? text.slice(0, MAX_JSON_CHARS) : text}
            </Box>
          </>
        )}
      </DialogContent>
      <DialogActions>
        {result?.kind === 'json' && (
          <Button
            startIcon={<DownloadIcon />}
            onClick={() => download(result.filename ?? 'response.json', new Blob([text], { type: 'application/json' }))}
          >
            Download
          </Button>
        )}
        {result?.kind === 'image' && (
          <Button startIcon={<DownloadIcon />} component="a" href={result.src} download={result.filename ?? 'map.png'}>
            Download
          </Button>
        )}
        <Button onClick={() => setResult(null)}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
