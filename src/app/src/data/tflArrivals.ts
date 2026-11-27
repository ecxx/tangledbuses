// The TfL client of the arrival times (prod_design 6.2): GET /StopPoint/{naptanId}/Arrivals.
// It is a source for data/arrivals.ts. It gives an error kind in place of an exception.
//
// The request: keyless, one stop for each request, no header and no option (a CORS "simple request": no preflight).
// A station view fetches each child stop, at most FETCH_PARALLEL at the same time. The export stop key is the TfL naptanId.
import type { Core } from "./load";
import type { Arrival, ArrivalsError, ArrivalsSource, StopArrivals } from "./arrivals";
import type { StopKey } from "./types";
import { hasLiveTimes, knownArrivals, mapPredictions } from "../model/arrivals";
import { TokenBucket, rateLimitWaitMs } from "../model/arrivalsSchedule";

const ARRIVALS_URL = "https://api.tfl.gov.uk/StopPoint/"; // + naptanId + "/Arrivals"
const FETCH_PARALLEL = 2; // the requests of one view at the same time
const TTL_MS = 25_000; // a cache entry of a stop younger than this is used with no request
const CLOCK_FIX_MS = 60_000; // the device clock is corrected when it differs from the Date header by more than this (a response of the browser cache has a Date that is up to 30 s old)

// The error of a view that has more than one error: the first of this list (prod_design 6.2).
const ERROR_ORDER: ArrivalsError[] = ["rate_limited", "network", "blocked", "unavailable", "not_found"];

// The result of one stop.
type StopResult =
  | { ok: true; arrivals: Arrival[]; fetchedAt: number; ageS?: number; clockOffsetMs?: number }
  | { ok: false; error: ArrivalsError; retryAfterMs?: number };

