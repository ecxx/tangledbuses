// The live arrival times of the spider graph (app_design 6.8, prod_design 6.1). The panel reads them.
// They change when a station view or a stop view opens, at each poll, and when the clock ticks.
// The scheduler: when to ask the source (data/arrivals.ts). The timing rules are pure functions in
// model/arrivalsSchedule.ts (prod_design 6.1, 6.2). The cache, the cap of the requests and the pause
// after a 429 are in the TfL client (data/tflArrivals.ts).
import { effect, signal } from "@preact/signals";
import { getArrivals, type ArrivalsError, type StopArrivals } from "../data/arrivals";
import type { StopKey } from "../data/types";
import { hasLiveTimes } from "../model/arrivals";
import { DEBOUNCE_MS, RETRY_AFTER_DEFAULT_MS, VISIBLE_REFETCH_MS, backoffMs, nextPollDelay, shouldGiveUp } from "../model/arrivalsSchedule";
import { spider } from "./spider";

const TICK_MS = 10_000; // count down the shown times at this interval, between two fetches

export interface Arrivals {
  key: string; // the selected stops, joined with ","
  loading: boolean; // a fetch is in progress
  data: StopArrivals | null; // the last good result. It stays after an error, and the panel dims it.
  error: ArrivalsError | null; // the error of the last fetch
  triedAt: number; // epoch ms: the end of the last fetch, good or not. 0: no fetch ended.
  gaveUp: boolean; // the polling stopped after GIVE_UP failures in a row: only the Retry button starts it again
}

// null: the feature is off, or no station view or stop view is open.
export const arrivals = signal<Arrivals | null>(null);
export const clock = signal(Date.now());

let seq = 0; // the number of the last fetch: an older reply is ignored
let stops: StopKey[] | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let dueAt = 0; // epoch ms: when the timer fires
let held = false; // the next fetch waits for a 429 pause or a backoff: a page that shows again does not fetch before dueAt
let failures = 0; // the failures in a row that are not a 429
let gaveUp = false;
let inFlight = false; // a request of the current view is in progress

const initial = (key: string): Arrivals => ({ key, loading: false, data: null, error: null, triedAt: 0, gaveUp: false });

function schedule(ms: number): void {
  clearTimeout(timer);
  dueAt = Date.now() + ms;
  timer = setTimeout(() => void load(), ms); // a hidden page: the visibilitychange handler starts it again
}

// A fetch of the current stops, at once.
async function load(): Promise<void> {
  const s = stops;
  if (!s) return;
  if (document.hidden) return;
  clearTimeout(timer);
  held = false;
  const key = s.join(",");
  const n = ++seq;
  const cur = arrivals.peek();
  arrivals.value = { ...(cur?.key === key ? cur : initial(key)), loading: true };
  inFlight = true;
  const r = await getArrivals(s);
  if (n !== seq) return; // a newer view or fetch owns inFlight
  inFlight = false;
  const now = (clock.value = Date.now());
  const prev = arrivals.peek()!;
  if (!r.error) {
    failures = 0;
    arrivals.value = { key, loading: false, data: r, error: null, triedAt: now, gaveUp: false };
    // A pause after a 429 of one stop of a station: the next poll waits for it.
    schedule(Math.max(nextPollDelay(r.ageS, s.filter(hasLiveTimes).length), r.retryAfterMs ?? 0));
    return;
  }
  if (r.error === "rate_limited") {
    // Not a failure: no count, no backoff. The source pauses all the requests for this time.
    held = true;
    schedule(r.retryAfterMs ?? RETRY_AFTER_DEFAULT_MS);
  } else if (r.error === "not_found" || r.error === "not_available") {
    // No polling: a new view or the Retry button only.
  } else {
    failures++;
    gaveUp = shouldGiveUp(failures);
    if (!gaveUp) {
      held = true;
      schedule(backoffMs(failures));
    }
  }
  arrivals.value = { ...prev, loading: false, error: r.error, triedAt: now, gaveUp };
}

// The Retry button: starts the polling again, and resets the count of the failures.
export function refreshArrivals(): void {
  failures = 0;
  gaveUp = false;
  void load();
}

// A new view: the live bar shows at once, the request is after DEBOUNCE_MS, thus a fast sequence of views makes one request.
function open(next: StopKey[]): void {
  stops = next;
  seq++;
  inFlight = false;
  clearTimeout(timer);
  const key = next.join(",");
  if (!next.some(hasLiveTimes)) {
    // No request: the answer is known (the source gives the same).
    arrivals.value = { ...initial(key), error: "not_available", triedAt: Date.now() };
    return;
  }
  if (gaveUp) {
    // The polling stopped for the session (prod_design 6.1): a challenged IP address fails for each stop.
    arrivals.value = { ...initial(key), error: arrivals.peek()?.error ?? "unavailable", triedAt: Date.now(), gaveUp: true };
    return;
  }
  arrivals.value = { ...initial(key), loading: true };
  schedule(DEBOUNCE_MS);
}

// Start one time (main.tsx), when the feature is on.
export function startArrivals(): void {
  effect(() => {
    const s = spider.value;
    const next = s ? s.selected : null;
    if (next?.join(",") === stops?.join(",")) return; // a change of the filter: the same stops
    if (next) open(next);
    else {
      stops = null;
      seq++;
      inFlight = false;
      clearTimeout(timer);
      arrivals.value = null;
    }
  });
  // The clock of the countdown. Not while the page is hidden.
  setInterval(() => {
    if (!document.hidden) clock.value = Date.now();
  }, TICK_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      clearTimeout(timer); // no request while the page is hidden. A request in flight is not aborted.
      return;
    }
    const now = (clock.value = Date.now());
    const a = arrivals.peek();
    if (!stops || !a || inFlight || a.gaveUp || a.error === "not_found" || a.error === "not_available") return;
    if (held) return schedule(Math.max(0, dueAt - now)); // a pause or a backoff is not over
    // The data is old: fetch at once. Else the next poll at its time.
    if (!a.data || now - a.data.fetchedAt > VISIBLE_REFETCH_MS) void load();
    else schedule(Math.max(0, dueAt - now));
  });
  // The connection is back: a network error ends at once, and the count of the failures is reset.
  window.addEventListener("online", () => {
    if (stops && !document.hidden && arrivals.peek()?.error === "network") refreshArrivals();
  });
}
