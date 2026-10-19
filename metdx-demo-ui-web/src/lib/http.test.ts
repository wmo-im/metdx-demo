import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AbortedError,
  HttpError,
  JobFailedError,
  JobTimeoutError,
  ResponseTooLargeError,
  TimeoutError,
  asRedirect,
  fetchBlob,
  fetchJson,
  fetchWithJob,
  pollJob,
  proxyUrl,
  request,
  setFetchImpl,
  unproxyUrl,
} from './http';
import { loadConfig, resetConfig } from './config';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const redirect = (status: number, upstream: string) => json({ status, location: proxyUrl(upstream) });

const UP = 'https://edr.example.org/collections/c/position?coords=POINT(1 2)&f=json';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  setFetchImpl(null);
});

describe('proxy URLs', () => {
  it('wraps and unwraps', () => {
    const p = proxyUrl(UP);
    expect(p.startsWith('/api/proxy?url=')).toBe(true);
    expect(p).toContain(encodeURIComponent(UP));
    expect(unproxyUrl(p)).toBe(UP);
  });
  it('is idempotent and leaves plain URLs alone on unproxy', () => {
    const p = proxyUrl(UP);
    expect(proxyUrl(p)).toBe(p);
    expect(unproxyUrl(UP)).toBe(UP);
  });
  it('sends requests through the proxy unless disabled', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json({ ok: 1 }));
    setFetchImpl(f);
    await fetchJson(UP);
    expect(f.mock.calls[0][0]).toBe(proxyUrl(UP));
    await fetchJson('/local', { proxy: false });
    expect(f.mock.calls[1][0]).toBe('/local');
  });
  it('calls the upstream directly when the proxy config is false (per-call option still wins)', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => json({ ok: 1 }));
    setFetchImpl(f);
    try {
      await loadConfig(async () => json({ proxy: false }), '');
      await fetchJson(UP);
      expect(f.mock.calls[0][0]).toBe(UP);
      await fetchJson(UP, { proxy: true });
      expect(f.mock.calls[1][0]).toBe(proxyUrl(UP));
    } finally {
      resetConfig();
    }
  });
});

describe('asRedirect', () => {
  it('detects the proxy envelope only', () => {
    expect(asRedirect({ status: 303, location: '/api/proxy?url=x' })).toEqual({ status: 303, location: '/api/proxy?url=x' });
    expect(asRedirect({ status: 'running', location: 'x' })).toBeNull();
    expect(asRedirect({ status: 200, location: 'x' })).toBeNull();
    expect(asRedirect(null)).toBeNull();
  });
});

describe('redirect handling', () => {
  it('fetchJson follows a proxy-wrapped 3xx', async () => {
    const f = vi.fn(async (u: string) =>
      unproxyUrl(u) === UP ? redirect(302, 'https://edr.example.org/final') : json({ done: true }),
    );
    setFetchImpl(f);
    await expect(fetchJson(UP)).resolves.toEqual({ done: true });
    expect(f).toHaveBeenCalledTimes(2);
    expect(unproxyUrl(f.mock.calls[1][0])).toBe('https://edr.example.org/final');
  });
  it('gives up on redirect loops', async () => {
    setFetchImpl(async () => redirect(302, UP));
    await expect(fetchJson(UP)).rejects.toThrow(/Too many redirects/);
  });
  it('fetchBlob returns binary bodies untouched', async () => {
    setFetchImpl(async () => new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }));
    const blob = await fetchBlob(UP);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(4);
  });
});

