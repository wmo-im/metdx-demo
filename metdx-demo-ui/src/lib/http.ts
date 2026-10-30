import { useProxy } from './config';

/**
 * HTTP helpers. Upstream calls go through the same-origin proxy
 * (`/api/proxy?url=<encoded>`) unless the `proxy` setting (config.json) or the
 * per-call `proxy` option is false, in which case the browser calls the
 * upstream directly and follows redirects itself (static hosting). The proxy never follows redirects itself: a
 * 3xx comes back as HTTP 200 JSON `{status, location}` where `location` is
 * already a proxy URL, so the client can follow it (or poll an EDR job).
 */

export const PROXY_PATH = '/api/proxy';

/** Defaults used for the slow OGC Maps server (as the Flet app did). */
export const MAPS_HTTP = { timeoutMs: 120_000, retries: 3, retryDelayMs: 2_000, retryMaxElapsedMs: 30_000 } as const;

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_RETRY_DELAY_MS = 1_000;
export const MAX_REDIRECTS = 5;

const JOB_OK = ['successful', 'completed', 'finished'];
const JOB_FAILED = ['failed', 'error', 'dismissed'];

/* ------------------------------------------------------------------ errors */

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body?: string;
  constructor(status: number, url: string, body?: string) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class TimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number) {
    super(`Request timed out after ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'TimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The response is bigger than the caller accepts: announced by Content-Length,
 * or (no/lying Content-Length, e.g. chunked) counted while streaming the body,
 * in which case `bytes` is what had been received when the download was dropped.
 */
export class ResponseTooLargeError extends Error {
  readonly bytes: number;
  readonly maxBytes: number;
  constructor(bytes: number, maxBytes: number) {
    super(`Response is too large: ${formatBytes(bytes)} (limit ${formatBytes(maxBytes)})`);
    this.name = 'ResponseTooLargeError';
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

function formatBytes(n: number): string {
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(0)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`;
}

export class AbortedError extends Error {
  constructor() {
    super('Request aborted');
    this.name = 'AbortedError';
  }
}

export class JobFailedError extends Error {
  readonly job: unknown;
  constructor(message: string, job?: unknown) {
    super(message);
    this.name = 'JobFailedError';
    this.job = job;
  }
}

export class JobTimeoutError extends Error {
  constructor(attempts: number) {
    super(`Job did not finish after ${attempts} polls`);
    this.name = 'JobTimeoutError';
  }
}

/* ------------------------------------------------------------ fetch switch */

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

let fetchImpl: FetchImpl | null = null;

/** Replace the fetch used by this module (mock mode, tests). `null` resets. */
export function setFetchImpl(impl: FetchImpl | null): void {
  fetchImpl = impl;
}

function doFetch(url: string, init: RequestInit): Promise<Response> {
  return (fetchImpl ?? ((u, i) => globalThis.fetch(u, i)))(url, init);
}

/* ------------------------------------------------------------- proxy URLs */

function isProxyUrl(url: string): boolean {
  return url.startsWith(`${PROXY_PATH}?`) || /^https?:\/\/[^/]+\/api\/proxy\?/.test(url);
}

/** Wrap an upstream URL as `/api/proxy?url=<encoded>`. Idempotent. */
export function proxyUrl(url: string): string {
  if (isProxyUrl(url)) return url;
  return `${PROXY_PATH}?url=${encodeURIComponent(url)}`;
}

/** Inverse of {@link proxyUrl}; returns the input if it is not a proxy URL. */
export function unproxyUrl(url: string): string {
  if (!isProxyUrl(url)) return url;
  const q = url.slice(url.indexOf('?') + 1);
  return new URLSearchParams(q).get('url') ?? url;
}

/* ----------------------------------------------------------------- options */

export interface HttpOptions {
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Extra attempts after the first one (network error, timeout, 502/503/504). */
  retries?: number;
  retryDelayMs?: number;
  /**
   * Do not retry when the failed attempt already took longer than this. A
   * server (or gateway) that hangs for a minute will hang again: retrying only
   * multiplies the wait. Default: always retry.
   */
  retryMaxElapsedMs?: number;
  /**
   * Refuse a response bigger than this many bytes ({@link ResponseTooLargeError}).
   * A `Content-Length` above the limit is refused without downloading the body;
   * otherwise the body is read as a stream with a running byte count and the
   * download is cancelled as soon as the limit is exceeded, before any decoding
   * or JSON parsing. Default: no limit.
   */
  maxBytes?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Route through the proxy (default: the `proxy` config setting, true unless configured otherwise). */
  proxy?: boolean;
  /** Called before each retry. `attempt` is the number of the attempt that is about to run (2 = first retry). */
  onRetry?: (attempt: number, maxAttempts: number, error: unknown) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryable(err: unknown): boolean {
  if (err instanceof AbortedError) return false;
  if (err instanceof TimeoutError) return true;
  if (err instanceof HttpError) return [502, 503, 504].includes(err.status);
  return err instanceof TypeError; // network failure from fetch
}

/** Error bodies are only used for a short message: never read more than this. */
export const ERROR_BODY_MAX_BYTES = 64 * 1024;

/**
 * Read a body as a stream, counting bytes. With `truncate` the body is cut at
 * `limit` bytes (the rest is not downloaded); otherwise exceeding `limit`
 * cancels the download and throws {@link ResponseTooLargeError}. Nothing is
 * decoded here, so an oversized body never reaches `TextDecoder`/`JSON.parse`.
 */
async function readChunks(
  res: Response,
  limit: number,
  signal: AbortSignal | undefined,
  truncate = false,
): Promise<Uint8Array[]> {
  const reader = res.body?.getReader();
  if (!reader) return [];
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new AbortedError();
      if (done) return chunks;
      total += value.byteLength;
      if (total > limit) {
        cancel();
        if (!truncate) throw new ResponseTooLargeError(total, limit);
        chunks.push(value.subarray(0, value.byteLength - (total - limit)));
        return chunks;
      }
      chunks.push(value);
    }
  } catch (err) {
    cancel();
    throw err;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

const decodeUtf8 = (chunks: Uint8Array[]): string => {
  const dec = new TextDecoder();
  let out = '';
  for (const c of chunks) out += dec.decode(c, { stream: true });
  return out + dec.decode();
};

/**
 * One attempt: fetch and (optionally) consume the body, all under one timeout
 * and abort signal. Throws HttpError for non-2xx.
 */
async function attempt<T>(
  url: string,
  opts: HttpOptions,
  read: (res: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onUserAbort = () => ctrl.abort();
  if (opts.signal?.aborted) {
    clearTimeout(timer);
    throw new AbortedError();
  }
  opts.signal?.addEventListener('abort', onUserAbort, { once: true });
  // Rejects when the attempt is aborted, so a body that stalls (or a fetch
  // implementation that ignores the signal) cannot outlive the timeout.
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new AbortedError());
    ctrl.signal.addEventListener('abort', onAbort, { once: true });
  });
  aborted.catch(() => undefined); // avoid unhandled rejection when nothing is racing
  const guard = <R>(p: Promise<R>): Promise<R> => Promise.race([p, aborted]);
  try {
    const target = (opts.proxy ?? useProxy()) ? proxyUrl(url) : url;
    const res = await guard(doFetch(target, { method: 'GET', headers: opts.headers, signal: ctrl.signal }));
    if (!res.ok) {
      let body: string | undefined;
      try {
        // Capped (and truncated, not thrown): only a short message is needed from an error body.
        body = decodeUtf8(await guard(readChunks(res, ERROR_BODY_MAX_BYTES, ctrl.signal, true))).slice(0, 2000);
      } catch {
        /* ignore */
      }
      if (timedOut) throw new TimeoutError(url, timeoutMs);
      throw new HttpError(res.status, url, body);
    }
    if (opts.maxBytes !== undefined) {
      const len = Number(res.headers.get('content-length'));
      if (Number.isFinite(len) && len > opts.maxBytes) {
        ctrl.abort(); // drop the body instead of downloading it
        throw new ResponseTooLargeError(len, opts.maxBytes);
      }
    }
    return await guard(read(res, ctrl.signal));
  } catch (err) {
    if (err instanceof ResponseTooLargeError) throw err;
    if (timedOut) throw new TimeoutError(url, timeoutMs);
    if (opts.signal?.aborted) throw new AbortedError();
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onUserAbort);
    if (onAbort) ctrl.signal.removeEventListener('abort', onAbort);
  }
}