interface Env {
  fetch: (url: string) => Promise<Response>;
  now: () => number;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaultEnv: Env = {
  fetch: (url) => fetch(url),
  now: () => Date.now(),
  random: Math.random,
  sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
};

// The TfL source. Each source has its own cache, its own cap and its own pause (the tests make a new one).
export function tflSource(d: Pick<Core, "patterns" | "stopPatterns">, env: Partial<Env> = {}): ArrivalsSource {
  const e: Env = { ...defaultEnv, ...env };
  const bucket = new TokenBucket(undefined, undefined, e.now);
  const cache = new Map<StopKey, Extract<StopResult, { ok: true }> & { at: number }>();
  const inflight = new Map<StopKey, Promise<StopResult>>();
  const notFound = new Set<StopKey>(); // HTTP 404: no new request in this session
  const waiting = new Map<StopKey, () => void>(); // the requests that wait for a token: the cancel functions
  let pausedUntil = 0; // after a 429: no request before this time (epoch ms)

  const paused = (): StopResult | null => (e.now() < pausedUntil ? { ok: false, error: "rate_limited", retryAfterMs: pausedUntil - e.now() } : null);

  // The request of one stop, after a token. It sets the pause after a 429.
  async function request(k: StopKey): Promise<StopResult> {
    let res: Response;
    try {
      res = await e.fetch(`${ARRIVALS_URL}${k}/Arrivals`);
    } catch {
      // fetch throws a TypeError for no network, a CORS failure and a challenge: the browser does not tell them apart.
      // No network is true only when the browser knows it. Online: the network blocks the request (the challenge).
      return { ok: false, error: typeof navigator !== "undefined" && navigator.onLine === false ? "network" : "blocked" };
    }
    if (res.status === 429) {
      const wait = rateLimitWaitMs(res.headers.get("Retry-After"), e.random);
      pausedUntil = e.now() + wait;
      bucket.empty();
      return { ok: false, error: "rate_limited", retryAfterMs: wait };
    }
    // A 403 is the challenge (prod_design 6.3). It has no CORS header, thus a browser usually gives a TypeError (above).
    // If the status can be read, the result is the same.
    if (res.status === 403) return { ok: false, error: "blocked" };
    if (res.status === 404) {
      notFound.add(k);
      return { ok: false, error: "not_found" };
    }
    if (!res.ok) return { ok: false, error: "unavailable" };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, error: "unavailable" };
    }
    if (!Array.isArray(body)) return { ok: false, error: "unavailable" };
    const fetchedAt = e.now();
    // The Date header gives the server time. Correct the device clock only when the error is large (prod_design 6.2).
    const date = Date.parse(res.headers.get("Date") ?? "");
    const offset = Number.isFinite(date) && Math.abs(date - fetchedAt) > CLOCK_FIX_MS ? date - fetchedAt : 0;
    const age = res.headers.get("Age");
    const ageS = age !== null && /^\d+$/.test(age.trim()) ? Number(age) : undefined;
    return { ok: true, arrivals: knownArrivals(d, mapPredictions(body, offset)), fetchedAt, ageS, clockOffsetMs: offset || undefined };
  }

  // The result of one stop: the cache, a request in flight, or a new request that waits for a token.
  function stop(k: StopKey): Promise<StopResult> {
    const c = cache.get(k);
    if (c && e.now() - c.at < TTL_MS) return Promise.resolve(c);
    if (notFound.has(k)) return Promise.resolve({ ok: false, error: "not_found" });
    const p0 = paused();
    if (p0) return Promise.resolve(p0);
    const f = inflight.get(k);
    if (f) return f;
    let cancelled = false;
    waiting.set(k, () => (cancelled = true));
    const p = (async (): Promise<StopResult> => {
      // The cap: wait for a token. A new view cancels the waiting requests of the older view (prod_design 6.2).
      while (!bucket.take()) {
        await e.sleep(bucket.waitMs());
        if (cancelled) return { ok: false, error: "unavailable" }; // the scheduler ignores the reply of an older view
        const again = paused();
        if (again) return again;
      }
      waiting.delete(k);
      if (cancelled) return { ok: false, error: "unavailable" };
      const r = await request(k);
      if (r.ok) cache.set(k, { ...r, at: e.now() });
      return r;
    })().finally(() => {
      waiting.delete(k);
      inflight.delete(k);
    });
    inflight.set(k, p);
    return p;
  }

  return async (stopIds): Promise<StopArrivals> => {
    const live = stopIds.filter(hasLiveTimes);
    if (!live.length) return { stopIds, fetchedAt: e.now(), arrivals: [], error: "not_available" };
    // A new view: the requests of the older view that wait for a token are cancelled, except the requests that this view needs.
    for (const [k, cancel] of waiting) if (!live.includes(k)) cancel();
    // At most FETCH_PARALLEL requests at the same time.
    const results: StopResult[] = new Array(live.length);
    let next = 0;
    const worker = async () => {
      while (next < live.length) {
        const i = next++;
        results[i] = await stop(live[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_PARALLEL, live.length) }, worker));

    const good = results.filter((r): r is Extract<StopResult, { ok: true }> => r.ok);
    const bad = results.filter((r): r is Extract<StopResult, { ok: false }> => !r.ok);
    // The error of the view (a station with mixed results): when at least one stop gave its arrivals, there is no
    // error, and the view shows the arrivals of these stops (a stop with no result has no row times, as a stop with no bus).
    // When no stop gave arrivals, the error is the first of ERROR_ORDER. A pause after a 429 is reported also with
    // good stops (retryAfterMs), thus the next poll waits for it.
    const retryAfterMs = Math.max(0, ...bad.map((r) => r.retryAfterMs ?? 0)) || undefined;
    if (!good.length) {
      const error = ERROR_ORDER.find((x) => bad.some((r) => r.error === x)) ?? "unavailable";
      return { stopIds, fetchedAt: e.now(), arrivals: [], error, retryAfterMs: error === "rate_limited" ? retryAfterMs : undefined };
    }
    const now = e.now();
    const ages = good.map((r) => (r.ageS === undefined ? undefined : r.ageS + (now - r.fetchedAt) / 1000));
    return {
      stopIds,
      fetchedAt: Math.min(...good.map((r) => r.fetchedAt)), // the oldest: "Updated n s ago" is true for all the stops
      arrivals: good.flatMap((r) => r.arrivals),
      ageS: ages.every((a) => a !== undefined) ? Math.min(...(ages as number[])) : undefined,
      clockOffsetMs: good.find((r) => r.clockOffsetMs)?.clockOffsetMs,
      retryAfterMs: bad.some((r) => r.error === "rate_limited") ? retryAfterMs : undefined,
    };
  };
}
