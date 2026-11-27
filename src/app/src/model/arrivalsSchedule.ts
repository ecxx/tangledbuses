// The timing rules of the live arrival times (prod_design 6.1, 6.2).
// Pure functions: no DOM, no fetch, no timer. The scheduler (state/arrivals.ts) and the TfL client
// (data/tflArrivals.ts) call them. The parameters are here, in one place.

// The scheduler.
export const DEBOUNCE_MS = 400; // the time after a view change before the request. A fast sequence of selections makes one request.
export const POLL_MIN_MS = 30_000; // the shortest time between the end of a good fetch and the next one
export const VARNISH_TTL_S = 60; // TfL keeps a response 60 s. The next poll is after VARNISH_TTL_S − Age, not before POLL_MIN_MS.
export const BIG_STATION_STOPS = 3; // a station with more fetched stops than this ...
export const BIG_STATION_POLL_MS = 60_000; // ... gets its next poll after this time
export const VISIBLE_REFETCH_MS = 25_000; // a hidden page that shows again fetches at once when the data is older than this
export const BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 300_000]; // the wait after the 1st, 2nd, ... failure (not a 429)
export const GIVE_UP = 4; // after this number of failures in a row, the polling stops until the Retry button

// The client cap (prod_design 6.2): a token bucket. TfL gives 50 requests in 60 s to an anonymous IP address.
export const RATE_TOKENS = 20; // the bucket size: the burst
export const RATE_REFILL_MS = 3_000; // one token comes back each RATE_REFILL_MS: 20 requests in 60 s

// The wait after an HTTP 429.
export const RETRY_AFTER_DEFAULT_MS = 60_000; // Retry-After is missing or not a number
export const RETRY_AFTER_MAX_MS = 120_000; // the longest wait
export const RETRY_AFTER_JITTER_MS = 2_000; // 0 to this, random, added to Retry-After: many tabs do not start at one time

// The seconds of a Retry-After header, or null when the value is missing or not a number of seconds.
// (The HTTP-date form is not used by TfL: it gives null, thus the default wait.)
export function parseRetryAfter(v: string | null | undefined): number | null {
  if (v == null || !/^\s*\d+(\.\d+)?\s*$/.test(v)) return null;
  return Number(v);
}

// The wait in ms after a 429: Retry-After + 0 to RETRY_AFTER_JITTER_MS, at most RETRY_AFTER_MAX_MS.
// No Retry-After: RETRY_AFTER_DEFAULT_MS.
export function rateLimitWaitMs(retryAfter: string | null | undefined, random: () => number = Math.random): number {
  const s = parseRetryAfter(retryAfter);
  if (s === null) return RETRY_AFTER_DEFAULT_MS;
  return Math.min(RETRY_AFTER_MAX_MS, Math.round(s * 1000 + random() * RETRY_AFTER_JITTER_MS));
}

// The time from the end of a good fetch to the next fetch, in ms.
// ageS: the Age header of the response (s), or undefined. fetchedStops: the number of stops of the view that have a request.
export function nextPollDelay(ageS: number | undefined, fetchedStops: number): number {
  if (fetchedStops > BIG_STATION_STOPS) return BIG_STATION_POLL_MS;
  if (ageS === undefined || !Number.isFinite(ageS) || ageS < 0) return POLL_MIN_MS;
  return Math.max(POLL_MIN_MS, VARNISH_TTL_S * 1000 - ageS * 1000);
}

// The wait after the n-th failure in a row (n is 1 or more). After the last value, the last value.
export const backoffMs = (n: number): number => BACKOFF_MS[Math.min(Math.max(n, 1), BACKOFF_MS.length) - 1]!;

export const shouldGiveUp = (failures: number): boolean => failures >= GIVE_UP;

// A token bucket. The clock is a parameter, for the tests.
export class TokenBucket {
  private tokens: number;
  private at: number;
  constructor(
    private readonly size = RATE_TOKENS,
    private readonly refillMs = RATE_REFILL_MS,
    private readonly clock: () => number = Date.now,
  ) {
    this.tokens = size;
    this.at = clock();
  }
  private fill(): void {
    const now = this.clock();
    this.tokens = Math.min(this.size, this.tokens + Math.max(0, now - this.at) / this.refillMs);
    this.at = now;
  }
  // Takes one token. false: no token is free.
  take(): boolean {
    this.fill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
  // The time in ms until one token is free (0: a token is free now).
  waitMs(): number {
    this.fill();
    return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * this.refillMs - 1e-6);
  }
  // After a 429: the bucket is empty.
  empty(): void {
    this.fill();
    this.tokens = 0;
  }
}