describe('errors', () => {
  it('throws HttpError with status and body for non-2xx', async () => {
    setFetchImpl(async () => new Response('nope', { status: 404 }));
    await expect(request(UP)).rejects.toMatchObject({ name: 'HttpError', status: 404, body: 'nope' });
  });
  it('does not retry 4xx', async () => {
    const f = vi.fn(async () => new Response('x', { status: 400 }));
    setFetchImpl(f);
    await expect(request(UP, { retries: 3 })).rejects.toBeInstanceOf(HttpError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('timeout', () => {
  /** A 200 whose body never arrives until `signal` is aborted (or `ms` pass). */
  const stalledBody = (init: RequestInit | undefined, ms?: number, text = '{"ok":true}') =>
    new Response(
      new ReadableStream({
        start(c) {
          const t = ms === undefined ? undefined : setTimeout(() => (c.enqueue(new TextEncoder().encode(text)), c.close()), ms);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            c.error(new DOMException('Aborted', 'AbortError'));
          });
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('a body delayed beyond timeoutMs times out and is retried', async () => {
    let calls = 0;
    setFetchImpl(async (_u, init) => {
      calls++;
      return calls === 1 ? stalledBody(init) : json({ ok: true });
    });
    const retries: number[] = [];
    const p = fetchJson(UP, { timeoutMs: 1_000, retries: 1, retryDelayMs: 10, onRetry: (n) => retries.push(n) });
    await vi.advanceTimersByTimeAsync(1_000 + 10);
    await expect(p).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(retries).toEqual([2]);
  });

  it('a body that never arrives ends in TimeoutError (fetchJson, fetchBlob, fetchWithJob), even if fetch ignores the signal', async () => {
    setFetchImpl(async () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'application/json' } }));
    for (const fn of [fetchJson, fetchBlob, fetchWithJob]) {
      const p = fn(UP, { timeoutMs: 1_000 });
      const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
    }
  });

  it('a user abort during the body is reported as AbortedError', async () => {
    const ctrl = new AbortController();
    setFetchImpl(async (_u, init) => stalledBody(init));
    const p = fetchJson(UP, { signal: ctrl.signal, timeoutMs: 60_000 });
    const assertion = expect(p).rejects.toBeInstanceOf(AbortedError);
    await vi.advanceTimersByTimeAsync(10);
    ctrl.abort();
    await assertion;
  });

  it('aborts a hanging request with TimeoutError', async () => {
    setFetchImpl(
      (_u, init) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const p = request(UP, { timeoutMs: 5_000 });
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
  });
  it('a user abort is reported as AbortedError', async () => {
    const ctrl = new AbortController();
    setFetchImpl(
      (_u, init) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError')));
        }),
    );
    const p = request(UP, { signal: ctrl.signal, timeoutMs: 60_000 });
    const assertion = expect(p).rejects.toBeInstanceOf(AbortedError);
    ctrl.abort();
    await assertion;
  });
});

describe('maxBytes', () => {
  const big = () =>
    new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json', 'content-length': String(309_149_904) } });
  it('refuses a response whose Content-Length is above the limit, without retrying', async () => {
    const f = vi.fn(async () => big());
    setFetchImpl(f);
    const err: unknown = await fetchJson(UP, { maxBytes: 60 * 1024 * 1024, retries: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect((err as Error).message).toBe('Response is too large: 295 MB (limit 60 MB)');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('accepts it without a limit or under the limit', async () => {
    setFetchImpl(async () => big());
    await expect(fetchJson(UP)).resolves.toEqual({ a: 1 });
    await expect(fetchJson(UP, { maxBytes: 400 * 1024 * 1024 })).resolves.toEqual({ a: 1 });
  });

  /** A chunked body (no Content-Length) of `chunks` x `size` bytes that records how much was pulled and whether it was cancelled. */
  function chunked(chunks: number, size: number, init: ResponseInit = { status: 200, headers: { 'content-type': 'application/json' } }) {
    const state = { pulled: 0, cancelled: false };
    const res = new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          if (state.pulled >= chunks) return c.close();
          state.pulled++;
          c.enqueue(new Uint8Array(size).fill(0x20)); // spaces: would be valid-ish JSON whitespace, never parsed
        },
        cancel() {
          state.cancelled = true;
        },
      }),
      init,
    );
    expect(res.headers.get('content-length')).toBeNull();
    return { res, state };
  }

  it('refuses an oversized success body that has no Content-Length, cancelling the download', async () => {
    const { res, state } = chunked(1_000, 1024);
    const f = vi.fn(async () => res);
    setFetchImpl(f);
    const parse = vi.spyOn(JSON, 'parse');
    const err: unknown = await fetchJson(UP, { maxBytes: 10 * 1024, retries: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseTooLargeError);
    expect((err as ResponseTooLargeError).maxBytes).toBe(10 * 1024);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(50); // stopped early, not drained
    expect(parse).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1); // not retried
    parse.mockRestore();
  });

  it('applies to fetchBlob, fetchWithJob and the job polling paths', async () => {
    for (const run of [
      (o: object) => fetchBlob(UP, o),
      (o: object) => fetchWithJob(UP, o),
      (o: object) => pollJob(UP, o),
    ]) {
      const { res, state } = chunked(1_000, 1024, { status: 200, headers: { 'content-type': 'image/png' } });
      setFetchImpl(async () => res);
      await expect(run({ maxBytes: 4 * 1024 })).rejects.toBeInstanceOf(ResponseTooLargeError);
      expect(state.cancelled).toBe(true);
    }
  });

  it('a chunked body within the limit is read completely', async () => {
    const enc = new TextEncoder();
    setFetchImpl(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode('{"a":'));
              c.enqueue(enc.encode('[1,2'));
              c.enqueue(enc.encode(',3]}'));
              c.close();
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(fetchJson(UP, { maxBytes: 1024 })).resolves.toEqual({ a: [1, 2, 3] });
  });

  it('an oversized error body is truncated (64 kB), not thrown, and not downloaded in full', async () => {
    const { res, state } = chunked(10_000, 1024, { status: 500, headers: { 'content-type': 'text/plain' } });
    setFetchImpl(async () => res);
    const err: unknown = await fetchJson(UP, { maxBytes: 1024 * 1024 * 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(500);
    expect((err as HttpError).body?.length).toBeLessThanOrEqual(2000);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(70);
  });

  it('error bodies are capped even without maxBytes (request)', async () => {
    const { res, state } = chunked(10_000, 1024, { status: 404 });
    setFetchImpl(async () => res);
    await expect(request(UP)).rejects.toMatchObject({ name: 'HttpError', status: 404 });
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThanOrEqual(70);
  });
});

describe('retry', () => {
  it('retries network errors then succeeds', async () => {
    let n = 0;
    const f = vi.fn(async () => {
      if (++n < 3) throw new TypeError('Failed to fetch');
      return json({ ok: true });
    });
    setFetchImpl(f);
    const onRetry = vi.fn();
    const p = fetchJson(UP, { retries: 3, retryDelayMs: 2_000, onRetry });
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(p).resolves.toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0].slice(0, 2)).toEqual([2, 4]);
  });
  it('retries a 503 and a timeout', async () => {
    let n = 0;
    setFetchImpl((_u, init) => {
      n++;
      if (n === 1) return Promise.resolve(new Response('busy', { status: 503 }));
      if (n === 2)
        return new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))));
      return Promise.resolve(json({ ok: n }));
    });
    const p = fetchJson(UP, { retries: 2, retryDelayMs: 100, timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toEqual({ ok: 3 });
  });
  it('gives up after retries + 1 attempts and throws the last error', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    setFetchImpl(f);
    const p = request(UP, { retries: 3, retryDelayMs: 10 });
    const assertion = expect(p).rejects.toBeInstanceOf(TypeError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(f).toHaveBeenCalledTimes(4);
  });
  it('does not retry when the failed attempt already took longer than retryMaxElapsedMs', async () => {
    // A gateway that hangs for ~50 s and then drops the connection: retrying would triple the wait.
    const f = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(json({ error: 'upstream error: socket hang up' }, 502)), 50_000);
        }),
    );
    setFetchImpl(f);
    const onRetry = vi.fn();
    const p = fetchJson(UP, { retries: 2, retryDelayMs: 100, timeoutMs: 60_000, retryMaxElapsedMs: 10_000, onRetry });
    const assertion = expect(p).rejects.toMatchObject({ status: 502 });
    await vi.advanceTimersByTimeAsync(50_000);
    await assertion;
    expect(f).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
  it('still retries quick failures when retryMaxElapsedMs is set', async () => {
    let n = 0;
    const f = vi.fn(async () => (++n < 2 ? json({ error: 'x' }, 503) : json({ ok: true })));
    setFetchImpl(f);
    const p = fetchJson(UP, { retries: 2, retryDelayMs: 100, retryMaxElapsedMs: 10_000 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toEqual({ ok: true });
    expect(f).toHaveBeenCalledTimes(2);
  });
  it('does not retry by default', async () => {
    const f = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    setFetchImpl(f);
    await expect(request(UP)).rejects.toBeInstanceOf(TypeError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('job polling', () => {
  const JOB = 'https://edr.example.org/jobs/job-1';
  const RESULT = { type: 'Coverage', ranges: {} };

  function jobServer(statuses: string[]) {
    let polls = 0;
    const f = vi.fn(async (u: string) => {
      const up = unproxyUrl(u);
      if (up === UP) return redirect(303, JOB);
      if (up === JOB) {
        const status = statuses[Math.min(polls++, statuses.length - 1)];
        return json({
          status,
          message: status === 'failed' ? 'boom' : undefined,
          links: status === 'successful' ? [{ rel: 'results', href: '/jobs/job-1/results' }] : [],
        });
      }
      if (up === `${new URL(JOB).origin}/jobs/job-1/results`) return json(RESULT);
      return new Response('?', { status: 404 });
    });
    setFetchImpl(f);
    return { f, polls: () => polls };
  }

  it('303 -> poll until successful -> fetch results link', async () => {
    const { f } = jobServer(['accepted', 'running', 'successful']);
    const onPoll = vi.fn();
    const p = fetchWithJob(UP, { pollIntervalMs: 5_000, onPoll });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toEqual(RESULT);
    expect(onPoll.mock.calls.map((c) => c[1])).toEqual(['accepted', 'running', 'successful']);
    expect(f.mock.calls.map((c) => unproxyUrl(c[0]))).toEqual([
      UP,
      JOB,
      JOB,
      JOB,
      'https://edr.example.org/jobs/job-1/results',
    ]);
  });
  it('waits pollIntervalMs between polls', async () => {
    const { polls } = jobServer(['running', 'successful']);
    const p = pollJob(proxyUrl(JOB), { pollIntervalMs: 5_000 });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(polls()).toBe(2);
  });
  it('returns the job document when there is no results link', async () => {
    setFetchImpl(async () => json({ status: 'finished', value: 1 }));
    await expect(pollJob(JOB)).resolves.toEqual({ status: 'finished', value: 1 });
  });
  it('failed job -> JobFailedError', async () => {
    jobServer(['failed']);
    await expect(fetchWithJob(UP)).rejects.toBeInstanceOf(JobFailedError);
  });
  it('never finishing -> JobTimeoutError after maxPolls', async () => {
    const { polls } = jobServer(['running']);
    const p = pollJob(proxyUrl(JOB), { pollIntervalMs: 1_000, maxPolls: 3 });
    const assertion = expect(p).rejects.toBeInstanceOf(JobTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(polls()).toBe(3);
  });
  it('aborting stops polling', async () => {
    jobServer(['running']);
    const ctrl = new AbortController();
    const p = pollJob(proxyUrl(JOB), { pollIntervalMs: 5_000, signal: ctrl.signal });
    const assertion = expect(p).rejects.toBeInstanceOf(AbortedError);
    await vi.advanceTimersByTimeAsync(100);
    ctrl.abort();
    await assertion;
  });
  it('a non-303 redirect is followed once, not polled', async () => {
    setFetchImpl(async (u: string) =>
      unproxyUrl(u) === UP ? redirect(307, 'https://edr.example.org/moved') : json({ moved: true }),
    );
    await expect(fetchWithJob(UP)).resolves.toEqual({ moved: true });
  });
  it('plain JSON passes straight through', async () => {
    setFetchImpl(async () => json(RESULT));
    await expect(fetchWithJob(UP)).resolves.toEqual(RESULT);
  });
});