/** Run `attempt` with retries; timeout, abort and retry cover `read` too. */
async function run<T>(
  url: string,
  opts: HttpOptions,
  read: (res: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const retries = Math.max(0, opts.retries ?? 0);
  const delay = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const maxAttempts = retries + 1;
  let lastErr: unknown;
  for (let n = 1; n <= maxAttempts; n++) {
    const started = Date.now();
    try {
      return await attempt(url, opts, read);
    } catch (err) {
      lastErr = err;
      if (n >= maxAttempts || !isRetryable(err)) throw err;
      if (opts.retryMaxElapsedMs !== undefined && Date.now() - started > opts.retryMaxElapsedMs) throw err;
      opts.onRetry?.(n + 1, maxAttempts, err);
      await sleep(delay, opts.signal);
    }
  }
  throw lastErr;
}

/**
 * GET with timeout + retries. Returns a successful (2xx) Response. The timeout
 * covers connecting and receiving headers only; callers that read the body
 * themselves should use {@link fetchRaw} / {@link fetchJson} / {@link fetchBlob},
 * which keep timeout, abort and retry active until the body has been read.
 */
export async function request(url: string, opts: HttpOptions = {}): Promise<Response> {
  return run(url, opts, async (res) => res);
}

/* --------------------------------------------------------- redirect (3xx) */

export interface RedirectInfo {
  status: number;
  /** A proxy URL, ready to pass back to the helpers here. */
  location: string;
}

/** Recognise the proxy's `{status: 3xx, location}` JSON envelope. */
export function asRedirect(data: unknown): RedirectInfo | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.status === 'number' && d.status >= 300 && d.status < 400 && typeof d.location === 'string') {
    return { status: d.status, location: d.location };
  }
  return null;
}

export type RawResult =
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'json'; data: unknown; text: string; contentType: string }
  | { kind: 'blob'; blob: Blob; contentType: string };

/**
 * GET without following redirects. JSON/text bodies are parsed; a proxy 3xx
 * envelope is returned as `{kind: 'redirect'}`; everything else as a Blob.
 */
export async function fetchRaw(url: string, opts: HttpOptions = {}): Promise<RawResult> {
  return run(url, opts, (res, signal) => readRaw(res, signal, opts.maxBytes ?? Infinity));
}

async function readRaw(res: Response, signal: AbortSignal, maxBytes: number): Promise<RawResult> {
  const contentType = res.headers.get('content-type') ?? '';
  const chunks = await readChunks(res, maxBytes, signal);
  if (/json|text\//i.test(contentType) || contentType === '') {
    const text = decodeUtf8(chunks);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      if (/json/i.test(contentType)) throw new Error('Response is not valid JSON');
      return { kind: 'blob', blob: new Blob([text], { type: contentType }), contentType };
    }
    const redirect = asRedirect(data);
    if (redirect) return { kind: 'redirect', ...redirect };
    return { kind: 'json', data, text, contentType };
  }
  // Via Response so the Blob is the runtime's own (what res.blob() used to return).
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  const blob = await new Response(all, { headers: contentType ? { 'content-type': contentType } : undefined }).blob();
  return { kind: 'blob', blob, contentType };
}

/** GET JSON, following (non-job) redirects up to {@link MAX_REDIRECTS}. */
export async function fetchJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  let target = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const r = await fetchRaw(target, opts);
    if (r.kind === 'redirect') {
      target = r.location;
      continue;
    }
    if (r.kind === 'json') return r.data as T;
    throw new Error(`Expected JSON but got ${r.contentType || 'unknown content'}`);
  }
  throw new Error('Too many redirects');
}

/** GET a binary body (e.g. PNG), following redirects. */
export async function fetchBlob(url: string, opts: HttpOptions = {}): Promise<Blob> {
  let target = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const r = await fetchRaw(target, opts);
    if (r.kind === 'redirect') {
      target = r.location;
      continue;
    }
    if (r.kind === 'blob') return r.blob;
    return new Blob([r.text], { type: r.contentType });
  }
  throw new Error('Too many redirects');
}

/* ------------------------------------------------------------ EDR jobs */

export interface JobOptions extends HttpOptions {
  /** Delay between polls (Flet: 5 s). */
  pollIntervalMs?: number;
  /** Max number of polls (Flet: 60). */
  maxPolls?: number;
  onPoll?: (poll: number, status: string | undefined) => void;
}

/**
 * Poll an async job until it finishes, then return its results (the target of
 * the `results` link, or the job document itself when there is none).
 */
export async function pollJob(jobUrl: string, opts: JobOptions = {}): Promise<unknown> {
  const interval = opts.pollIntervalMs ?? 5_000;
  const maxPolls = opts.maxPolls ?? 60;
  for (let poll = 1; poll <= maxPolls; poll++) {
    const r = await fetchRaw(jobUrl, opts);
    if (r.kind === 'redirect') {
      // Some servers answer the finished job with a redirect to the results.
      return fetchJson(r.location, opts);
    }
    if (r.kind !== 'json') throw new Error('Unexpected job response');
    const job = (r.data ?? {}) as { status?: string; message?: string; links?: { rel?: string; href?: string }[] };
    const status = typeof job.status === 'string' ? job.status : undefined;
    opts.onPoll?.(poll, status);
    if (status && JOB_OK.includes(status)) {
      const results = job.links?.find((l) => l.rel === 'results' && l.href);
      if (results?.href) return fetchJson(resolveAgainst(results.href, jobUrl), opts);
      return job;
    }
    if (status && JOB_FAILED.includes(status)) {
      throw new JobFailedError(`Job failed: ${job.message ?? status}`, job);
    }
    if (poll < maxPolls) await sleep(interval, opts.signal);
  }
  throw new JobTimeoutError(maxPolls);
}

/** Resolve a link found in a job document against the (proxied) job URL. */
function resolveAgainst(href: string, jobUrl: string): string {
  if (isProxyUrl(href)) return href;
  const base = unproxyUrl(jobUrl);
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/**
 * GET JSON where the server may answer 303 + job (EDR async pattern). A 303
 * starts job polling; other redirects are followed once.
 */
export async function fetchWithJob(url: string, opts: JobOptions = {}): Promise<unknown> {
  const r = await fetchRaw(url, opts);
  if (r.kind === 'json') return r.data;
  if (r.kind === 'blob') throw new Error(`Expected JSON but got ${r.contentType || 'unknown content'}`);
  if (r.status === 303) return pollJob(r.location, opts);
  return fetchJson(r.location, opts);
}
